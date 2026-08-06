const express = require('express');

const { supabase, TABLES } = require('../lib/supabase');
const { stripe } = require('../lib/stripeClient');
const { STRIPE_WEBHOOK_SECRET } = require('../lib/config');
const { ACTIONS, recordAudit } = require('../lib/audit');
const { syncAccountToFarmer } = require('../lib/connect');
const { transferCheckoutGroups } = require('../lib/transfers');

const router = express.Router();

/**
 * SEC-06 — Idempotency.
 *
 * Stripe redelivers an event until it gets a 2xx. Without a record of what we
 * already processed, a redelivery would mark the same payment twice — and now
 * that payment triggers transfers, twice would mean paying a farmer twice.
 * The insert is the decision: the primary key on id makes the second attempt
 * fail with 23505, and we return without reprocessing.
 */
const claimEvent = async (event) => {
  const { error } = await supabase.from(TABLES.stripeEvents).insert({
    id: String(event.id),
    type: String(event.type || ''),
  });

  if (!error) {
    return true;
  }
  if (error.code === '23505') {
    return false;
  }
  // We cannot guarantee uniqueness, so we do not process: an unrecorded
  // payment plus a redelivery beats double processing.
  throw new Error(error.message || 'Unable to record Stripe event.');
};

/** The checkout id travels on both the session and the payment intent. */
const checkoutIdFrom = (object) =>
  String(object?.metadata?.checkout_id || object?.client_reference_id || '').trim();

/**
 * Payment confirmed: flip the checkout and all its farmer groups to paid,
 * then push each farmer their share.
 *
 * `mark_checkout_paid` is idempotent and reports whether this call was the
 * one that changed the state, so the two events that can both signal success
 * (`checkout.session.completed` and `payment_intent.succeeded`) do the work
 * exactly once between them.
 */
const handlePaymentSucceeded = async ({ checkoutId, paymentIntentId, eventId }) => {
  if (!checkoutId) {
    console.warn('[webhook] Payment event without a checkout id — ignored.');
    return;
  }

  const { data: applied, error } = await supabase.rpc('mark_checkout_paid', {
    p_checkout_id: checkoutId,
    p_payment_intent_id: paymentIntentId || null,
  });

  if (error) {
    // Throwing gives Stripe a non-2xx and earns a redelivery, which is what
    // we want: the payment is real and the order must eventually reflect it.
    throw new Error(`mark_checkout_paid failed for ${checkoutId}: ${error.message}`);
  }

  if (applied?.newly_paid) {
    await recordAudit({
      actorType: 'system',
      actorId: 'stripe',
      action: ACTIONS.ORDER_PAID,
      entityType: 'checkout',
      entityId: checkoutId,
      newValue: `paid:${applied.total_bani || 0}`,
    });
  }

  // Transfers run on every delivery of the event, not only the first: if the
  // first delivery marked the checkout paid and then crashed before paying
  // the farmers, the redelivery has to finish the job. `order_transfers`
  // makes the repeat harmless.
  const summary = await transferCheckoutGroups({ checkoutId, eventId });

  if (summary.failed > 0) {
    console.error(
      `[webhook] Checkout ${checkoutId}: ${summary.failed} of ${summary.attempted} transfers failed. ` +
        'Farmers are unpaid — check order_transfers.last_error.',
    );
  }
};

router.post('/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[webhook] Signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    const isNew = await claimEvent(event);
    if (!isNew) {
      return res.json({ received: true, duplicate: true });
    }
  } catch (claimError) {
    console.error('[webhook] Unable to claim event:', claimError.message);
    return res.status(500).json({ error: 'Unable to record event.' });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        if (session.payment_status !== 'paid') {
          break;
        }
        await handlePaymentSucceeded({
          checkoutId: checkoutIdFrom(session),
          paymentIntentId:
            typeof session.payment_intent === 'string' ? session.payment_intent : null,
          eventId: event.id,
        });
        break;
      }

      case 'payment_intent.succeeded': {
        const intent = event.data.object;
        await handlePaymentSucceeded({
          checkoutId: checkoutIdFrom(intent),
          paymentIntentId: intent.id,
          eventId: event.id,
        });
        break;
      }

      case 'payment_intent.payment_failed': {
        const intent = event.data.object;
        const checkoutId = checkoutIdFrom(intent);
        if (checkoutId) {
          // Stock goes back immediately. Waiting for the session to expire
          // would keep other customers locked out for half an hour.
          await supabase.rpc('rollback_checkout', { p_checkout_id: checkoutId });
          console.log(`[webhook] Checkout ${checkoutId} rolled back after failed payment.`);
        }
        break;
      }

      case 'checkout.session.expired': {
        const session = event.data.object;
        const checkoutId = checkoutIdFrom(session);
        if (checkoutId) {
          await supabase.rpc('rollback_checkout', { p_checkout_id: checkoutId });
          console.log(`[webhook] Checkout ${checkoutId} rolled back after session expiry.`);
        }
        break;
      }

      case 'account.updated': {
        // The farmer finished (or broke) onboarding. This is what flips
        // `charges_enabled`, and with it whether their products are buyable.
        const account = event.data.object;
        const result = await syncAccountToFarmer(account);
        if (result) {
          await recordAudit({
            actorType: 'system',
            actorId: 'stripe',
            action: ACTIONS.CONNECT_ACCOUNT_UPDATED,
            entityType: 'stripe_account',
            entityId: result.accountId,
            newValue: `charges_enabled=${result.chargesEnabled}`,
          });
        }
        break;
      }

      case 'transfer.created':
      case 'transfer.reversed': {
        // Recorded for reconciliation; the authoritative write already
        // happened in lib/transfers.js when we made the call.
        console.log(`[webhook] ${event.type}: ${event.data.object?.id}`);
        break;
      }

      default:
        console.log(`[webhook] Unhandled event type ${event.type}`);
    }
  } catch (error) {
    console.error(`[webhook] Error processing ${event.type} (${event.id}):`, error);
    // Release the claim so Stripe's redelivery is allowed to try again —
    // otherwise the event is marked processed while nothing happened.
    await supabase.from(TABLES.stripeEvents).delete().eq('id', String(event.id));
    return res.status(500).json({ error: 'Event processing failed.' });
  }

  return res.json({ received: true });
});

module.exports = router;
