const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { requireAuth } = require('../middleware/auth');
const { supabase, TABLES } = require('../lib/supabase');

const router = express.Router();

router.post('/create-checkout-session', requireAuth, async (req, res) => {
  const { orderId } = req.body;

  if (!orderId) {
    return res.status(400).json({ error: 'Order ID is required' });
  }

  // 1. Ia produsele din order_items pentru aceasta comanda
  const { data: items, error: itemsError } = await supabase
    .from(TABLES.orderItems)
    .select('*')
    .eq('order_id', orderId);

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

  // 3. Apelează funcția atomică pentru a tăia stocul (rezervare)
  const { data: rpcData, error: rpcError } = await supabase.rpc('process_checkout', { p_order_id: orderId });
  
  if (rpcError || !rpcData?.success) {
     return res.status(400).json({ error: rpcData?.error || rpcError?.message || 'Stoc insuficient, tranzacție anulată.' });
  }

  try {
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    // 4. Creează sesiunea Stripe
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      metadata: { orderId: orderId }, 
      success_url: `${frontendUrl}/orders?success=true`,
      cancel_url: `${frontendUrl}/orders?canceled=true`,
    });

    res.json({ url: session.url });
  } catch (err) {
    // 5. Dacă Stripe aruncă o eroare, dăm ROLLBACK ca să nu lăsăm comanda blocată
    console.error('Stripe error, rolling back checkout:', err.message);
    await supabase.rpc('rollback_checkout', { p_order_id: orderId });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
