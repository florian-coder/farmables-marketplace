const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { supabase } = require('../lib/supabase');

const router = express.Router();

router.post(
  '/stripe',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

    let event;

    try {
      if (endpointSecret) {
        event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
      } else {
        event = JSON.parse(req.body);
      }
    } catch (err) {
      console.error('Webhook signature verification failed.', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Handle the event
    try {
      switch (event.type) {
        case 'checkout.session.completed': {
          const session = event.data.object;
          const orderId = session.metadata.orderId;
          
          if (orderId) {
            // Update order status to paid
            await supabase
              .from('orders')
              .update({ order_state: 'pending_order' }) // or 'paid_order' depending on your states
              .eq('id', orderId);
            console.log(`Order ${orderId} marked as paid/pending_order`);
          }
          break;
        }
        case 'checkout.session.expired': {
          const session = event.data.object;
          const orderId = session.metadata.orderId;

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
