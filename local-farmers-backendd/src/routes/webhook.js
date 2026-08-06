const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { supabase, TABLES } = require('../lib/supabase');
const { ACTIONS, recordAudit } = require('../lib/audit');

const router = express.Router();

/**
 * SEC-06 — Idempotență.
 *
 * Stripe reia livrarea unui eveniment până primește 2xx. Fără evidența
 * evenimentelor deja procesate, o reluare ar marca a doua oară aceeași plată.
 * Inserția e cea care decide: cheia primară pe id face ca a doua încercare să
 * pice cu 23505, iar noi ieșim fără să reprocesăm.
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
  // Nu putem garanta unicitatea, deci nu procesăm: mai bine o plată
  // neînregistrată și o reluare, decât o dublă procesare.
  throw new Error(error.message || 'Unable to record Stripe event.');
};

router.post(
  '/stripe',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

    // SEC-06: fără secret nu se poate verifica semnătura, deci nu se poate ști
    // dacă evenimentul vine de la Stripe. Comportamentul implicit e refuzul.
    if (!endpointSecret) {
      console.error(
        '[webhook] STRIPE_WEBHOOK_SECRET nu e configurat. Evenimentul a fost refuzat ' +
          'fără procesare: fără el, oricine poate trimite confirmări de plată false.',
      );
      return res.status(500).json({ error: 'Webhook not configured.' });
    }

    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    } catch (err) {
      console.error('Webhook signature verification failed.', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      const isNew = await claimEvent(event);
      if (!isNew) {
        // Deja procesat. 2xx, ca Stripe să nu mai reia.
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
          const orderId = session.metadata?.orderId;

          if (orderId) {
            // Update order status to auto-accepted (received_by_farmer).
            // paid_at is what the farmer's monthly earnings are grouped by.
            await supabase
              .from('orders')
              .update({
                order_state: 'received_by_farmer',
                paid_at: new Date().toISOString(),
              })
              .eq('id', orderId)
              .eq('order_state', 'pending_order');

            await recordAudit({
              actorType: 'system',
              actorId: 'stripe',
              action: ACTIONS.ORDER_PAID,
              entityType: 'order',
              entityId: orderId,
              newValue: 'received_by_farmer',
            });
            console.log(`Order ${orderId} marked as paid/received_by_farmer`);
          }
          break;
        }
        case 'checkout.session.expired': {
          const session = event.data.object;
          const orderId = session.metadata?.orderId;

          if (orderId) {
            // Call rollback RPC
            await supabase.rpc('rollback_checkout', { p_order_id: orderId });
            console.log(`Order ${orderId} rolled back due to expired session`);
          }
          break;
        }
        // ... handle other event types
        default:
          console.log(`Unhandled event type ${event.type}`);
      }
    } catch (error) {
      console.error('Error processing webhook event:', error);
    }

    res.json({ received: true });
  }
);

module.exports = router;
