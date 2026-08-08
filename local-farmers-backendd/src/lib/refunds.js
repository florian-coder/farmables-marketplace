// OPS-01b — giving the money back.
//
// Where the farmer's share is at the moment of the refund decides how this
// runs, and there are two cases:
//
//   * Still held by the platform (the normal case under escrow — the customer
//     has not confirmed receipt, which is usually exactly why they are asking
//     for their money back). Nothing has to be recovered from anybody. The
//     share is marked withheld on the order, so the later release nets it out,
//     and the card is refunded. This is the whole reason payouts wait for
//     confirmation: the refund costs one Stripe call and cannot fail halfway.
//
//   * Already sent (the order was confirmed, and an admin is reversing it
//     afterwards). Then the order of operations is not negotiable:
//
//       1. reverse the transfer  (take it back off the farmer)
//       2. refund the charge     (give it to the customer)
//
//     and never the other way round. Refunding first would push the platform
//     balance negative and Stripe would start declining unrelated transfers
//     for other farmers.
//
// Idempotency has the same two layers as `transfers.js`:
//   1. the `refunds` row IS the claim — a partial unique index makes a second
//      full refund on the same order fail with 23505;
//   2. every Stripe call carries an idempotency key derived from the refund
//      id, so a crash between claim and call cannot pay twice.
//
// One deliberate asymmetry: when the reversal fails because the farmer has
// already withdrawn the money, we refund the customer anyway and mark the
// refund `refund_pending_manual`. The customer's right to their money does not
// depend on whether we can reach the farmer's balance — OUG 34/2014 gives us
// 14 days regardless — so the platform carries the gap and someone chases the
// farmer. Doing it the other way round would mean a customer is out of pocket
// because of a payout schedule they never saw.

const { supabase, TABLES } = require('./supabase');
const { stripe, stripeRequestId } = require('./stripeClient');
const { toBani, formatBani, refundBreakdown } = require('./money');
const { ACTIONS, recordAudit } = require('./audit');
const {
  notifyCustomerCancelled,
  notifyCustomerRefundCompleted,
} = require('./notifications');

/** Refund lifecycle, mirrored onto `orders.refund_state`. */
const REFUND_STATES = Object.freeze({
  PENDING: 'pending',
  REVERSING: 'reversing',
  REFUNDING: 'refunding',
  COMPLETED: 'completed',
  FAILED: 'failed',
  MANUAL_REQUIRED: 'refund_pending_manual',
});

/** What the `orders.refund_state` column carries; a coarser view of the above. */
const ORDER_REFUND_STATES = Object.freeze({
  NONE: 'none',
  PENDING: 'pending',
  PARTIAL: 'partial',
  REFUNDED: 'refunded',
  FAILED: 'failed',
  MANUAL_REQUIRED: 'refund_pending_manual',
});

const ORDER_MONEY_COLUMNS = [
  'id',
  'farmer_id',
  'client_id',
  'checkout_id',
  'order_state',
  'products_subtotal_bani',
  'delivery_fee_bani',
  'commission_bani',
  'commission_bps',
  'transfer_amount_bani',
  'refunded_transfer_bani',
  'transfer_state',
  'stripe_transfer_id',
  'stripe_account_id',
  'refund_state',
  'refunded_bani',
  'paid_at',
].join(', ');

const loadOrderForRefund = async (orderId) => {
  const { data, error } = await supabase
    .from(TABLES.orders)
    .select(ORDER_MONEY_COLUMNS)
    .eq('id', String(orderId))
    .maybeSingle();

  if (error) {
    throw new Error(error.message || 'Unable to load order for refund.');
  }
  return data || null;
};

const loadCheckout = async (checkoutId) => {
  if (!checkoutId) {
    return null;
  }
  const { data, error } = await supabase
    .from(TABLES.checkouts)
    .select('id, client_id, state, stripe_payment_intent_id, transfer_group')
    .eq('id', String(checkoutId))
    .maybeSingle();

  if (error) {
    throw new Error(error.message || 'Unable to load payment for refund.');
  }
  return data || null;
};

/**
 * Claim the right to refund this order.
 *
 * Returns the new ledger row, or null when someone else already claimed it.
 * A write failure is treated as "do not proceed": an unrefunded order we can
 * retry is recoverable, a double refund is money we do not get back.
 */
const claimRefund = async ({
  orderId,
  checkoutId,
  breakdown,
  reason,
  actorType,
  actorId,
}) => {
  const { data, error } = await supabase
    .from(TABLES.refunds)
    .insert({
      order_id: String(orderId),
      checkout_id: checkoutId ? String(checkoutId) : null,
      kind: breakdown.kind,
      products_bani: breakdown.productsBani,
      delivery_bani: breakdown.deliveryBani,
      commission_bani: breakdown.commissionBani,
      amount_bani: breakdown.amountBani,
      reversal_amount_bani: breakdown.reversalAmountBani,
      reason: String(reason || '').slice(0, 500),
      actor_type: actorType,
      actor_id: String(actorId || ''),
      state: REFUND_STATES.PENDING,
    })
    .select('id, order_id, checkout_id, kind, amount_bani, reversal_amount_bani, state')
    .single();

  if (!error) {
    return data;
  }
  if (error.code === '23505') {
    return null;
  }
  throw new Error(error.message || 'Unable to claim refund.');
};

const updateRefundRow = async (refundId, patch) => {
  const { error } = await supabase
    .from(TABLES.refunds)
    .update(patch)
    .eq('id', String(refundId));
  if (error) {
    console.error('[refunds] Unable to update refund ledger:', error.message);
  }
};

const applyToOrder = async ({ orderId, refundState, refundedDeltaBani = 0 }) => {
  const { error } = await supabase.rpc('apply_refund_result', {
    p_order_id: String(orderId),
    p_refund_state: refundState,
    p_refunded_delta_bani: toBani(refundedDeltaBani),
  });
  if (error) {
    console.error('[refunds] Unable to apply refund result to order:', error.message);
  }
};

const describeStripeFailure = (error) => {
  const requestId = stripeRequestId(error);
  return `${error?.code || error?.type || 'error'}: ${error?.message || 'unknown'}${
    requestId ? ` (req ${requestId})` : ''
  }`.slice(0, 500);
};

/**
 * Record that part of a held share will never reach the farmer.
 *
 * The database function does the arithmetic under a row lock, and clamps the
 * running total at the farmer's whole share: two partial refunds racing must
 * not be able to withhold more than was ever owed and turn the eventual
 * release into a negative transfer.
 *
 * Returns false when the write failed — the caller then treats the refund as
 * a plain one. That is the safe direction: an unwithheld share is money the
 * platform may pay out twice and can chase, while refusing the refund would
 * leave the customer out of pocket for a bookkeeping problem.
 */
const withholdFarmerShare = async ({ orderId, amountBani }) => {
  const { error } = await supabase.rpc('withhold_farmer_share', {
    p_order_id: String(orderId),
    p_amount_bani: toBani(amountBani),
  });

  if (error) {
    console.error(
      `[refunds] Could not withhold ${formatBani(amountBani)} of the held share on order ${orderId}:`,
      error.message,
    );
    return false;
  }
  return true;
};

/**
 * Take the farmer's share back before the customer is refunded.
 *
 * Returns `{ reversed, reversalId, manual, detail }`. `manual: true` means the
 * money could not be recovered automatically — almost always because the
 * farmer's balance is already at their bank — and a human has to collect it.
 */
const reverseFarmerTransfer = async ({ order, refund, amountBani }) => {
  const transferId = String(order.stripe_transfer_id || '');
  const amount = toBani(amountBani);

  if (amount <= 0) {
    return { reversed: true, reversalId: null, manual: false, detail: 'nothing_to_reverse' };
  }
  if (order.transfer_state !== 'sent' || !transferId) {
    // The farmer was never paid — the money is still in escrow on the platform
    // balance. Nothing to claw back, but the amount has to be written down as
    // withheld, or the release that follows a later confirmation would pay the
    // farmer money that has already gone back to the customer.
    const withheld = await withholdFarmerShare({ orderId: order.id, amountBani: amount });
    return {
      reversed: true,
      reversalId: null,
      manual: false,
      detail: withheld ? 'withheld_from_escrow' : 'transfer_not_sent',
      withheldBani: withheld ? amount : 0,
    };
  }

  await updateRefundRow(refund.id, { state: REFUND_STATES.REVERSING });

  try {
    const reversal = await stripe.transfers.createReversal(
      transferId,
      {
        amount,
        description: `Refund ${String(refund.id).slice(0, 8)} — Farmables`,
        metadata: {
          order_id: String(order.id),
          refund_id: String(refund.id),
        },
      },
      { idempotencyKey: `reversal-refund-${refund.id}` },
    );

    return { reversed: true, reversalId: reversal.id, manual: false };
  } catch (error) {
    const detail = describeStripeFailure(error);
    // The farmer has already withdrawn. Everything else is a genuine failure,
    // but this one is expected often enough to have its own path.
    const manual = error?.code === 'balance_insufficient';
    console.error(
      `[refunds] Reversal of ${formatBani(amount)} on transfer ${transferId} failed — ${detail}`,
    );
    return { reversed: false, reversalId: null, manual, detail };
  }
};

/**
 * Refund the customer's card.
 *
 * Issued against the PaymentIntent rather than the charge, because one
 * PaymentIntent covers the whole basket and a partial amount is exactly how a
 * single farmer's group comes out of it.
 */
const refundCustomer = async ({ checkout, refund, amountBani, reason }) => {
  const amount = toBani(amountBani);
  if (amount <= 0) {
    return { refunded: true, refundId: null };
  }

  const paymentIntentId = String(checkout?.stripe_payment_intent_id || '');
  if (!paymentIntentId) {
    return {
      refunded: false,
      detail: 'The payment has no PaymentIntent recorded, so it cannot be refunded automatically.',
    };
  }

  await updateRefundRow(refund.id, { state: REFUND_STATES.REFUNDING });

  try {
    const created = await stripe.refunds.create(
      {
        payment_intent: paymentIntentId,
        amount,
        // Stripe only accepts its own three reasons; ours goes in metadata.
        reason: 'requested_by_customer',
        metadata: {
          order_id: String(refund.order_id),
          refund_id: String(refund.id),
          farmables_reason: String(reason || '').slice(0, 200),
        },
      },
      { idempotencyKey: `refund-${refund.id}` },
    );

    return { refunded: true, refundId: created.id };
  } catch (error) {
    const detail = describeStripeFailure(error);
    console.error(`[refunds] Refund of ${formatBani(amount)} failed — ${detail}`);
    return { refunded: false, detail };
  }
};

/**
 * Run a refund end to end: claim, reverse, refund, record.
 *
 * Never throws on a Stripe failure — a refund that fails must be visible and
 * retryable, not an exception that unwinds a cancellation the customer has
 * already been told about.
 *
 * `refundProductsBani` null means "everything": a full refund.
 */
const issueRefund = async ({
  req = null,
  order,
  reason = '',
  actorType = 'system',
  actorId = '',
  refundProductsBani = null,
}) => {
  const orderId = String(order.id);

  const breakdown = refundBreakdown({
    productsSubtotalBani: order.products_subtotal_bani,
    deliveryFeeBani: order.delivery_fee_bani,
    commissionBani: order.commission_bani,
    refundProductsBani,
  });

  if (breakdown.amountBani <= 0) {
    return { refunded: false, reason: 'nothing_to_refund', breakdown };
  }

  // Never give back more than came in. A second partial refund that would push
  // the total past what was charged is a bug somewhere upstream, and the place
  // to stop it is before Stripe, not after.
  const alreadyRefunded = toBani(order.refunded_bani);
  const chargedBani =
    toBani(order.products_subtotal_bani) +
    toBani(order.delivery_fee_bani) +
    toBani(order.commission_bani);
  if (alreadyRefunded + breakdown.amountBani > chargedBani) {
    return {
      refunded: false,
      reason: 'over_refund',
      error: `This order has already been refunded ${formatBani(alreadyRefunded)} of ${formatBani(chargedBani)}.`,
      breakdown,
    };
  }

  const refund = await claimRefund({
    orderId,
    checkoutId: order.checkout_id,
    breakdown,
    reason,
    actorType,
    actorId,
  });
  if (!refund) {
    return { refunded: false, reason: 'already_claimed', breakdown };
  }

  await applyToOrder({ orderId, refundState: ORDER_REFUND_STATES.PENDING });
  await recordAudit({
    req,
    actorType,
    actorId,
    action: ACTIONS.REFUND_INITIATED,
    entityType: 'order',
    entityId: orderId,
    newValue: `${breakdown.kind}:${breakdown.amountBani}`,
  });

  const checkout = await loadCheckout(order.checkout_id);

  // 1. Take it back off the farmer first.
  const reversal = await reverseFarmerTransfer({
    order,
    refund,
    amountBani: breakdown.reversalAmountBani,
  });

  if (reversal.reversalId) {
    await recordAudit({
      req,
      actorType: 'system',
      actorId: 'stripe',
      action: ACTIONS.TRANSFER_REVERSED,
      entityType: 'order',
      entityId: orderId,
      newValue: `${reversal.reversalId}:${breakdown.reversalAmountBani}`,
    });
  } else if (reversal.withheldBani > 0) {
    // No Stripe object to point at — the share never left the platform. The
    // audit entry is the only record that this amount stopped being the
    // farmer's, so it is not optional.
    await recordAudit({
      req,
      actorType: 'system',
      actorId: 'escrow',
      action: ACTIONS.TRANSFER_REVERSED,
      entityType: 'order',
      entityId: orderId,
      newValue: `withheld_from_escrow:${reversal.withheldBani}`,
    });
  }

  if (!reversal.reversed && !reversal.manual) {
    // A reversal failure we do not understand. Stop before touching the card:
    // refunding now would leave the platform short with no record of why.
    await updateRefundRow(refund.id, {
      state: REFUND_STATES.FAILED,
      last_error: reversal.detail || 'reversal_failed',
    });
    await applyToOrder({ orderId, refundState: ORDER_REFUND_STATES.FAILED });
    await recordAudit({
      req,
      actorType,
      actorId,
      action: ACTIONS.REFUND_FAILED,
      entityType: 'order',
      entityId: orderId,
      newValue: (reversal.detail || 'reversal_failed').slice(0, 200),
    });
    return { refunded: false, reason: 'reversal_failed', detail: reversal.detail, breakdown };
  }

  // 2. Give it to the customer. This happens even when the reversal could not
  //    be collected — see the note at the top of the file.
  const customerRefund = await refundCustomer({
    checkout,
    refund,
    amountBani: breakdown.amountBani,
    reason,
  });

  if (!customerRefund.refunded) {
    await updateRefundRow(refund.id, {
      state: REFUND_STATES.FAILED,
      stripe_transfer_reversal_id: reversal.reversalId,
      last_error: customerRefund.detail || 'refund_failed',
    });
    await applyToOrder({ orderId, refundState: ORDER_REFUND_STATES.FAILED });
    await recordAudit({
      req,
      actorType,
      actorId,
      action: ACTIONS.REFUND_FAILED,
      entityType: 'order',
      entityId: orderId,
      newValue: (customerRefund.detail || 'refund_failed').slice(0, 200),
    });
    return { refunded: false, reason: 'refund_failed', detail: customerRefund.detail, breakdown };
  }

  const finalState = reversal.manual ? REFUND_STATES.MANUAL_REQUIRED : REFUND_STATES.COMPLETED;
  const orderState = reversal.manual
    ? ORDER_REFUND_STATES.MANUAL_REQUIRED
    : breakdown.kind === 'full'
      ? ORDER_REFUND_STATES.REFUNDED
      : ORDER_REFUND_STATES.PARTIAL;

  await updateRefundRow(refund.id, {
    state: finalState,
    stripe_refund_id: customerRefund.refundId,
    stripe_transfer_reversal_id: reversal.reversalId,
    last_error: reversal.manual ? reversal.detail : null,
    completed_at: new Date().toISOString(),
  });
  await applyToOrder({
    orderId,
    refundState: orderState,
    refundedDeltaBani: breakdown.amountBani,
  });

  await recordAudit({
    req,
    actorType,
    actorId,
    action: reversal.manual ? ACTIONS.REFUND_MANUAL_REQUIRED : ACTIONS.REFUND_COMPLETED,
    entityType: 'order',
    entityId: orderId,
    newValue: `${breakdown.amountBani}:${customerRefund.refundId || 'none'}`,
  });

  // OPS-02 — the customer hears that the money is actually moving. Queued,
  // so a mail failure cannot unwind a refund that has already happened.
  await notifyCustomerRefundCompleted({
    order,
    refundId: refund.id,
    amountBani: breakdown.amountBani,
    isPartial: breakdown.kind === 'partial',
  });

  if (reversal.manual) {
    // Loud on purpose: this is the only failure mode that costs the platform
    // real money and it will not fix itself.
    console.error(
      `[refunds] MANUAL RECOVERY NEEDED — order ${orderId}: refunded ${formatBani(breakdown.amountBani)} ` +
        `to the customer but could not reverse ${formatBani(breakdown.reversalAmountBani)} from farmer ` +
        `${order.farmer_id} (${reversal.detail}).`,
    );
  }

  return {
    refunded: true,
    refundId: refund.id,
    stripeRefundId: customerRefund.refundId,
    reversalId: reversal.reversalId,
    manualRecoveryNeeded: Boolean(reversal.manual),
    breakdown,
  };
};

/**
 * Cancel an order: stock back on the shelf, money back to the customer.
 *
 * The stock restore and the cancellation are one database transaction
 * (`cancel_order_with_stock`); the refund follows, because it talks to Stripe
 * and cannot be inside a transaction. If the refund fails the order stays
 * cancelled with `refund_state = 'failed'` — which is the recoverable half of
 * the pair, and visible in the admin panel.
 */
const cancelPaidOrder = async ({
  req = null,
  orderId,
  actor,
  actorId,
  reason = '',
  refundRequired = false,
}) => {
  const { data: result, error } = await supabase.rpc('cancel_order_with_stock', {
    p_order_id: String(orderId),
    p_cancelled_by: actor,
    p_reason: String(reason || '').slice(0, 500),
  });

  if (error) {
    return {
      ok: false,
      status: 500,
      code: 'cancel_failed',
      error: error.message || 'Unable to cancel order.',
    };
  }
  if (result && result.success === false) {
    return {
      ok: false,
      status: 409,
      code: 'cancel_rejected',
      error: result.error || 'Unable to cancel order.',
    };
  }

  await recordAudit({
    req,
    actorType: actor,
    actorId,
    action: ACTIONS.ORDER_CANCELLED,
    entityType: 'order',
    entityId: String(orderId),
    oldValue: result?.previous_state || null,
    newValue: `cancelled:${String(reason || '').slice(0, 100)}`,
  });

  // Re-read rather than trusting the RPC payload: the in-memory test double
  // and a future change to the function's return shape both go through here,
  // and the money columns are the one thing that must be right.
  const order = await loadOrderForRefund(orderId);

  if (!refundRequired) {
    if (order && order.paid_at) {
      // Cancelled after payment was attempted but before the charge cleared —
      // nothing to refund, but the customer still deserves to be told.
      await notifyCustomerCancelled({
        order,
        reason,
        refundAmountBani: 0,
        cancelledBy: actor,
      });
    }
    return { ok: true, refund: null };
  }

  if (!order) {
    return { ok: true, refund: null };
  }

  // Told before the refund runs, not after: "cancelled, money on its way" is
  // the message, and it must not wait on Stripe to be true.
  await notifyCustomerCancelled({
    order,
    reason,
    refundAmountBani:
      toBani(order.products_subtotal_bani) +
      toBani(order.delivery_fee_bani) +
      toBani(order.commission_bani),
    cancelledBy: actor,
  });

  const refund = await issueRefund({
    req,
    order,
    reason: reason || 'Order cancelled',
    actorType: actor,
    actorId,
  });

  return { ok: true, refund };
};

module.exports = {
  REFUND_STATES,
  ORDER_REFUND_STATES,
  ORDER_MONEY_COLUMNS,
  loadOrderForRefund,
  claimRefund,
  withholdFarmerShare,
  reverseFarmerTransfer,
  refundCustomer,
  issueRefund,
  cancelPaidOrder,
};
