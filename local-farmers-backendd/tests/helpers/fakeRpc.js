// Implementări în JS ale funcțiilor SQL, peste baza de date falsă.
//
// Nu sunt mock-uri care întorc `{success:true}`: reproduc ce face funcția din
// Postgres — refac stocul, marchează comanda, întorc aceleași chei. Altfel
// testul de anulare ar trece fără să demonstreze că stocul se întoarce, adică
// exact bucata care lipsea din OPS-01.

const rowsOf = (db, table) => {
  if (!db[table]) db[table] = [];
  return db[table];
};

const findById = (db, table, id) =>
  rowsOf(db, table).find((row) => String(row.id) === String(id)) || null;

const toInt = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : 0;
};

/** `public.cancel_order_with_stock` — anulare și refacere de stoc, împreună. */
const cancelOrderWithStock = (args, db) => {
  const order = findById(db, 'orders', args.p_order_id);
  if (!order) {
    return { success: false, error: 'Order not found.' };
  }

  const money = {
    order_id: order.id,
    checkout_id: order.checkout_id ?? null,
    products_subtotal_bani: toInt(order.products_subtotal_bani),
    delivery_fee_bani: toInt(order.delivery_fee_bani),
    commission_bani: toInt(order.commission_bani),
    transfer_amount_bani: toInt(order.transfer_amount_bani),
    transfer_state: order.transfer_state || 'none',
    paid_at: order.paid_at ?? null,
  };

  if (order.order_state === 'cancelled') {
    return { success: true, already_cancelled: true, ...money };
  }

  let restored = 0;
  // Doar dacă `process_checkout` chiar a rezervat stocul. Un coș nu a rezervat
  // nimic, iar adăugarea de cantitate acolo ar inventa marfă.
  if (order.order_state !== 'placed_order') {
    for (const item of rowsOf(db, 'order_items')) {
      if (String(item.order_id) !== String(order.id)) continue;
      const product = findById(db, 'products', item.product_id);
      if (!product) continue;
      product.quantity = Number(product.quantity || 0) + Number(item.quantity || 0);
      restored += 1;
    }
  }

  const previousState = order.order_state;
  order.order_state = 'cancelled';
  order.cancelled_at = order.cancelled_at || new Date().toISOString();
  order.cancelled_by = args.p_cancelled_by;
  order.cancel_reason = String(args.p_reason || '').slice(0, 500);

  return {
    success: true,
    already_cancelled: false,
    restored_items: restored,
    previous_state: previousState,
    ...money,
  };
};

/** `public.apply_refund_result` — starea rambursării, scrisă pe comandă. */
const applyRefundResult = (args, db) => {
  const order = findById(db, 'orders', args.p_order_id);
  if (!order) {
    return { success: false, error: 'Order not found.' };
  }
  order.refund_state = args.p_refund_state;
  order.refunded_bani = Math.max(
    0,
    toInt(order.refunded_bani) + toInt(args.p_refunded_delta_bani),
  );
  return { success: true, refunded_bani: order.refunded_bani };
};

/** `public.mark_checkout_paid` — plata confirmată, grupurile trec la fermier. */
const markCheckoutPaid = (args, db) => {
  const checkout = findById(db, 'checkouts', args.p_checkout_id);
  if (!checkout) {
    return { success: false, error: 'Plata nu a fost găsită.' };
  }
  if (checkout.state === 'paid') {
    return { success: true, newly_paid: false, total_bani: checkout.total_bani };
  }

  const now = new Date().toISOString();
  checkout.state = 'paid';
  checkout.paid_at = checkout.paid_at || now;
  if (args.p_payment_intent_id) {
    checkout.stripe_payment_intent_id = args.p_payment_intent_id;
  }

  for (const order of rowsOf(db, 'orders')) {
    if (String(order.checkout_id) !== String(checkout.id)) continue;
    if (order.order_state !== 'pending_order') continue;
    order.order_state = 'received_by_farmer';
    order.paid_at = order.paid_at || now;
    // Escrow: the farmer's share is claimed by the platform in the same
    // statement that marks the group paid, exactly as the SQL does.
    if ((order.transfer_state || 'none') === 'none') {
      order.transfer_state = 'held';
      order.payout_hold_started_at = order.payout_hold_started_at || now;
    }
  }

  return { success: true, newly_paid: true, total_bani: checkout.total_bani };
};

/**
 * `public.withhold_farmer_share` — a refund against money still held.
 *
 * The clamp is the point of the function, so the double clamps too: two
 * partial refunds must not be able to withhold more than the farmer was ever
 * owed, which would make the eventual release a negative transfer.
 */
const withholdFarmerShare = (args, db) => {
  const order = findById(db, 'orders', args.p_order_id);
  if (!order) {
    return { success: false, error: 'Order not found.' };
  }

  const owed = toInt(order.transfer_amount_bani);
  const withheld = Math.min(
    owed,
    toInt(order.refunded_transfer_bani) + Math.max(toInt(args.p_amount_bani), 0),
  );

  order.refunded_transfer_bani = withheld;
  if (withheld >= owed && order.transfer_state === 'held') {
    order.transfer_state = 'reversed';
  }

  return {
    success: true,
    refunded_transfer_bani: withheld,
    releasable_bani: Math.max(owed - withheld, 0),
  };
};

/** Setul complet, pentru `buildApp(seed, { rpc: orderRpc() })`. */
const orderRpc = (extra = {}) => ({
  cancel_order_with_stock: cancelOrderWithStock,
  apply_refund_result: applyRefundResult,
  mark_checkout_paid: markCheckoutPaid,
  withhold_farmer_share: withholdFarmerShare,
  ...extra,
});

module.exports = {
  cancelOrderWithStock,
  applyRefundResult,
  markCheckoutPaid,
  withholdFarmerShare,
  orderRpc,
};
