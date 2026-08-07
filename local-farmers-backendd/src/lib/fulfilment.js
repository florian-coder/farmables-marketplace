// OPS-06 + LOG-04 — what actually went in the box.
//
// Two findings that are one problem. A farmer with 3 of 5 kilos could only
// decline the whole order, and a bag of tomatoes is never exactly 1 kg — both
// are "delivered ≠ ordered", and both are answered the same way: record what
// was actually delivered, refund the difference if it matters.
//
// The rules, which are now identical in the code and in customer terms §10.4:
//
//   * **Within tolerance, the price stands.** ±10% by default. A farm that
//     puts in 950 g of a 1 kg bag has not short-changed anyone, and refunding
//     50 g would cost more in Stripe fees than it returns.
//   * **Short beyond tolerance is refunded automatically.** The customer does
//     not have to notice, complain, or ask.
//   * **Over is never charged for.** The farm gave more than it billed; that
//     is on them, and it evens out.
//
// **The card is charged once, at the price shown at checkout.** The other
// legal route — authorise more than the price and capture at the real weight —
// is worse: the customer sees a hold larger than the number they agreed to,
// and a payment they did not authorise is not one we are willing to take.

const { supabase, TABLES } = require('./supabase');
const { getPlatformSettings } = require('./platformSettings');
const { leiToBani, toBani, formatBani } = require('./money');
const { issueRefund, loadOrderForRefund } = require('./refunds');
const { ACTIONS, recordAudit } = require('./audit');

/** Anything at or below this share of an item is "as ordered". */
const DEFAULT_TOLERANCE_BPS = 1000; // 10%

const toQuantity = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return Number(parsed.toFixed(2));
};

/**
 * Work out what a set of fulfilled quantities means.
 *
 * Pure — no database, no Stripe — so the arithmetic can be tested on its own
 * and so the caller can show the customer the same numbers before committing.
 *
 * `items` are the order items; `fulfilled` maps item id → delivered quantity.
 */
const evaluateFulfilment = ({ items, fulfilled, toleranceBps = DEFAULT_TOLERANCE_BPS }) => {
  const lines = [];
  let shortfallBani = 0;
  let anythingDelivered = false;

  for (const item of items) {
    const orderedQty = Number(item.quantity || 0);
    const lineTotalBani = leiToBani(item.line_total);
    const raw = fulfilled[String(item.id)];
    // Unrecorded means "as ordered". A farm that only corrects the two items
    // it had to short should not have to retype the other eight.
    const deliveredQty = raw === undefined || raw === null ? orderedQty : toQuantity(raw);

    if (deliveredQty === null) {
      return { ok: false, error: `Invalid quantity for ${item.product_name || 'an item'}.` };
    }
    if (deliveredQty > orderedQty) {
      // Accepted, and free. Recording it keeps the traceability record honest
      // about what left the farm.
      lines.push({
        itemId: String(item.id),
        productName: item.product_name || '',
        orderedQty,
        deliveredQty,
        shortBani: 0,
        withinTolerance: true,
        over: true,
      });
      anythingDelivered = true;
      continue;
    }

    if (deliveredQty > 0) {
      anythingDelivered = true;
    }

    const missingQty = orderedQty - deliveredQty;
    // The shortfall in money, from the line total rather than unit price ×
    // quantity: `line_total` is what the customer was actually charged.
    const missingBani =
      orderedQty > 0 ? Math.round((lineTotalBani * missingQty) / orderedQty) : 0;

    // The tolerance is per item and proportional. 10% of a 1 kg bag is 100 g;
    // 10% of a 10 kg sack is a kilo, which is the right shape — a scoop is a
    // scoop either way.
    const allowanceQty = (orderedQty * toBani(toleranceBps)) / 10000;
    const withinTolerance = missingQty <= allowanceQty;

    lines.push({
      itemId: String(item.id),
      productName: item.product_name || '',
      orderedQty,
      deliveredQty,
      shortBani: withinTolerance ? 0 : missingBani,
      withinTolerance,
      over: false,
    });

    if (!withinTolerance) {
      shortfallBani += missingBani;
    }
  }

  return {
    ok: true,
    lines,
    shortfallBani,
    anythingDelivered,
    // Everything short by more than tolerance and nothing delivered at all is
    // a non-delivery, not a partial one.
    kind: shortfallBani === 0 ? 'full' : anythingDelivered ? 'partial' : 'none_delivered',
    toleranceBps,
  };
};

/**
 * Record what was delivered, and refund the difference if there is one.
 *
 * Called by the farmer when they hand the order over. Returns
 * `{ ok, evaluation, refund }` or a refusal the route turns into a status.
 */
const recordFulfilment = async ({ req = null, order, fulfilled, actorId }) => {
  const { data: items, error: itemsError } = await supabase
    .from(TABLES.orderItems)
    .select('id, order_id, product_name, product_unit, quantity, unit_price, line_total')
    .eq('order_id', String(order.id));

  if (itemsError) {
    return { ok: false, status: 500, error: 'Unable to load the order items.' };
  }
  if (!items || items.length === 0) {
    return { ok: false, status: 409, code: 'no_items', error: 'This order has no items.' };
  }

  const settings = await getPlatformSettings();
  const evaluation = evaluateFulfilment({
    items,
    fulfilled: fulfilled || {},
    toleranceBps: settings.weightToleranceBps ?? DEFAULT_TOLERANCE_BPS,
  });

  if (!evaluation.ok) {
    return { ok: false, status: 400, code: 'invalid_quantity', error: evaluation.error };
  }

  const now = new Date().toISOString();
  for (const line of evaluation.lines) {
    await supabase
      .from(TABLES.orderItems)
      .update({ fulfilled_quantity: line.deliveredQty, fulfilled_at: now })
      .eq('id', line.itemId);
  }

  await supabase
    .from(TABLES.orders)
    .update({
      fulfilment_recorded_at: now,
      fulfilment_state: evaluation.kind === 'full' ? 'full' : 'partial',
    })
    .eq('id', String(order.id));

  await recordAudit({
    req,
    actorType: 'farmer',
    actorId,
    action: ACTIONS.ORDER_FULFILMENT_RECORDED,
    entityType: 'order',
    entityId: String(order.id),
    newValue: `${evaluation.kind}:short=${evaluation.shortfallBani}`,
  });

  if (evaluation.shortfallBani <= 0) {
    return { ok: true, evaluation, refund: null };
  }

  // The customer does not have to notice, complain, or ask. That is the whole
  // point of recording it here rather than waiting for a dispute.
  const fresh = await loadOrderForRefund(order.id);
  const refund = await issueRefund({
    req,
    order: fresh || order,
    reason: `Short delivery: ${formatBani(evaluation.shortfallBani)} of products not supplied`,
    actorType: 'farmer',
    actorId,
    refundProductsBani: evaluation.shortfallBani,
  });

  return { ok: true, evaluation, refund };
};

module.exports = {
  DEFAULT_TOLERANCE_BPS,
  evaluateFulfilment,
  recordFulfilment,
};
