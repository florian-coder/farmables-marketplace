// OPS-02 — the outbox.
//
// The properties that matter are not "an email was sent". They are: the
// caller is never made to fail, the same fact never produces two emails, and
// a provider outage retries with growing gaps instead of giving up or
// hammering.

const path = require('path');

const { createFakeSupabase } = require('./helpers/fakeSupabase');

const BACKEND_ROOT = path.join(__dirname, '..');

/**
 * Load `outbox.js` against an in-memory database and a controllable mailer.
 * Fresh modules each time, so the mailer spy does not leak between tests.
 */
const loadOutbox = ({ seed = {}, sendResult = { delivered: true }, rpc = {} } = {}) => {
  jest.resetModules();
  const fake = createFakeSupabase(seed, { rpc });
  const sent = [];

  jest.doMock(path.join(BACKEND_ROOT, 'src/lib/supabase.js'), () => {
    const actual = jest.requireActual(path.join(BACKEND_ROOT, 'src/lib/supabase.js'));
    return { ...actual, supabase: fake };
  });

  jest.doMock(path.join(BACKEND_ROOT, 'src/lib/mailer.js'), () => ({
    sendMail: async (message) => {
      sent.push(message);
      return typeof sendResult === 'function' ? sendResult(message, sent.length) : sendResult;
    },
  }));

  // eslint-disable-next-line global-require
  const outbox = require(path.join(BACKEND_ROOT, 'src/lib/outbox.js'));
  return { outbox, fake, sent };
};

/** `claim_due_emails` in JS: what is due, marked `sending`, oldest first. */
const claimDueEmails = (args, db) => {
  const now = Date.now();
  const rows = (db.email_outbox || [])
    .filter((row) => row.state === 'pending' && Date.parse(row.next_attempt_at) <= now)
    .sort((a, b) => Date.parse(a.next_attempt_at) - Date.parse(b.next_attempt_at))
    .slice(0, args.p_limit || 20);

  for (const row of rows) {
    row.state = 'sending';
    row.attempts = Number(row.attempts || 0) + 1;
  }
  return rows.map((row) => ({ ...row }));
};

describe('OPS-02 — queueing', () => {
  test('renders both a text and an HTML body', async () => {
    const { outbox, fake } = loadOutbox();

    const result = await outbox.enqueueEmail({
      eventKey: 'order-new:abc',
      template: 'order.new.farmer',
      to: 'farm@example.com',
      payload: { orderId: 'abc123456', farmName: 'Gradina', totalBani: 11500, deliveryFeeBani: 1500, items: [] },
    });

    expect(result.queued).toBe(true);
    const row = fake._db.email_outbox[0];
    expect(row.state).toBe('pending');
    expect(row.subject).toContain('New order');
    // Plain text is not a courtesy: some clients show it by default, and a
    // durable-medium record that only exists as HTML is a weaker record.
    expect(row.body_text).toContain('Gradina');
    expect(row.body_html).toContain('<table');
  });

  test('the same fact twice queues one message', async () => {
    const { outbox, fake } = loadOutbox();
    const message = {
      eventKey: 'checkout-confirmed:chk-1',
      template: 'order.state.customer',
      to: 'ana@example.com',
      payload: { orderId: 'ord-1', farmName: 'Gradina', state: 'in_transit' },
    };

    expect((await outbox.enqueueEmail(message)).queued).toBe(true);
    // A Stripe redelivery, or the success redirect racing the webhook.
    expect((await outbox.enqueueEmail(message)).reason).toBe('duplicate');

    expect(fake._db.email_outbox).toHaveLength(1);
  });

  test('a broken template is refused without throwing at the caller', async () => {
    const { outbox, fake } = loadOutbox();

    const result = await outbox.enqueueEmail({
      eventKey: 'x:1',
      template: 'template.that.does.not.exist',
      to: 'someone@example.com',
    });

    expect(result.queued).toBe(false);
    expect(result.reason).toBe('render_failed');
    expect(fake._db.email_outbox || []).toHaveLength(0);
  });

  test('an address we cannot reach is skipped quietly, not queued forever', async () => {
    const { outbox } = loadOutbox();

    expect((await outbox.enqueueEmail({ eventKey: 'a:1', template: 'farm.approved', to: '' })).reason).toBe(
      'no_recipient',
    );
    expect(
      (await outbox.enqueueEmail({ eventKey: 'a:2', template: 'farm.approved', to: 'not-an-address' })).reason,
    ).toBe('no_recipient');
  });

  test('a database failure never reaches the caller', async () => {
    // The whole point: a checkout that succeeded must not become a 500
    // because the outbox table has not been migrated yet.
    const { outbox } = loadOutbox();
    const broken = {
      eventKey: 'a:1',
      template: 'farm.approved',
      to: 'x@example.com',
      payload: { farmName: 'Gradina' },
    };

    jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(outbox.enqueueEmail(broken)).resolves.toBeDefined();
    // And the fire-and-forget wrapper does not produce an unhandled rejection.
    expect(() => outbox.notify(broken)).not.toThrow();
  });
});

describe('OPS-02 — sending', () => {
  const queued = (overrides = {}) => ({
    id: 'mail-1',
    event_key: 'order-new:1',
    template: 'order.new.farmer',
    recipient: 'farm@example.com',
    subject: 'New order',
    body_text: 'text',
    body_html: '<p>html</p>',
    state: 'pending',
    attempts: 0,
    max_attempts: 5,
    next_attempt_at: new Date(Date.now() - 1000).toISOString(),
    ...overrides,
  });

  test('sends what is due and marks it sent', async () => {
    const { outbox, fake, sent } = loadOutbox({
      seed: { email_outbox: [queued()] },
      rpc: { claim_due_emails: claimDueEmails },
    });

    const summary = await outbox.processOutbox({});

    expect(summary.sent).toBe(1);
    expect(sent[0].to).toBe('farm@example.com');
    expect(sent[0].html).toBe('<p>html</p>');
    expect(fake._db.email_outbox[0].state).toBe('sent');
    expect(fake._db.email_outbox[0].sent_at).toBeTruthy();
  });

  test('leaves anything not yet due alone', async () => {
    const { outbox, sent } = loadOutbox({
      seed: {
        email_outbox: [queued({ next_attempt_at: new Date(Date.now() + 60000).toISOString() })],
      },
      rpc: { claim_due_emails: claimDueEmails },
    });

    const summary = await outbox.processOutbox({});
    expect(summary.claimed).toBe(0);
    expect(sent).toHaveLength(0);
  });

  test('a provider failure reschedules with a growing gap', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const { outbox, fake } = loadOutbox({
      seed: { email_outbox: [queued()] },
      sendResult: { delivered: false, reason: 'provider_error' },
      rpc: { claim_due_emails: claimDueEmails },
    });

    const before = Date.now();
    const summary = await outbox.processOutbox({});

    expect(summary.retried).toBe(1);
    const row = fake._db.email_outbox[0];
    expect(row.state).toBe('pending');
    expect(row.attempts).toBe(1);
    expect(row.last_error).toBe('provider_error');
    // First retry is a minute out, not immediately.
    expect(Date.parse(row.next_attempt_at)).toBeGreaterThan(before + 30 * 1000);
  });

  test('the backoff grows and then stops growing', () => {
    const { outbox } = loadOutbox();
    // 1 min → 5 → 30 → 2 h → 12 h, then flat.
    expect(outbox.backoffFor(1)).toBe(1);
    expect(outbox.backoffFor(2)).toBe(5);
    expect(outbox.backoffFor(3)).toBe(30);
    expect(outbox.backoffFor(4)).toBe(120);
    expect(outbox.backoffFor(5)).toBe(720);
    expect(outbox.backoffFor(99)).toBe(720);
  });

  test('gives up after the last attempt, and keeps the row as evidence', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const { outbox, fake } = loadOutbox({
      seed: { email_outbox: [queued({ attempts: 4, max_attempts: 5 })] },
      sendResult: { delivered: false, reason: 'provider_error' },
      rpc: { claim_due_emails: claimDueEmails },
    });

    await outbox.processOutbox({});

    const row = fake._db.email_outbox[0];
    // The fact that someone was never told is exactly what is worth keeping.
    expect(row.state).toBe('failed');
    expect(row.last_error).toBe('provider_error');
  });

  test('an unconfigured provider drains the queue instead of filling it', async () => {
    // On a dev machine with no Resend key the mailer prints to the console.
    // Retrying that forever would build a queue nobody will ever drain.
    const { outbox, fake } = loadOutbox({
      seed: { email_outbox: [queued()] },
      sendResult: { delivered: false, reason: 'not_configured' },
      rpc: { claim_due_emails: claimDueEmails },
    });

    const summary = await outbox.processOutbox({});
    expect(summary.sent).toBe(1);
    expect(fake._db.email_outbox[0].state).toBe('sent');
  });

  test('a mailer that throws is a retry, not a crash', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const { outbox, fake } = loadOutbox({
      seed: { email_outbox: [queued()] },
      sendResult: () => {
        throw new Error('socket hang up');
      },
      rpc: { claim_due_emails: claimDueEmails },
    });

    const summary = await outbox.processOutbox({});
    expect(summary.retried).toBe(1);
    expect(fake._db.email_outbox[0].last_error).toBe('socket hang up');
  });
});
