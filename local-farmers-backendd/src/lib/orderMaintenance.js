// The hourly sweep — and, since payouts are held in escrow, the job that
// decides where forgotten money ends up.
//
// OPS-04: a customer who never clicks "received" is not being difficult; they
// got their vegetables and closed the tab. But the order sits in `arrived`
// forever, which means the dispute window never closes, the farmer's sales
// record never completes, and — now that the farmer is only paid on
// confirmation — the farmer is never paid at all.
//
// So the order closes itself — after a warning, and only after long enough
// that a genuine complaint has had every chance to arrive first. The warning
// is the part that makes this fair: silence only counts as consent when the
// person was told what silence would mean.
//
// The mirror image is `expireUndeliveredOrders`: an order that never reached
// the door at all is cancelled and refunded. Between the two, no held amount
// can sit on the platform balance indefinitely — every ban either reaches the
// farmer or goes back to the customer, on a deadline.

const { supabase, TABLES } = require('./supabase');
const { ACTIONS, recordAudit } = require('./audit');
const { evaluateTransition } = require('./orderState');
const { notifyAutoConfirmWarning } = require('./notifications');
const { hasActiveDispute, escalateOverdueDisputes } = require('./disputes');
const { generateDueBaskets } = require('./subscriptionRuns');
const { releaseOrderPayout, retryStalePayouts } = require('./transfers');
const { cancelPaidOrder } = require('./refunds');
const {
  RATING_ORDER_STATES,
  recalculateAndPersistProductRatings,
} = require('./productRating');

/** Days in `arrived` before we ask, and before we close it ourselves. */
const WARN_AFTER_DAYS = Number(process.env.AUTO_CONFIRM_WARN_DAYS) || 4;
const CONFIRM_AFTER_DAYS = Number(process.env.AUTO_CONFIRM_DAYS) || 7;

/**
 * Days a paid order may sit without ever reaching the customer's door before
 * the platform gives the money back.
 *
 * This is the other half of the escrow promise. Auto-confirm covers the order
 * that arrived and was forgotten; this covers the one that never arrived at
 * all — the farmer took the order, never moved it, and the customer's money
 * would otherwise sit on the platform balance forever. Fourteen days is
 * deliberately far longer than any farm's lead time, because cancelling a
 * real order that is merely late is worse than holding a dead one a week
 * longer.
 */
const UNDELIVERED_EXPIRY_DAYS = Number(process.env.PAYOUT_HOLD_EXPIRY_DAYS) || 14;

/** Paid states from which an order can still fail to arrive. */
const UNDELIVERED_STATES = ['received_by_farmer', 'preparing_order', 'in_transit'];

const daysAgo = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

const MAINTENANCE_COLUMNS =
  'id, client_id, farmer_id, order_state, arrived_at, updated_at, refund_state';

/**
 * When the order actually reached the door.
 *
 * `arrived_at` is stamped by the transition; `updated_at` is the fallback for
 * orders that were already sitting in `arrived` before that column existed.
 */
const arrivedAt = (order) => order.arrived_at || order.updated_at || null;

const staleArrivedOrders = async (days) => {
  const { data, error } = await supabase
    .from(TABLES.orders)
    .select(MAINTENANCE_COLUMNS)
    .eq('order_state', 'arrived')
    .lte('arrived_at', daysAgo(days))
    .limit(200);

  if (error) {
    // A missing `arrived_at` column (migration 05 not run yet) lands here.
    // Skipping is right: closing orders on a column we cannot read would be
    // worse than not closing them at all.
    console.error('[maintenance] Could not load stale arrived orders:', error.message);
    return [];
  }
  return (data || []).filter((order) => arrivedAt(order));
};

/** "Did this arrive? It closes on its own in N days." */
const warnStaleArrivedOrders = async () => {
  const orders = await staleArrivedOrders(WARN_AFTER_DAYS);
  let warned = 0;

  for (const order of orders) {
    // Sending twice is free: the outbox `event_key` is keyed on the order, so
    // the second attempt collapses into the row already queued.
    await notifyAutoConfirmWarning({
      order,
      daysLeft: Math.max(1, CONFIRM_AFTER_DAYS - WARN_AFTER_DAYS),
    });
    warned += 1;
  }

  return warned;
};

/**
 * Close what nobody closed.
 *
 * Goes through the state machine as `system`, which has that edge precisely so
 * this job does not need a private bypass around the rules.
 */
const autoConfirmStaleArrivedOrders = async () => {
  const orders = await staleArrivedOrders(CONFIRM_AFTER_DAYS);
  let confirmed = 0;

  for (const order of orders) {
    // An order with a refund in flight is not a forgotten order, it is an
    // open case. Closing it would silently end the dispute window.
    if (order.refund_state && order.refund_state !== 'none') {
      continue;
    }

    // OPS-03 — and neither is one with a live dispute. Auto-confirming the
    // single order most likely to need the window kept open would be exactly
    // the wrong order to close.
    if (await hasActiveDispute(order.id)) {
      continue;
    }

    const verdict = evaluateTransition({
      actor: 'system',
      from: order.order_state,
      to: 'received',
    });
    if (!verdict.ok) {
      continue;
    }

    const { error } = await supabase
      .from(TABLES.orders)
      .update({ order_state: 'received', auto_confirmed_at: new Date().toISOString() })
      .eq('id', String(order.id))
      // Re-check the state in the update itself: between the select and here,
      // the customer may have confirmed it themselves.
      .eq('order_state', 'arrived');

    if (error) {
      console.error(`[maintenance] Could not auto-confirm order ${order.id}:`, error.message);
      continue;
    }

    await recordAudit({
      actorType: 'system',
      actorId: 'auto-confirm',
      action: ACTIONS.ORDER_STATE_CHANGED,
      entityType: 'order',
      entityId: String(order.id),
      oldValue: 'arrived',
      newValue: `received:auto_after_${CONFIRM_AFTER_DAYS}d`,
    });

    // Confirmed is confirmed, however it happened: this is the same release
    // the customer's own click performs. Auto-confirm without it would close
    // the order and quietly keep the farmer's money.
    await releaseOrderPayout({ orderId: order.id });

    confirmed += 1;
  }

  if (confirmed > 0 && RATING_ORDER_STATES.includes('received')) {
    try {
      await recalculateAndPersistProductRatings({ supabase, tables: TABLES });
    } catch (error) {
      console.error('[maintenance] Rating recalculation failed:', error?.message);
    }
  }

  return confirmed;
};

/**
 * Orders that were paid for and never arrived.
 *
 * The customer paid, the farm took the order, and then nothing — no
 * `in_transit`, no `arrived`, no cancellation. Under escrow their money is
 * still on the platform balance, which means it can simply go back, and after
 * `UNDELIVERED_EXPIRY_DAYS` it does.
 *
 * `cancelPaidOrder` is the same path a farmer's decline takes: stock back on
 * the shelf, the refund issued, the customer told. Going through it rather
 * than writing the state directly is what keeps one cancellation path for
 * everybody — the state machine judges the move as `system`, and the refund
 * module owns the money.
 */
const expireUndeliveredOrders = async () => {
  const { data, error } = await supabase
    .from(TABLES.orders)
    .select('id, order_state, refund_state, transfer_state, paid_at, payout_hold_started_at')
    .in('order_state', UNDELIVERED_STATES)
    .lte('paid_at', daysAgo(UNDELIVERED_EXPIRY_DAYS))
    .limit(100);

  if (error) {
    console.error('[maintenance] Could not load undelivered orders:', error.message);
    return 0;
  }

  let expired = 0;

  for (const order of data || []) {
    // Money already on its way somewhere. Whatever is happening to this order,
    // it is not neglect, and a second refund on top would be a real loss.
    if (order.refund_state && order.refund_state !== 'none') {
      continue;
    }
    // The farmer has been paid — an old order from before escrow, or one an
    // admin released by hand. Refunding it is a claw-back decision a person
    // has to make, not something a sweep should do at 3am.
    if (order.transfer_state === 'sent') {
      continue;
    }
    // OPS-03 — an order under dispute has a human looking at it.
    if (await hasActiveDispute(order.id)) {
      continue;
    }

    const verdict = evaluateTransition({
      actor: 'system',
      from: order.order_state,
      to: 'cancelled',
    });
    if (!verdict.ok) {
      continue;
    }

    const outcome = await cancelPaidOrder({
      orderId: order.id,
      actor: 'system',
      actorId: 'payout-expiry',
      reason: `Not delivered within ${UNDELIVERED_EXPIRY_DAYS} days — refunded automatically.`,
      refundRequired: verdict.refundRequired,
    });

    if (!outcome.ok) {
      console.error(
        `[maintenance] Could not expire undelivered order ${order.id}: ${outcome.error}`,
      );
      continue;
    }

    await recordAudit({
      actorType: 'system',
      actorId: 'payout-expiry',
      action: ACTIONS.ORDER_STATE_CHANGED,
      entityType: 'order',
      entityId: String(order.id),
      oldValue: order.order_state,
      newValue: `cancelled:undelivered_after_${UNDELIVERED_EXPIRY_DAYS}d`,
    });

    expired += 1;
  }

  return expired;
};

const runOrderMaintenance = async () => {
  const summary = {
    warned: 0,
    confirmed: 0,
    escalated: 0,
    organicClaimsCleared: 0,
    baskets: 0,
    expired: 0,
    payoutsRetried: 0,
  };
  try {
    // OPS-03 first: a case that escalates in this pass must be visible to the
    // auto-confirm sweep that follows it.
    summary.escalated = await escalateOverdueDisputes();
    // LEG-04 — a certificate that lapsed on Friday must not still be selling
    // "bio" on Monday. The database function does the whole sweep in one
    // statement, so this costs one round trip an hour.
    const { data: cleared } = await supabase.rpc('expire_organic_claims', {});
    summary.organicClaimsCleared = Number(cleared) || 0;
    summary.warned = await warnStaleArrivedOrders();
    summary.confirmed = await autoConfirmStaleArrivedOrders();
    // Money first, in both directions: what nobody delivered goes back to the
    // customer, and what failed to reach a farmer is tried again. Both before
    // the basket generator, because neither should queue behind new carts.
    summary.expired = await expireUndeliveredOrders();
    summary.payoutsRetried = (await retryStalePayouts()).sent;
    // LOG-06 — build the baskets that are due. Last, because it creates carts
    // and nothing above should have to reason about half-built ones.
    summary.baskets = (await generateDueBaskets()).built;
  } catch (error) {
    console.error('[maintenance] Run failed:', error?.message || error);
  }
  return summary;
};

/** Timer loop, started by `server.js`. Returns a stop function. */
const startOrderMaintenance = ({ intervalMs = 3600000 } = {}) => {
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runOrderMaintenance();
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
  // Deliberately not run at boot: a redeploy loop would otherwise hammer this
  // on every restart, and nothing here is urgent to the minute.

  return () => clearInterval(timer);
};

module.exports = {
  WARN_AFTER_DAYS,
  CONFIRM_AFTER_DAYS,
  UNDELIVERED_EXPIRY_DAYS,
  warnStaleArrivedOrders,
  autoConfirmStaleArrivedOrders,
  expireUndeliveredOrders,
  runOrderMaintenance,
  startOrderMaintenance,
};
