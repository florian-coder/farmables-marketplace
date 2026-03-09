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
        // Handle case where req.body might be a Buffer from express.raw
        const bodyStr = Buffer.isBuffer(req.body) ? req.body.toString() : req.body;
        event = typeof bodyStr === 'string' ? JSON.parse(bodyStr) : bodyStr;
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
            // Update order status to auto-accepted (received_by_farmer)
            await supabase
              .from('orders')
              .update({ order_state: 'received_by_farmer' }) 
              .eq('id', orderId);
            console.log(`Order ${orderId} marked as paid/received_by_farmer`);
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
