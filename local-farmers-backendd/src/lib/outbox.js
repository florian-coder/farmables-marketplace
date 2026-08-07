// OPS-02 — the queue between "something happened" and "someone was told".
//
// Two rules, and everything else follows from them:
//
//   1. **Enqueueing never fails the caller.** A checkout that succeeds must
//      not turn into a 500 because Resend is down or the outbox table has not
//      been migrated yet. `enqueueEmail` swallows its own errors, loudly.
//
//   2. **Sending never happens inside the request.** The customer does not
//      wait on a third party, and a message is never sent for a transaction
//      that then rolls back.
//
// Retries use exponential backoff written into `next_attempt_at` rather than
// a sleep, so a process restart does not lose the schedule and two workers
// cannot both be holding the same row (`claim_due_emails` uses
// `for update skip locked`).

const { supabase, TABLES } = require('./supabase');
const { sendMail } = require('./mailer');
const { renderTemplate } = require('../emails/templates');

/**
 * 1 min → 5 min → 30 min → 2 h → 12 h. Five attempts spread over about
 * fifteen hours: long enough to ride out a provider incident, short enough
 * that a wrong address surfaces the same day.
 */
const BACKOFF_MINUTES = [1, 5, 30, 120, 720];

const backoffFor = (attempts) => {
  const index = Math.min(Math.max(attempts - 1, 0), BACKOFF_MINUTES.length - 1);
  return BACKOFF_MINUTES[index];
};

const isoIn = (minutes) => new Date(Date.now() + minutes * 60 * 1000).toISOString();

/**
 * Queue one message.
 *
 * `eventKey` is the idempotency claim: derive it from the *fact*, not from
 * the moment — `order-paid:<order id>`, not `order-paid:<timestamp>`. A
 * webhook redelivery then collapses into the row that is already there.
 *
 * Returns `{ queued: boolean, reason? }` and never throws.
 */
const enqueueEmail = async ({
  eventKey,
  template,
  to,
  userId = '',
  payload = {},
  delayMinutes = 0,
}) => {
  if (!eventKey || !template) {
    console.error('[outbox] Refusing to queue a message without an event key and template.');
    return { queued: false, reason: 'invalid' };
  }

  const recipient = String(to || '').trim();
  if (!recipient || !recipient.includes('@')) {
    // Not an error worth shouting about: SEC-09b legacy accounts genuinely
    // have no usable address until the owner supplies one.
    return { queued: false, reason: 'no_recipient' };
  }

  let rendered;
  try {
    rendered = renderTemplate(template, payload);
  } catch (error) {
    console.error(`[outbox] Template ${template} failed to render:`, error.message);
    return { queued: false, reason: 'render_failed' };
  }

  try {
    const { error } = await supabase.from(TABLES.emailOutbox).insert({
      event_key: String(eventKey).slice(0, 200),
      template,
      recipient,
      recipient_user_id: String(userId || ''),
      subject: rendered.subject,
      body_text: rendered.text,
      body_html: rendered.html,
      payload,
      state: 'pending',
      next_attempt_at: delayMinutes > 0 ? isoIn(delayMinutes) : new Date().toISOString(),
    });

    if (error) {
      if (error.code === '23505') {
        // Already queued for this fact. Exactly what the key is for.
        return { queued: false, reason: 'duplicate' };
      }
      console.error(`[outbox] Could not queue ${template} for ${recipient}:`, error.message);
      return { queued: false, reason: 'insert_failed' };
    }

    return { queued: true };
  } catch (error) {
    console.error(`[outbox] Could not queue ${template}:`, error?.message || error);
    return { queued: false, reason: 'exception' };
  }
};

/**
 * Fire-and-forget wrapper for use inside a request handler.
 *
 * The point is the `.catch`: an unhandled rejection from a notification would
 * take down the process in Node 18+, and no notification is worth that.
 */
const notify = (options) => {
  enqueueEmail(options).catch((error) => {
    console.error('[outbox] Notification failed to queue:', error?.message || error);
  });
};

const markSent = async (id) => {
  await supabase
    .from(TABLES.emailOutbox)
    .update({ state: 'sent', sent_at: new Date().toISOString(), last_error: null })
    .eq('id', String(id));
};

const markRetry = async (row, detail) => {
  const attempts = Number(row.attempts || 0);
  const maxAttempts = Number(row.max_attempts || 5);

  if (attempts >= maxAttempts) {
    // Out of attempts. `failed` is a resting state a human queries for; we do
    // not delete it, because the fact that someone was never told is exactly
    // the thing worth knowing.
    await supabase
      .from(TABLES.emailOutbox)
      .update({ state: 'failed', last_error: String(detail || '').slice(0, 500) })
      .eq('id', String(row.id));
    console.error(
      `[outbox] Giving up on ${row.template} to ${row.recipient} after ${attempts} attempts: ${detail}`,
    );
    return;
  }

  await supabase
    .from(TABLES.emailOutbox)
    .update({
      state: 'pending',
      last_error: String(detail || '').slice(0, 500),
      next_attempt_at: isoIn(backoffFor(attempts)),
    })
    .eq('id', String(row.id));
};

/**
 * Send whatever is due.
 *
 * Called on a timer from `server.js` and safe to call from anywhere else —
 * two concurrent runs cannot pick up the same row.
 */
const processOutbox = async ({ limit = 20 } = {}) => {
  const summary = { claimed: 0, sent: 0, retried: 0 };

  const { data: rows, error } = await supabase.rpc('claim_due_emails', { p_limit: limit });
  if (error) {
    console.error('[outbox] Could not claim due emails:', error.message);
    return summary;
  }

  const due = Array.isArray(rows) ? rows : [];
  summary.claimed = due.length;

  for (const row of due) {
    try {
      const result = await sendMail({
        to: row.recipient,
        subject: row.subject,
        text: row.body_text,
        html: row.body_html,
      });

      if (result.delivered) {
        await markSent(row.id);
        summary.sent += 1;
      } else if (result.reason === 'not_configured') {
        // No provider key. The message was printed to the console by the
        // mailer; treating it as sent keeps a dev machine from accumulating a
        // queue that will never drain.
        await markSent(row.id);
        summary.sent += 1;
      } else {
        await markRetry(row, result.reason || 'provider_error');
        summary.retried += 1;
      }
    } catch (sendError) {
      await markRetry(row, sendError?.message || 'exception');
      summary.retried += 1;
    }
  }

  return summary;
};

/** Poll loop, started by `server.js`. Returns a stop function. */
const startOutboxWorker = ({ intervalMs = 30000 } = {}) => {
  let running = false;

  const tick = async () => {
    if (running) {
      return;
    }
    running = true;
    try {
      await processOutbox({});
    } catch (error) {
      console.error('[outbox] Worker tick failed:', error?.message || error);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, intervalMs);
  // Do not hold the process open just to poll an empty queue.
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
  tick().catch(() => {});

  return () => clearInterval(timer);
};

module.exports = {
  BACKOFF_MINUTES,
  backoffFor,
  enqueueEmail,
  notify,
  processOutbox,
  startOutboxWorker,
};
