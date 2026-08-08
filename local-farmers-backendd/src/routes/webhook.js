const express = require('express');

const { supabase, TABLES } = require('../lib/supabase');
const { stripe } = require('../lib/stripeClient');
const { STRIPE_WEBHOOK_SECRET } = require('../lib/config');
const { ACTIONS, recordAudit } = require('../lib/audit');
const { syncAccountToFarmer } = require('../lib/connect');
const { holdCheckoutGroups } = require('../lib/transfers');
const {
  notifyCustomerOrderConfirmed,
  notifyFarmerNewOrder,
  notifyConnectIncomplete,
} = require('../lib/notifications');

const router = express.Router();

/**
 * SEC-06 — Idempotency.
 *
 * Stripe redelivers an event until it gets a 2xx. Without a record of what we
 * already processed, a redelivery would mark the same payment twice, and every
 * customer would get a second order confirmation for a card charged once.
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
 * Tell everyone a checkout was paid for: one confirmation to the customer,
 * one new-order alert per farm.
 *
 * Both are queued through the outbox, so this returns in the time of a couple
 * of selects and never depends on the email provider being up.
 */
const announcePaidCheckout = async (checkoutId) => {
  try {
    const { data: checkout } = await supabase
      .from(TABLES.checkouts)
      .select(
        'id, client_id, products_subtotal_bani, delivery_fee_total_bani, commission_total_bani, total_bani',
      )
      .eq('id', String(checkoutId))
      .maybeSingle();

    if (!checkout) {
      return;
    }

    const { data: orders } = await supabase
      .from(TABLES.orders)
      .select(
        'id, farmer_id, client_id, products_subtotal_bani, delivery_fee_bani, commission_bani, transfer_amount_bani, order_state',
      )
      .eq('checkout_id', String(checkoutId));

    const groups = (orders || []).filter((order) => order.order_state !== 'cancelled');

    await notifyCustomerOrderConfirmed({ checkout, orders: groups });

    for (const order of groups) {
      const { data: items } = await supabase
        .from(TABLES.orderItems)
        .select('product_name, product_unit, quantity, line_total')
        .eq('order_id', String(order.id));
      await notifyFarmerNewOrder({ order, items: items || [] });
    }
  } catch (error) {
    // A missing notification must never make us return non-2xx to Stripe and
    // earn a redelivery of a payment we already recorded.
    console.error('[webhook] Could not announce paid checkout:', error?.message || error);
  }
};

/**
 * Payment confirmed: flip the checkout and all its farmer groups to paid, and
 * put each farmer's share into escrow.
 *
 * No money moves to a farmer here. Under the escrow model the charge settles
 * on the platform balance and stays there, marked `held` against a specific
 * order, until the customer confirms the order arrived — see
 * `lib/transfers.js`. That is what makes an undelivered order refundable in
 * full instead of a claw-back against a balance the farmer may have spent.
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

  if (applied?.newly_paid) {
    // OPS-02 / LEG-02 — the confirmation on a durable medium, and the one
    // email a farmer cannot afford to miss. Queued, never sent inline: the
    // webhook must answer Stripe in time regardless of how Resend is feeling.
    await announcePaidCheckout(checkoutId);
  }

  // The hold is asserted on every delivery of the event, not only the first:
  // if the first delivery marked the checkout paid and then crashed, the
  // redelivery has to finish the job. Only groups still on `none` are
  // promoted, so a repeat cannot disturb one already decided.
  await holdCheckoutGroups({ checkoutId });
};

/**
 * A refund we did not issue — someone used the Stripe dashboard.
 *
 * We cannot tell which farmer group it belongs to (one PaymentIntent covers
 * the whole basket), so this does not try to guess. It records the fact
 * loudly, so a reconciliation run has something to start from, rather than
 * leaving an order that reads "paid" while the money has gone back.
 */
const reconcileRefundFromStripe = async (charge) => {
  const paymentIntentId = String(charge?.payment_intent || '');
  if (!paymentIntentId) {
    return;
  }

  const { data: checkout } = await supabase
    .from(TABLES.checkouts)
    .select('id, client_id')
    .eq('stripe_payment_intent_id', paymentIntentId)
    .maybeSingle();

  if (!checkout) {
    return;
  }

  const refundedBani = Number(charge?.amount_refunded || 0);

  // Did we already record refunds covering this? If so there is nothing to say.
  const { data: known } = await supabase
    .from(TABLES.refunds)
    .select('amount_bani, state')
    .eq('checkout_id', String(checkout.id));

  const accountedBani = (known || [])
    .filter((row) => row.state !== 'failed')
    .reduce((sum, row) => sum + Number(row.amount_bani || 0), 0);

  if (accountedBani >= refundedBani) {
    return;
  }

  await recordAudit({
    actorType: 'system',
    actorId: 'stripe',
    action: ACTIONS.REFUND_COMPLETED,
    entityType: 'checkout',
    entityId: String(checkout.id),
    oldValue: `accounted:${accountedBani}`,
    newValue: `stripe_refunded:${refundedBani}`,
  });

  console.error(
    `[webhook] Checkout ${checkout.id}: Stripe reports ${refundedBani} bani refunded but our ledger ` +
      `accounts for ${accountedBani}. A refund was issued outside the app — reconcile by hand.`,
  );
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

          // OPS-02 — a farm that still cannot take payments is invisible in
          // the catalogue, and the farmer has no way of knowing that unless
          // we tell them. Nudged once a day, not once per Stripe event.
          if (!result.chargesEnabled && result.farmerId) {
            await notifyConnectIncomplete({
              userId: result.farmerId,
              farmName: result.farmName || 'Your farm',
              requirementsDue: Array.isArray(account?.requirements?.currently_due)
                ? account.requirements.currently_due
                : [],
            });
          }
        }
        break;
      }

      case 'charge.refunded': {
        // Reconciliation only. We issue every refund ourselves in
        // `lib/refunds.js` and write the ledger there, so this event normally
        // describes something we already know. It matters when a refund was
        // issued from the Stripe dashboard by hand: without this, the order
        // would still read as fully paid.
        await reconcileRefundFromStripe(event.data.object);
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
