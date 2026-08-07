// OPS-04 — orders that reached the door and were never confirmed.
//
// A customer who never clicks "received" is not being difficult; they got
// their vegetables and closed the tab. But the order sits in `arrived`
// forever, which means the dispute window never closes, the farmer's sales
// record never completes, and nobody can tell a forgotten order from one with
// a real problem.
//
// So the order closes itself — after a warning, and only after long enough
// that a genuine complaint has had every chance to arrive first. The warning
// is the part that makes this fair: silence only counts as consent when the
// person was told what silence would mean.

const { supabase, TABLES } = require('./supabase');
const { ACTIONS, recordAudit } = require('./audit');
const { evaluateTransition } = require('./orderState');
const { notifyAutoConfirmWarning } = require('./notifications');
const { hasActiveDispute, escalateOverdueDisputes } = require('./disputes');
const {
  RATING_ORDER_STATES,
  recalculateAndPersistProductRatings,
} = require('./productRating');

/** Days in `arrived` before we ask, and before we close it ourselves. */
const WARN_AFTER_DAYS = Number(process.env.AUTO_CONFIRM_WARN_DAYS) || 4;
const CONFIRM_AFTER_DAYS = Number(process.env.AUTO_CONFIRM_DAYS) || 7;

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

const runOrderMaintenance = async () => {
  const summary = { warned: 0, confirmed: 0, escalated: 0, organicClaimsCleared: 0 };
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
  warnStaleArrivedOrders,
  autoConfirmStaleArrivedOrders,
  runOrderMaintenance,
  startOrderMaintenance,
};
