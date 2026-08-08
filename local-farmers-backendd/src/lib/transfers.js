// Paying the farmers out — after the customer confirms the order arrived.
//
// Model: separate charges and transfers, with an escrow window in between.
// One `PaymentIntent` on the platform account for the whole cart, tagged with
// a `transfer_group` unique to the checkout. The farmer's share then sits on
// the platform balance, marked `held` against that specific order, until the
// customer confirms receipt (or the auto-confirm sweep does it for them).
// Only then does a `Transfer` move it to the farmer's Connect account.
//
// The platform is an intermediary for the length of that hold, and nothing
// more: every ban of a held amount is owed either to the farmer, once the
// order is confirmed, or back to the customer, if it never is. Holding it is
// what makes "you get your money back if it does not arrive" a mechanism
// rather than a promise — before this, the farmer already had the money and
// a refund meant clawing it back out of a balance they may have withdrawn.
//
// Idempotency has two layers, because a release can be triggered from three
// places (the customer confirming, an admin confirming, the auto-confirm
// sweep) and paying a farmer twice is our loss:
//   1. `order_transfers` has a unique key on `order_id`. The insert IS the
//      claim: whoever inserts first owns the transfer, everyone else sees
//      23505 and stops. A claim whose attempt failed can be taken back — see
//      `claimTransfer` — because the alternative is a payout that can never
//      be retried.
//   2. The Stripe call carries an idempotency key derived from the order id,
//      so even a crash between claim and call cannot produce two transfers.

const { supabase, TABLES } = require('./supabase');
const { stripe, stripeRequestId } = require('./stripeClient');
const { toBani, formatBani } = require('./money');
const { notifyFarmerTransferSent } = require('./notifications');

/** Transfer lifecycle, mirrored on `orders.transfer_state`. */
const TRANSFER_STATES = Object.freeze({
  NONE: 'none',
  /** Paid by the customer, held by the platform, not yet the farmer's. */
  HELD: 'held',
  PENDING: 'pending',
  SENT: 'sent',
  FAILED: 'failed',
  REVERSED: 'reversed',
  MANUAL_REQUIRED: 'manual_required',
});

/**
 * The one order state that releases money.
 *
 * Written as a constant rather than inlined because it is the entire policy:
 * a farmer is paid when, and only when, the order is confirmed received.
 */
const RELEASE_ORDER_STATE = 'received';

/** States whose money is still on the platform and could still move either way. */
const HOLDING_STATES = Object.freeze([
  TRANSFER_STATES.HELD,
  TRANSFER_STATES.PENDING,
  TRANSFER_STATES.FAILED,
]);

const ORDER_PAYOUT_COLUMNS = [
  'id',
  'farmer_id',
  'client_id',
  'checkout_id',
  'order_state',
  'transfer_amount_bani',
  'refunded_transfer_bani',
  'transfer_state',
  'stripe_transfer_id',
  'stripe_account_id',
  'refund_state',
  'paid_at',
].join(', ');

/**
 * What is actually owed to the farmer right now.
 *
 * `transfer_amount_bani` is what they were owed at placement. A partial
 * refund issued during the hold gave some of it back to the customer, and
 * `refunded_transfer_bani` is that amount. Paying the gross would mean the
 * platform funded the refund out of its own pocket.
 */
const releasableBani = (order) =>
  Math.max(0, toBani(order?.transfer_amount_bani) - toBani(order?.refunded_transfer_bani));

/**
 * Claim the right to transfer for this order.
 *
 * The insert IS the claim: `order_transfers.order_id` is unique, so exactly
 * one caller can own an order's payout. Returns false when somebody else
 * owns it. A failure to write is treated as "do not proceed": an unreleased
 * payout we can retry is recoverable, a double transfer is not.
 *
 * The one exception is a claim whose attempt failed. Leaving that in place
 * would be the wrong kind of safe — it makes the failure permanent, because
 * every retry would see 23505 and stop, and the farmer would never be paid.
 * So a `failed` claim can be taken back, with a compare-and-swap on the state
 * so that two retries racing still produce one owner. What stops that from
 * ever becoming a double payment is the Stripe idempotency key: it is derived
 * from the order id, so if the "failed" attempt did in fact create a transfer,
 * Stripe replays the original instead of making a second one.
 */
const claimTransfer = async ({ orderId, checkoutId, eventId, amountBani, destination }) => {
  const claim = {
    order_id: String(orderId),
    checkout_id: String(checkoutId),
    stripe_event_id: String(eventId || ''),
    amount_bani: toBani(amountBani),
    destination_account_id: String(destination),
    state: TRANSFER_STATES.PENDING,
  };

  const { error } = await supabase.from(TABLES.orderTransfers).insert(claim);
  if (!error) {
    return true;
  }
  if (error.code !== '23505') {
    throw new Error(error.message || 'Unable to claim transfer.');
  }

  const { data: retaken, error: retakeError } = await supabase
    .from(TABLES.orderTransfers)
    .update({
      state: TRANSFER_STATES.PENDING,
      // The amount can have moved since the failed attempt: a partial refund
      // may have been issued in between, and the retry must send today's
      // figure, not the one that failed.
      amount_bani: claim.amount_bani,
      destination_account_id: claim.destination_account_id,
      stripe_event_id: claim.stripe_event_id,
      last_error: null,
    })
    .eq('order_id', claim.order_id)
    .eq('state', TRANSFER_STATES.FAILED)
    .select('id');

  if (retakeError) {
    throw new Error(retakeError.message || 'Unable to reclaim transfer.');
  }

  return Array.isArray(retaken) && retaken.length > 0;
};

const markTransferResult = async ({
  orderId,
  state,
  stripeTransferId = null,
  errorText = null,
  releasedAt = null,
}) => {
  const now = new Date().toISOString();

  const { error: ledgerError } = await supabase
    .from(TABLES.orderTransfers)
    .update({
      state,
      stripe_transfer_id: stripeTransferId,
      last_error: errorText,
      completed_at: state === TRANSFER_STATES.SENT ? now : null,
    })
    .eq('order_id', String(orderId));
  if (ledgerError) {
    console.error('[transfers] Unable to update transfer ledger:', ledgerError.message);
  }

  const patch = {
    transfer_state: state,
    stripe_transfer_id: stripeTransferId,
    transfer_error: errorText,
  };
  if (state === TRANSFER_STATES.SENT) {
    patch.payout_released_at = releasedAt || now;
  }

  const { error: orderError } = await supabase
    .from(TABLES.orders)
    .update(patch)
    .eq('id', String(orderId));
  if (orderError) {
    console.error('[transfers] Unable to update order transfer state:', orderError.message);
  }
};

/**
 * The card cleared: move every farmer group on this checkout into escrow.
 *
 * `mark_checkout_paid` already does this in the same statement that marks the
 * groups paid. This re-asserts it because the webhook is also the recovery
 * path for a delivery that crashed halfway, and because an order that reaches
 * `received_by_farmer` with `transfer_state = 'none'` would be money nobody
 * is tracking. Writing `held` twice costs one update and is always correct.
 */
const holdCheckoutGroups = async ({ checkoutId }) => {
  const { data: orders, error } = await supabase
    .from(TABLES.orders)
    .select('id, order_state, transfer_state, transfer_amount_bani')
    .eq('checkout_id', String(checkoutId));

  if (error) {
    console.error(`[transfers] Unable to load groups for checkout ${checkoutId}:`, error.message);
    return { held: 0 };
  }

  const now = new Date().toISOString();
  let held = 0;

  for (const order of orders || []) {
    if (order.order_state === 'cancelled') {
      continue;
    }
    // Only `none` is promoted. A group already `held`, `sent` or `reversed`
    // has a decision recorded against it and this must not undo it.
    if (order.transfer_state !== TRANSFER_STATES.NONE) {
      continue;
    }

    const { error: updateError } = await supabase
      .from(TABLES.orders)
      .update({
        transfer_state: TRANSFER_STATES.HELD,
        payout_hold_started_at: now,
      })
      .eq('id', String(order.id))
      .eq('transfer_state', TRANSFER_STATES.NONE);

    if (updateError) {
      console.error(
        `[transfers] Unable to hold payout for order ${order.id}:`,
        updateError.message,
      );
      continue;
    }
    held += 1;
  }

  return { held };
};

/**
 * Send one farmer their share. Assumes the caller has already decided the
 * order is confirmed — `releaseOrderPayout` is that decision.
 *
 * `amountBani` is `products_subtotal + delivery_fee`, less anything already
 * refunded. The commission stays on the platform account and is never part
 * of the transfer.
 */
const transferToFarmer = async ({ order, checkout, eventId }) => {
  const orderId = String(order.id);
  const destination = String(order.stripe_account_id || '');
  const amountBani = releasableBani(order);

  if (!destination) {
    await markTransferResult({
      orderId,
      state: TRANSFER_STATES.MANUAL_REQUIRED,
      errorText: 'The farm had no Stripe Connect account when the payout was released.',
    });
    console.error(`[transfers] Order ${orderId} has no destination account — manual payout needed.`);
    return { transferred: false, reason: 'no_destination' };
  }

  if (amountBani <= 0) {
    // Fully refunded during the hold: there is nothing to send, and the order
    // must not be left looking as if a payout is still owed.
    await markTransferResult({ orderId, state: TRANSFER_STATES.REVERSED });
    return { transferred: false, reason: 'zero_amount' };
  }

  const claimed = await claimTransfer({
    orderId,
    checkoutId: checkout.id,
    eventId,
    amountBani,
    destination,
  });
  if (!claimed) {
    return { transferred: false, reason: 'already_claimed' };
  }

  try {
    const transfer = await stripe.transfers.create(
      {
        amount: amountBani,
        currency: 'ron',
        destination,
        transfer_group: String(checkout.transfer_group),
        // `source_transaction` is deliberately not set: the charge settles on
        // the platform balance first, and the transfer draws from that. Under
        // escrow the charge has had days to settle by the time we release, so
        // tying the two together buys nothing and only adds a failure mode.
        description: `Order ${orderId.slice(0, 8)} — Farmables`,
        metadata: {
          order_id: orderId,
          checkout_id: String(checkout.id),
          farmer_id: String(order.farmer_id),
          released_on: 'customer_confirmed_receipt',
        },
      },
      // One transfer per order, forever. Stripe replays the original response
      // instead of creating a second transfer.
      { idempotencyKey: `transfer-order-${orderId}` },
    );

    await markTransferResult({
      orderId,
      state: TRANSFER_STATES.SENT,
      stripeTransferId: transfer.id,
    });

    // OPS-02 — the farmer sees money arrive without having to open the app.
    await notifyFarmerTransferSent({ order, amountBani });

    return { transferred: true, transferId: transfer.id, amountBani };
  } catch (error) {
    const requestId = stripeRequestId(error);
    const detail = `${error?.code || error?.type || 'error'}: ${error?.message || 'unknown'}${
      requestId ? ` (req ${requestId})` : ''
    }`;

    // `failed` and not `manual_required`: every failure here is retryable by
    // the hourly sweep, including `balance_insufficient`, which only means
    // payouts left the platform account faster than charges settled.
    await markTransferResult({
      orderId,
      state: TRANSFER_STATES.FAILED,
      errorText: detail.slice(0, 500),
    });

    console.error(
      `[transfers] Order ${orderId}: transfer of ${formatBani(amountBani)} to ${destination} failed — ${detail}`,
    );
    return { transferred: false, reason: 'stripe_error', detail };
  }
};

const loadOrderForPayout = async (orderId) => {
  const { data, error } = await supabase
    .from(TABLES.orders)
    .select(ORDER_PAYOUT_COLUMNS)
    .eq('id', String(orderId))
    .maybeSingle();

  if (error && error.code !== 'PGRST116') {
    throw new Error(error.message || 'Unable to load order for payout.');
  }
  return data || null;
};

const loadCheckoutForPayout = async (checkoutId) => {
  if (!checkoutId) {
    return null;
  }
  const { data, error } = await supabase
    .from(TABLES.checkouts)
    .select('id, state, transfer_group, stripe_payment_intent_id')
    .eq('id', String(checkoutId))
    .maybeSingle();

  if (error && error.code !== 'PGRST116') {
    throw new Error(error.message || 'Unable to load payment for payout.');
  }
  return data || null;
};

/**
 * Release one order's held share to the farmer.
 *
 * This is the gate the whole escrow model rests on, so every precondition is
 * checked here rather than trusted from the caller — the three callers are a
 * route, a sweep and an admin action, and a bug in any one of them must not
 * be able to pay out an order that was never confirmed.
 *
 * Never throws. A payout that fails must be visible and retryable, not an
 * exception that unwinds a confirmation the customer has already been given.
 */
const releaseOrderPayout = async ({ order: given, orderId, eventId = null } = {}) => {
  const id = String(given?.id || orderId || '');
  if (!id) {
    return { released: false, reason: 'no_order' };
  }

  let order;
  try {
    // Always re-read. The caller's copy predates the state write that made
    // this order releasable, and the money columns are the one thing that
    // must be current.
    order = await loadOrderForPayout(id);
  } catch (error) {
    console.error(`[transfers] Could not load order ${id} for payout:`, error.message);
    return { released: false, reason: 'load_failed' };
  }

  if (!order) {
    return { released: false, reason: 'order_not_found' };
  }
  if (order.order_state !== RELEASE_ORDER_STATE) {
    // The whole policy in one line: unconfirmed orders do not pay out.
    return { released: false, reason: 'not_confirmed', orderState: order.order_state };
  }
  if (order.transfer_state === TRANSFER_STATES.SENT) {
    return { released: false, reason: 'already_sent' };
  }
  if (order.transfer_state === TRANSFER_STATES.REVERSED) {
    // The money went back to the customer. Confirming afterwards — an admin
    // resolving a dispute, say — must not resurrect the payout.
    return { released: false, reason: 'already_reversed' };
  }
  if (order.transfer_state === TRANSFER_STATES.NONE) {
    // Never paid for. Reaching `received` without a charge is a data problem,
    // not a payout, and paying out against it would be inventing money.
    return { released: false, reason: 'never_paid' };
  }
  if (order.refund_state === 'pending') {
    // A refund is mid-flight. Whoever wins the race decides where the money
    // goes, and the refund got there first.
    return { released: false, reason: 'refund_in_flight' };
  }

  const checkout = await loadCheckoutForPayout(order.checkout_id);
  if (!checkout) {
    console.error(`[transfers] Order ${id} has no checkout — cannot release payout.`);
    return { released: false, reason: 'no_checkout' };
  }
  if (checkout.state !== 'paid') {
    return { released: false, reason: 'checkout_not_paid', checkoutState: checkout.state };
  }

  const result = await transferToFarmer({ order, checkout, eventId });
  return {
    released: Boolean(result.transferred),
    reason: result.reason || null,
    transferId: result.transferId || null,
    amountBani: result.amountBani ?? releasableBani(order),
    detail: result.detail || null,
  };
};

/**
 * Retry the releases that did not go through.
 *
 * Run hourly from `orderMaintenance`. Everything it picks up is an order the
 * customer already confirmed, so the decision to pay is settled — this only
 * repeats a Stripe call that failed, most often because the platform balance
 * had not caught up with the charges yet.
 */
const retryStalePayouts = async ({ limit = 100 } = {}) => {
  const { data, error } = await supabase
    .from(TABLES.orders)
    .select('id')
    .eq('order_state', RELEASE_ORDER_STATE)
    .in('transfer_state', [TRANSFER_STATES.HELD, TRANSFER_STATES.PENDING, TRANSFER_STATES.FAILED])
    .limit(limit);

  if (error) {
    console.error('[transfers] Could not load payouts to retry:', error.message);
    return { attempted: 0, sent: 0, failed: 0 };
  }

  const summary = { attempted: 0, sent: 0, failed: 0 };

  for (const row of data || []) {
    summary.attempted += 1;
    const result = await releaseOrderPayout({ orderId: row.id });
    if (result.released) {
      summary.sent += 1;
    } else if (result.reason === 'stripe_error' || result.reason === 'no_destination') {
      summary.failed += 1;
    }
  }

  return summary;
};

/**
 * How much of the customers' money the platform is currently sitting on.
 *
 * Surfaced in `/api/health/diagnostics`: the number should track open orders
 * and nothing else. A large held balance against terminal orders means the
 * release path is stuck, and that is money owed to somebody.
 */
const heldPayoutSummary = async () => {
  const { data, error } = await supabase
    .from(TABLES.orders)
    .select('id, order_state, transfer_state, transfer_amount_bani, refunded_transfer_bani')
    .in('transfer_state', HOLDING_STATES)
    .limit(1000);

  if (error) {
    return { heldOrders: 0, heldBani: 0, stuckOrders: 0 };
  }

  const rows = data || [];
  return {
    heldOrders: rows.length,
    heldBani: rows.reduce((sum, row) => sum + releasableBani(row), 0),
    // Held money on an order that has already finished, in either direction.
    stuckOrders: rows.filter((row) => ['received', 'cancelled'].includes(row.order_state)).length,
  };
};

module.exports = {
  TRANSFER_STATES,
  RELEASE_ORDER_STATE,
  HOLDING_STATES,
  releasableBani,
  claimTransfer,
  markTransferResult,
  holdCheckoutGroups,
  transferToFarmer,
  releaseOrderPayout,
  retryStalePayouts,
  heldPayoutSummary,
};
