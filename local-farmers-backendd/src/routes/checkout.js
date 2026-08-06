const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { requireAuth } = require('../middleware/auth');
const { supabase, TABLES } = require('../lib/supabase');

const router = express.Router();

/**
 * SEC-05 — Nicio operațiune pe o comandă înainte de a ști că e a celui care cere.
 *
 * Fără verificarea asta, orice utilizator logat putea trimite identificatorul
 * comenzii altcuiva și declanșa `process_checkout`, care scade stocul. Repetat
 * în buclă, golea stocul fermierilor fără să plătească nimic.
 *
 * Întoarce { order } sau { error, status } — niciodată detalii despre comenzile
 * altora, ca ruta să nu devină oracol pentru identificatori valizi.
 */
const loadOwnedOrder = async (orderId, user) => {
  const id = typeof orderId === 'string' ? orderId.trim() : '';
  if (!id) {
    return { error: 'Order ID is required', status: 400 };
  }

  const { data: order, error } = await supabase
    .from(TABLES.orders)
    .select('id, client_id, farmer_id, order_state, paid_at')
    .eq('id', id)
    .maybeSingle();

  if (error) {
    return { error: 'Unable to load order.', status: 500 };
  }
  // Comandă inexistentă și comandă a altcuiva primesc același răspuns.
  if (!order || String(order.client_id) !== String(user.id)) {
    return { error: 'Order not found.', status: 404 };
  }

  return { order };
};

router.post('/create-checkout-session', requireAuth, async (req, res) => {
  const { orderId } = req.body;

  const owned = await loadOwnedOrder(orderId, req.user);
  if (owned.error) {
    return res.status(owned.status).json({ error: owned.error });
  }
  const { order } = owned;

  // Idempotență: stocul se rezervă o singură dată per comandă. O comandă deja
  // trecută în pending_order și-a consumat rezervarea, iar una plătită nu mai
  // are ce căuta la casă.
  if (order.paid_at || !['placed_order', 'pending_order'].includes(order.order_state)) {
    return res.status(400).json({ error: 'This order can no longer be paid.' });
  }
  const alreadyReserved = order.order_state === 'pending_order';

  // 1. Ia produsele din order_items pentru aceasta comanda
  const { data: items, error: itemsError } = await supabase
    .from(TABLES.orderItems)
    .select('*')
    .eq('order_id', order.id);

  if (itemsError) {
    console.error('Supabase items query error:', itemsError);
  }

  if (itemsError || !items || items.length === 0) {
    return res.status(400).json({ error: 'Failed to retrieve order items.' });
  }

  // 2. Formatează produsele pentru Stripe și calculează totalul
  let totalSessionAmountCents = 0;
  const lineItems = items.map(item => {
    // Math.round to avoid float precision issues, convert to cents
    const unitPriceCents = Math.round(Number(item.unit_price) * 100);
    const quantityMultiplier = Number(item.quantity);

    const totalAmountInCents = Math.round(unitPriceCents * quantityMultiplier);
    totalSessionAmountCents += totalAmountInCents;

    const productName = item.product_name || 'Produs Ferma Mea';
    const productUnit = item.product_unit || 'unitate';

    return {
      price_data: {
        currency: 'ron',
        product_data: {
          name: `${productName} (${item.quantity} ${productUnit})`,
        },
        unit_amount: totalAmountInCents,
      },
      quantity: 1, // STRIPE VEDE DOAR 1 BUCATĂ
    };
  });

  // Validare Stripe: Suma totală trebuie să fie minim 2.00 RON (200 bani)
  if (totalSessionAmountCents < 200) {
    return res.status(400).json({ error: 'Comanda minimă pentru plata cu cardul (Stripe) este de 2.00 RON.' });
  }

  // 3. Apelează funcția atomică pentru a tăia stocul (rezervare), o singură dată
  if (!alreadyReserved) {
    const { data: rpcData, error: rpcError } = await supabase.rpc('process_checkout', {
      p_order_id: order.id,
    });

    if (rpcError || !rpcData?.success) {
      return res.status(400).json({
        error: rpcData?.error || rpcError?.message || 'Stoc insuficient, tranzacție anulată.',
      });
    }
  }

  try {
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    // 4. Creează sesiunea Stripe
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      metadata: { orderId: order.id },
      success_url: `${frontendUrl}/orders?success=true`,
      cancel_url: `${frontendUrl}/orders?canceled=true`,
    });

    res.json({ url: session.url });
  } catch (err) {
    // 5. Dacă Stripe aruncă o eroare, dăm ROLLBACK ca să nu lăsăm comanda blocată
    console.error('Stripe error, rolling back checkout:', err.message);
    if (!alreadyReserved) {
      await supabase.rpc('rollback_checkout', { p_order_id: order.id });
    }
    res.status(500).json({ error: err.message });
  }
});

router.get('/verify-status/:orderId', requireAuth, async (req, res) => {
  const owned = await loadOwnedOrder(req.params.orderId, req.user);
  if (owned.error) {
    return res.status(owned.status).json({ error: owned.error });
  }
  const { order } = owned;

  try {
    // 1. Fetch recent sessions from Stripe
    const sessions = await stripe.checkout.sessions.list({
      limit: 10,
    });

    // 2. Find if any session matches our orderId and is paid
    const matchingSession = sessions.data.find(
      (s) => s.metadata.orderId === order.id && s.payment_status === 'paid'
    );

    if (matchingSession) {
      // 3. Update the order state to received_by_farmer if it's still pending
      if (order.order_state === 'pending_order') {
        await supabase
          .from(TABLES.orders)
          .update({
            order_state: 'received_by_farmer',
            // Nu suprascriem momentul plății dacă webhook-ul a ajuns primul.
            paid_at: order.paid_at || new Date().toISOString(),
          })
          .eq('id', order.id);

        return res.json({ status: 'paid', updated: true });
      }

      return res.json({ status: 'paid', updated: false });
    }

    return res.json({ status: 'unpaid' });
  } catch (error) {
    console.error('Error verifying payment status:', error);
    res.status(500).json({ error: 'Failed to verify payment status.' });
  }
});

module.exports = router;
