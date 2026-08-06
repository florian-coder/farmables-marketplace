// Checkout — one payment for the whole cart, however many farms are in it.
//
// LOG-03: the customer used to pay each farm separately, which meant three
// card forms for a three-farm basket. Now the whole cart is one
// `checkouts` row, one Stripe Checkout Session, one `PaymentIntent` on the
// platform account, and one `transfer_group`. The per-farmer split happens
// after the payment confirms, in `lib/transfers.js`.

const express = require('express');
const crypto = require('crypto');

const { requireAuth } = require('../middleware/auth');
const { supabase, TABLES } = require('../lib/supabase');
const { stripe, describeStripeError, stripeRequestId } = require('../lib/stripeClient');
const { FRONTEND_URL } = require('../lib/config');
const { buildCartQuote, serializeQuote } = require('../lib/pricing');
const { formatBani, toBani } = require('../lib/money');
const { transferCheckoutGroups } = require('../lib/transfers');

const router = express.Router();

/**
 * Errors on the payment path never become a bare 500.
 *
 * The customer gets a sentence they can act on, and the logs get a request id
 * they can be searched by. A generic "Internal Server Error" on a payment
 * screen tells the customer nothing and tells us nothing either.
 */
const failPayment = (res, { status = 500, message, logLabel, error }) => {
  const requestId = crypto.randomUUID().slice(0, 8);
  console.error(
    `[checkout:${requestId}] ${logLabel}:`,
    error?.message || error || 'no detail',
    stripeRequestId(error) ? `stripe_request=${stripeRequestId(error)}` : '',
  );
  return res.status(status).json({ error: message, requestId });
};

const requireCustomer = (req, res) => {
  if (req.user.role !== 'customer') {
    res.status(403).json({ error: 'Only customer accounts can place orders.' });
    return false;
  }
  return true;
};

/**
 * GET /api/checkout/summary
 *
 * Everything the cart page needs to show the price breakdown before the
 * customer commits: per-farm subtotal, per-farm delivery fee, the platform
 * service fee, the total, and any reason the cart cannot be paid for yet.
 */
router.get('/summary', requireAuth, async (req, res, next) => {
  try {
    if (!requireCustomer(req, res)) {
      return null;
    }
    const quote = await buildCartQuote({ clientId: req.user.id });
    return res.json(serializeQuote(quote));
  } catch (error) {
    return next(error);
  }
});

/**
 * Build the Stripe line items from the values frozen on the order rows.
 *
 * Reading the frozen columns rather than recomputing is deliberate: whatever
 * `process_checkout` wrote is what the customer is charged and what the
 * farmer is paid, so there is exactly one number in play.
 */
const buildLineItems = (groups) => {
  const lineItems = [];
  let commissionTotalBani = 0;

  for (const group of groups) {
    const farmName = group.farmName || 'Farm';

    for (const item of group.items) {
      lineItems.push({
        price_data: {
          currency: 'ron',
          product_data: {
            name: `${item.productName || 'Produs'} — ${farmName}`,
            description: `${item.quantity} ${item.productUnit || 'buc'} × ${formatBani(item.unitPriceBani)}`,
          },
          // One line per cart item, priced at its line total: Stripe sees
          // quantity 1 because our quantities can be fractional (1.5 kg).
          unit_amount: item.lineTotalBani,
        },
        quantity: 1,
      });
    }

    if (group.deliveryFeeBani > 0) {
      lineItems.push({
        price_data: {
          currency: 'ron',
          product_data: { name: `Livrare — ${farmName}` },
          unit_amount: group.deliveryFeeBani,
        },
        quantity: 1,
      });
    }

    commissionTotalBani += group.commissionBani;
  }

  if (commissionTotalBani > 0) {
    // One visible line, never folded into the product prices. The customer
    // must see what the platform charges, itemised, before paying.
    lineItems.push({
      price_data: {
        currency: 'ron',
        product_data: {
          name: 'Platform service fee',
          description: 'The Farmables fee for intermediation and payment processing.',
        },
        unit_amount: commissionTotalBani,
      },
      quantity: 1,
    });
  }

  return { lineItems, commissionTotalBani };
};

/** Re-read the frozen money columns after `process_checkout` has run. */
const loadFrozenGroups = async (checkoutId) => {
  const { data: orders, error } = await supabase
    .from(TABLES.orders)
    .select(
      'id, farmer_id, products_subtotal_bani, delivery_fee_bani, commission_bani, commission_bps, transfer_amount_bani, stripe_account_id',
    )
    .eq('checkout_id', String(checkoutId));

  if (error) {
    throw new Error(error.message || 'Unable to load frozen order groups.');
  }

  const orderIds = (orders || []).map((row) => String(row.id));
  const farmerIds = [...new Set((orders || []).map((row) => String(row.farmer_id)))];

  const [itemsResult, farmersResult] = await Promise.all([
    supabase
      .from(TABLES.orderItems)
      .select('order_id, product_name, product_unit, quantity, unit_price, line_total')
      .in('order_id', orderIds.length > 0 ? orderIds : ['-']),
    supabase
      .from(TABLES.farmers)
      .select('id, "farm name", "display name"')
      .in('id', farmerIds.length > 0 ? farmerIds : ['-']),
  ]);

  if (itemsResult.error) {
    throw new Error(itemsResult.error.message || 'Unable to load order items.');
  }

  const itemsByOrder = new Map();
  for (const item of itemsResult.data || []) {
    const key = String(item.order_id);
    const list = itemsByOrder.get(key) || [];
    list.push({
      productName: item.product_name || '',
      productUnit: item.product_unit || '',
      quantity: Number(item.quantity || 0),
      unitPriceBani: Math.round(Number(item.unit_price || 0) * 100),
      lineTotalBani: Math.round(Number(item.line_total || 0) * 100),
    });
    itemsByOrder.set(key, list);
  }

  const namesById = new Map(
    (farmersResult.data || []).map((row) => [
      String(row.id),
      row['farm name'] || row['display name'] || 'Farm',
    ]),
  );

  return (orders || []).map((row) => ({
    orderId: String(row.id),
    farmerId: String(row.farmer_id),
    farmName: namesById.get(String(row.farmer_id)) || 'Farm',
    productsSubtotalBani: toBani(row.products_subtotal_bani),
    deliveryFeeBani: toBani(row.delivery_fee_bani),
    commissionBani: toBani(row.commission_bani),
    commissionBps: toBani(row.commission_bps),
    transferAmountBani: toBani(row.transfer_amount_bani),
    stripeAccountId: String(row.stripe_account_id || ''),
    items: itemsByOrder.get(String(row.id)) || [],
  }));
};

/**
 * POST /api/checkout/create-checkout-session
 *
 * Takes no order id any more: the cart is whatever `placed_order` rows the
 * authenticated customer owns. Passing an id was how SEC-05 let one customer
 * drain another's stock, and the concept no longer exists here.
 */
router.post('/create-checkout-session', requireAuth, async (req, res, next) => {
  let checkoutId = null;

  try {
    if (!requireCustomer(req, res)) {
      return null;
    }

    // 1. An existing unpaid checkout is reused rather than duplicated, so a
    //    customer who goes back and clicks pay again does not reserve stock
    //    a second time.
    const { data: openCheckouts, error: openError } = await supabase
      .from(TABLES.checkouts)
      .select('id, state, stripe_session_id, transfer_group, total_bani')
      .eq('client_id', req.user.id)
      .eq('state', 'awaiting_payment')
      .order('created_at', { ascending: false })
      .limit(1);

    if (openError) {
      return failPayment(res, {
        message: 'Could not check for payments in progress. Please try again.',
        logLabel: 'open checkout lookup failed',
        error: openError,
      });
    }

    const reusable = (openCheckouts || [])[0] || null;
    if (reusable?.stripe_session_id) {
      try {
        const existingSession = await stripe.checkout.sessions.retrieve(reusable.stripe_session_id);
        if (existingSession.status === 'open' && existingSession.url) {
          return res.json({ url: existingSession.url, checkoutId: reusable.id, reused: true });
        }
      } catch (retrieveError) {
        // Session gone or expired — fall through and build a fresh one.
        console.warn('[checkout] Could not reuse session:', retrieveError?.message);
      }
    }

    // 2. Price the cart and refuse early on anything the customer must fix.
    const quote = await buildCartQuote({ clientId: req.user.id });

    if (quote.groups.length === 0) {
      return res.status(400).json({ error: 'Your basket is empty.' });
    }
    if (!quote.payable) {
      return res.status(409).json({
        error: quote.blockers[0]?.message || 'Your basket cannot be checked out yet.',
        blockers: quote.blockers,
        quote: serializeQuote(quote),
      });
    }

    // 3. Create the parent checkout. `transfer_group` ties the charge and all
    //    the farmer transfers together in Stripe's own reporting.
    const transferGroup = `chk_${crypto.randomUUID().replace(/-/g, '')}`;
    const { data: checkoutRow, error: checkoutError } = await supabase
      .from(TABLES.checkouts)
      .insert({
        client_id: String(req.user.id),
        transfer_group: transferGroup,
        currency: 'ron',
        state: 'open',
      })
      .select('id, transfer_group, state')
      .single();

    if (checkoutError || !checkoutRow) {
      return failPayment(res, {
        message: 'Could not open the payment. Try again in a moment.',
        logLabel: 'checkout insert failed',
        error: checkoutError,
      });
    }
    checkoutId = checkoutRow.id;

    // 4. Reserve stock and freeze the money, atomically, in one transaction.
    //    The SQL function is the authority: it re-reads the farmer settings
    //    and the commission rate itself, so the numbers it writes cannot
    //    drift from what it validated.
    const { data: rpcData, error: rpcError } = await supabase.rpc('process_checkout', {
      p_checkout_id: checkoutId,
      p_order_ids: quote.groups.map((group) => group.orderId),
    });

    if (rpcError || !rpcData?.success) {
      await supabase
        .from(TABLES.checkouts)
        .update({ state: 'cancelled', cancel_reason: rpcData?.error || 'reservation_failed' })
        .eq('id', checkoutId);

      return res.status(409).json({
        error:
          rpcData?.error ||
          rpcError?.message ||
          'Stock no longer covers your order. Check your basket and try again.',
        blockers: rpcData?.blockers || [],
      });
    }

    // 5. Build the session from the frozen values.
    const groups = await loadFrozenGroups(checkoutId);
    const { lineItems } = buildLineItems(groups);
    const totalBani = toBani(rpcData.total_bani);

    if (lineItems.length === 0 || totalBani <= 0) {
      await supabase.rpc('rollback_checkout', { p_checkout_id: checkoutId });
      return res.status(400).json({ error: 'There is nothing to pay for in your basket.' });
    }

    const { data: userRow } = await supabase
      .from(TABLES.users)
      .select('email')
      .eq('id', req.user.id)
      .maybeSingle();

    const session = await stripe.checkout.sessions.create(
      {
        mode: 'payment',
        payment_method_types: ['card'],
        line_items: lineItems,
        customer_email: userRow?.email || undefined,
        locale: 'ro',
        client_reference_id: String(checkoutId),
        metadata: {
          checkout_id: String(checkoutId),
          client_id: String(req.user.id),
          order_ids: groups.map((group) => group.orderId).join(','),
        },
        payment_intent_data: {
          // The link between this charge and every transfer that follows.
          transfer_group: transferGroup,
          metadata: {
            checkout_id: String(checkoutId),
            client_id: String(req.user.id),
          },
        },
        // Stripe expires the session and we roll the stock back on the
        // `checkout.session.expired` webhook.
        expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
        success_url: `${FRONTEND_URL}/orders?success=true&checkout=${checkoutId}`,
        cancel_url: `${FRONTEND_URL}/orders?canceled=true&checkout=${checkoutId}`,
      },
      { idempotencyKey: `session-${checkoutId}` },
    );

    const { error: sessionSaveError } = await supabase
      .from(TABLES.checkouts)
      .update({
        stripe_session_id: session.id,
        stripe_payment_intent_id:
          typeof session.payment_intent === 'string' ? session.payment_intent : null,
        total_bani: totalBani,
        products_subtotal_bani: toBani(rpcData.products_subtotal_bani),
        delivery_fee_total_bani: toBani(rpcData.delivery_fee_total_bani),
        commission_total_bani: toBani(rpcData.commission_total_bani),
      })
      .eq('id', checkoutId);

    if (sessionSaveError) {
      // The session exists at Stripe; not recording it would orphan the
      // payment. Better to fail visibly and let the customer retry, because
      // the retry reuses the same idempotency key and the same session.
      return failPayment(res, {
        message: 'The payment was prepared but we could not save the reference. Please try again.',
        logLabel: `session ${session.id} not persisted for checkout ${checkoutId}`,
        error: sessionSaveError,
      });
    }

    return res.json({ url: session.url, checkoutId, totalBani });
  } catch (error) {
    // Anything unexpected past the reservation point releases the stock, so a
    // failed attempt does not leave products locked away from other buyers.
    if (checkoutId) {
      try {
        await supabase.rpc('rollback_checkout', { p_checkout_id: checkoutId });
      } catch (rollbackError) {
        console.error('[checkout] Rollback failed:', rollbackError?.message);
      }
    }

    if (error?.type?.startsWith?.('Stripe')) {
      return failPayment(res, {
        status: 502,
        message: describeStripeError(error),
        logLabel: 'stripe session creation failed',
        error,
      });
    }
    return next(error);
  }
});

/**
 * GET /api/checkout/:checkoutId/status
 *
 * The customer lands here from Stripe's success page. The webhook is the
 * authority on payment, but it can be seconds behind the redirect, so this
 * asks Stripe directly and applies the same state change if it has not
 * happened yet.
 */
router.get('/:checkoutId/status', requireAuth, async (req, res, next) => {
  try {
    const checkoutId = String(req.params.checkoutId || '').trim();
    if (!checkoutId) {
      return res.status(400).json({ error: 'checkoutId is required.' });
    }

    const { data: checkout, error } = await supabase
      .from(TABLES.checkouts)
      .select('id, client_id, state, stripe_session_id, total_bani, paid_at')
      .eq('id', checkoutId)
      .maybeSingle();

    if (error) {
      return failPayment(res, {
        message: 'Could not check the payment.',
        logLabel: 'status lookup failed',
        error,
      });
    }
    // A checkout that is not yours and one that does not exist look identical.
    if (!checkout || String(checkout.client_id) !== String(req.user.id)) {
      return res.status(404).json({ error: 'Payment not found.' });
    }

    if (checkout.state === 'paid') {
      return res.json({ state: 'paid', totalBani: checkout.total_bani, paidAt: checkout.paid_at });
    }
    if (!checkout.stripe_session_id) {
      return res.json({ state: checkout.state });
    }

    const session = await stripe.checkout.sessions.retrieve(checkout.stripe_session_id);
    if (session.payment_status !== 'paid') {
      return res.json({ state: checkout.state, paymentStatus: session.payment_status });
    }

    // Paid at Stripe but not yet recorded here: apply it now. The webhook will
    // find it already done and skip, because both paths guard on state.
    const { data: applied, error: applyError } = await supabase.rpc('mark_checkout_paid', {
      p_checkout_id: checkoutId,
      p_payment_intent_id:
        typeof session.payment_intent === 'string' ? session.payment_intent : null,
    });

    if (applyError) {
      return failPayment(res, {
        message: 'Payment succeeded but the order has not updated yet. Reload the page in a few seconds.',
        logLabel: `mark_checkout_paid failed for ${checkoutId}`,
        error: applyError,
      });
    }

    if (applied?.newly_paid) {
      // Transfers are the webhook's job, but if the redirect got here first we
      // start them now — both paths claim through `order_transfers`.
      transferCheckoutGroups({ checkoutId, eventId: `redirect-${checkoutId}` }).catch((err) =>
        console.error('[checkout] Transfer after redirect failed:', err?.message),
      );
    }

    return res.json({ state: 'paid', totalBani: checkout.total_bani, updated: true });
  } catch (error) {
    if (error?.type?.startsWith?.('Stripe')) {
      return failPayment(res, {
        status: 502,
        message: describeStripeError(error),
        logLabel: 'status check failed at stripe',
        error,
      });
    }
    return next(error);
  }
});

module.exports = router;
