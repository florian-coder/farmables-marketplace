// OPS-03 — disputes.
//
// The shape of the problem: a customer says two of five kilos were missing,
// the farm says they were not. Somebody has to decide, and until now nobody
// could — there was no case, no evidence, no deadline and no way for the
// customer to escalate past a farm that had stopped replying.
//
// Three decisions worth stating:
//
//   * **The window opens at `arrived` and closes at `received`.** Before
//     delivery there is nothing to dispute; after the customer confirms
//     receipt the order is closed. That is the same deadline OPS-04 uses to
//     auto-confirm, on purpose — one clock, not two that can disagree.
//
//   * **The farmer gets 48 hours, and then it escalates by itself.** A farmer
//     who simply stops replying must not be able to run out the clock. The
//     escalation is automatic and needs nobody to notice it.
//
//   * **An order with an open dispute is never auto-confirmed.** Otherwise
//     OPS-04 would quietly close the one order most likely to need the window
//     kept open.

const { supabase, TABLES } = require('./supabase');
const { ACTIONS, recordAudit } = require('./audit');
const { issueRefund, loadOrderForRefund } = require('./refunds');
const { toBani } = require('./money');

/** The farmer's window to respond before the case comes to us. */
const FARMER_RESPONSE_HOURS = 48;

const DISPUTE_STATES = Object.freeze({
  OPEN: 'open',
  AWAITING_FARMER: 'awaiting_farmer',
  FARMER_RESPONDED: 'farmer_responded',
  ESCALATED: 'escalated',
  RESOLVED: 'resolved',
  WITHDRAWN: 'withdrawn',
});

const CATEGORIES = ['not_delivered', 'missing_items', 'quality', 'wrong_items', 'other'];

/** States in which a dispute is still live. */
const ACTIVE_STATES = [
  DISPUTE_STATES.OPEN,
  DISPUTE_STATES.AWAITING_FARMER,
  DISPUTE_STATES.FARMER_RESPONDED,
  DISPUTE_STATES.ESCALATED,
];

/** Order states in which a dispute may be opened. */
const DISPUTABLE_ORDER_STATES = ['arrived', 'received'];

const DISPUTE_COLUMNS = [
  'id',
  'order_id',
  'checkout_id',
  'customer_id',
  'farmer_id',
  'opened_by',
  'category',
  'description',
  'claimed_bani',
  'state',
  'farmer_response',
  'farmer_responded_at',
  'respond_by',
  'escalated_at',
  'resolution',
  'resolution_note',
  'refund_id',
  'resolved_by',
  'resolved_at',
  'created_at',
  'updated_at',
].join(', ');

const mapDispute = (row) => ({
  id: String(row.id),
  orderId: String(row.order_id),
  customerId: String(row.customer_id),
  farmerId: String(row.farmer_id),
  openedBy: row.opened_by,
  category: row.category,
  description: row.description || '',
  claimedBani: row.claimed_bani === null ? null : toBani(row.claimed_bani),
  state: row.state,
  farmerResponse: row.farmer_response || '',
  farmerRespondedAt: row.farmer_responded_at || null,
  respondBy: row.respond_by || null,
  escalatedAt: row.escalated_at || null,
  resolution: row.resolution || '',
  resolutionNote: row.resolution_note || '',
  resolvedBy: row.resolved_by || '',
  resolvedAt: row.resolved_at || null,
  createdAt: row.created_at || null,
});

/**
 * Open a case.
 *
 * Returns `{ ok, dispute }` or `{ ok: false, status, code, error }`. The
 * caller has already checked that this user is party to the order.
 */
const openDispute = async ({ req = null, order, actor, actorId, category, description, claimedBani }) => {
  if (!CATEGORIES.includes(category)) {
    return {
      ok: false,
      status: 400,
      code: 'unknown_category',
      error: `category must be one of: ${CATEGORIES.join(', ')}.`,
    };
  }
  if (!DISPUTABLE_ORDER_STATES.includes(order.order_state)) {
    return {
      ok: false,
      status: 409,
      code: 'window_closed',
      // Said precisely: "not yet" and "too late" are different problems and
      // the customer can act on one of them.
      error:
        order.order_state === 'cancelled'
          ? 'This order was cancelled. If you were not refunded, contact us directly.'
          : 'You can report a problem once the order has been marked as delivered.',
    };
  }

  const respondBy = new Date(Date.now() + FARMER_RESPONSE_HOURS * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from(TABLES.disputes)
    .insert({
      order_id: String(order.id),
      checkout_id: order.checkout_id || null,
      customer_id: String(order.client_id),
      farmer_id: String(order.farmer_id),
      opened_by: actor,
      category,
      description: String(description || '').slice(0, 2000),
      claimed_bani: claimedBani === null || claimedBani === undefined ? null : toBani(claimedBani),
      state: DISPUTE_STATES.AWAITING_FARMER,
      respond_by: respondBy,
    })
    .select(DISPUTE_COLUMNS)
    .single();

  if (error) {
    if (error.code === '23505') {
      // The partial unique index. A second complaint about the same order
      // belongs in the first case, not beside it.
      return {
        ok: false,
        status: 409,
        code: 'already_open',
        error: 'There is already an open case for this order.',
      };
    }
    return { ok: false, status: 500, code: 'insert_failed', error: 'Unable to open the case.' };
  }

  await recordAudit({
    req,
    actorType: actor,
    actorId,
    action: ACTIONS.DISPUTE_OPENED,
    entityType: 'order',
    entityId: String(order.id),
    newValue: category,
  });

  return { ok: true, dispute: mapDispute(data) };
};

/**
 * Cases the farmer has let run past their 48 hours.
 *
 * Escalating is not a punishment — it moves the decision to someone who will
 * actually make it. Run from the same timer as OPS-04.
 */
const escalateOverdueDisputes = async () => {
  const { data, error } = await supabase
    .from(TABLES.disputes)
    .select(DISPUTE_COLUMNS)
    .in('state', [DISPUTE_STATES.OPEN, DISPUTE_STATES.AWAITING_FARMER])
    .lte('respond_by', new Date().toISOString())
    .limit(100);

  if (error) {
    console.error('[disputes] Could not load overdue cases:', error.message);
    return 0;
  }

  let escalated = 0;
  for (const row of data || []) {
    const { error: updateError } = await supabase
      .from(TABLES.disputes)
      .update({ state: DISPUTE_STATES.ESCALATED, escalated_at: new Date().toISOString() })
      .eq('id', String(row.id))
      // Re-check the state: the farmer may have replied between the select
      // and here.
      .in('state', [DISPUTE_STATES.OPEN, DISPUTE_STATES.AWAITING_FARMER]);

    if (updateError) {
      continue;
    }

    await recordAudit({
      actorType: 'system',
      actorId: 'dispute-escalation',
      action: ACTIONS.DISPUTE_OPENED,
      entityType: 'dispute',
      entityId: String(row.id),
      oldValue: row.state,
      newValue: `escalated_after_${FARMER_RESPONSE_HOURS}h`,
    });
    escalated += 1;
  }

  return escalated;
};

/**
 * Close a case, and move the money if that is the answer.
 *
 * Only an admin reaches this. The refund goes through `issueRefund` like every
 * other refund — there is no second path that moves money.
 */
const resolveDispute = async ({ req = null, dispute, adminUsername, resolution, note, refundProductsBani }) => {
  const allowed = ['refund_full', 'refund_partial', 'no_action', 'replaced'];
  if (!allowed.includes(resolution)) {
    return {
      ok: false,
      status: 400,
      code: 'unknown_resolution',
      error: `resolution must be one of: ${allowed.join(', ')}.`,
    };
  }
  if (!ACTIVE_STATES.includes(dispute.state)) {
    return {
      ok: false,
      status: 409,
      code: 'already_closed',
      error: 'This case has already been closed.',
    };
  }

  let refund = null;
  if (resolution === 'refund_full' || resolution === 'refund_partial') {
    const order = await loadOrderForRefund(dispute.order_id);
    if (!order) {
      return { ok: false, status: 404, code: 'order_missing', error: 'The order no longer exists.' };
    }

    refund = await issueRefund({
      req,
      order,
      reason: `Dispute ${String(dispute.id).slice(0, 8)}: ${note || resolution}`,
      actorType: 'admin',
      actorId: adminUsername,
      refundProductsBani: resolution === 'refund_full' ? null : toBani(refundProductsBani),
    });

    if (!refund.refunded && refund.reason !== 'already_claimed') {
      // The case stays open rather than closing on a refund that did not
      // happen. A resolved case with no money moved is the worst outcome.
      return {
        ok: false,
        status: 502,
        code: 'refund_failed',
        error: refund.error || 'The refund could not be completed, so the case stays open.',
        detail: refund.detail || null,
      };
    }
  }

  const { error } = await supabase
    .from(TABLES.disputes)
    .update({
      state: DISPUTE_STATES.RESOLVED,
      resolution,
      resolution_note: String(note || '').slice(0, 2000),
      refund_id: refund?.refundId || null,
      resolved_by: adminUsername,
      resolved_at: new Date().toISOString(),
    })
    .eq('id', String(dispute.id));

  if (error) {
    return { ok: false, status: 500, code: 'update_failed', error: 'Unable to close the case.' };
  }

  await recordAudit({
    req,
    actorType: 'admin',
    actorId: adminUsername,
    action: ACTIONS.DISPUTE_RESOLVED,
    entityType: 'dispute',
    entityId: String(dispute.id),
    oldValue: dispute.state,
    newValue: resolution,
  });

  return { ok: true, resolution, refund };
};

/** Is there a live case on this order? OPS-04 asks before auto-confirming. */
const hasActiveDispute = async (orderId) => {
  const { data } = await supabase
    .from(TABLES.disputes)
    .select('id')
    .eq('order_id', String(orderId))
    .in('state', ACTIVE_STATES)
    .limit(1);

  return Array.isArray(data) && data.length > 0;
};

module.exports = {
  FARMER_RESPONSE_HOURS,
  DISPUTE_STATES,
  ACTIVE_STATES,
  CATEGORIES,
  DISPUTABLE_ORDER_STATES,
  DISPUTE_COLUMNS,
  mapDispute,
  openDispute,
  escalateOverdueDisputes,
  resolveDispute,
  hasActiveDispute,
};
