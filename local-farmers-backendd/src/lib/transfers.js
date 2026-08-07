// Paying the farmers out, immediately after the card clears.
//
// Model: separate charges and transfers. One `PaymentIntent` on the platform
// account for the whole cart, tagged with a `transfer_group` unique to the
// checkout, then one `Transfer` per farmer to their Connect account. The
// money is with the farmer within seconds of the payment — the platform never
// holds it, which is the entire point of LEG-01.
//
// Idempotency has two layers, because Stripe retries webhooks until it gets a
// 2xx and a retry that pays a farmer twice is our loss:
//   1. `order_transfers` has a unique key on `order_id`. The insert IS the
//      claim: whoever inserts first owns the transfer, everyone else sees
//      23505 and stops.
//   2. The Stripe call carries an idempotency key derived from the order id,
//      so even a crash between claim and call cannot produce two transfers.

const { supabase, TABLES } = require('./supabase');
const { stripe, stripeRequestId } = require('./stripeClient');
const { toBani, formatBani } = require('./money');
const { notifyFarmerTransferSent } = require('./notifications');

/** Transfer lifecycle, mirrored on `orders.transfer_state`. */
const TRANSFER_STATES = Object.freeze({
  NONE: 'none',
  PENDING: 'pending',
  SENT: 'sent',
  FAILED: 'failed',
  REVERSED: 'reversed',
  MANUAL_REQUIRED: 'manual_required',
});

/**
 * Claim the right to transfer for this order.
 *
 * Returns false when another delivery of the same event already claimed it.
 * A failure to write is treated as "do not proceed": an untransferred order
 * we can retry is recoverable, a double transfer is not.
 */
const claimTransfer = async ({ orderId, checkoutId, eventId, amountBani, destination }) => {
  const { error } = await supabase.from(TABLES.orderTransfers).insert({
    order_id: String(orderId),
    checkout_id: String(checkoutId),
    stripe_event_id: String(eventId || ''),
    amount_bani: toBani(amountBani),
    destination_account_id: String(destination),
    state: TRANSFER_STATES.PENDING,
  });

  if (!error) {
    return true;
  }
  if (error.code === '23505') {
    return false;
  }
  throw new Error(error.message || 'Unable to claim transfer.');
};

const markTransferResult = async ({ orderId, state, stripeTransferId = null, errorText = null }) => {
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

  const { error: orderError } = await supabase
    .from(TABLES.orders)
    .update({
      transfer_state: state,
      stripe_transfer_id: stripeTransferId,
      transfer_error: errorText,
    })
    .eq('id', String(orderId));
  if (orderError) {
    console.error('[transfers] Unable to update order transfer state:', orderError.message);
  }
};

/**
 * Send one farmer their share.
 *
 * `amountBani` is `products_subtotal + delivery_fee` — the commission stays on
 * the platform account and is never part of the transfer.
 */
const transferToFarmer = async ({ order, checkout, eventId }) => {
  const orderId = String(order.id);
  const destination = String(order.stripe_account_id || '');
  const amountBani = toBani(order.transfer_amount_bani);

  if (!destination) {
    await markTransferResult({
      orderId,
      state: TRANSFER_STATES.MANUAL_REQUIRED,
      errorText: 'Fermierul nu are cont Stripe Connect la momentul transferului.',
    });
    console.error(`[transfers] Order ${orderId} has no destination account — manual payout needed.`);
    return { transferred: false, reason: 'no_destination' };
  }

  if (amountBani <= 0) {
    await markTransferResult({ orderId, state: TRANSFER_STATES.SENT });
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
        // the platform balance first, and the transfer draws from that. Setting
        // it would tie the transfer to the charge's own availability date and
        // delay the farmer's money by days.
        description: `Comanda ${orderId.slice(0, 8)} — Farmables`,
        metadata: {
          order_id: orderId,
          checkout_id: String(checkout.id),
          farmer_id: String(order.farmer_id),
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

    // Insufficient platform balance is the one failure that is not a bug: it
    // means payouts left the platform account faster than charges settled.
    // It is retryable, so it stays `failed`, not `manual_required`.
    const state =
      error?.code === 'balance_insufficient'
        ? TRANSFER_STATES.FAILED
        : TRANSFER_STATES.FAILED;

    await markTransferResult({ orderId, state, errorText: detail.slice(0, 500) });

    console.error(
      `[transfers] Order ${orderId}: transfer of ${formatBani(amountBani)} to ${destination} failed — ${detail}`,
    );
    return { transferred: false, reason: 'stripe_error', detail };
  }
};

/**
 * Pay out every farmer group on a paid checkout.
 *
 * Never throws: one farmer's failed transfer must not stop the others, and
 * must not make us return non-2xx to Stripe and get the whole event replayed.
 * Failures are recorded on the order and reported back to the caller.
 */
const transferCheckoutGroups = async ({ checkoutId, eventId }) => {
  const { data: checkout, error: checkoutError } = await supabase
    .from(TABLES.checkouts)
    .select('id, transfer_group, state, client_id')
    .eq('id', String(checkoutId))
    .maybeSingle();

  if (checkoutError || !checkout) {
    console.error(`[transfers] Checkout ${checkoutId} not found for payout.`);
    return { attempted: 0, sent: 0, failed: 0 };
  }

  const { data: orders, error: ordersError } = await supabase
    .from(TABLES.orders)
    .select('id, farmer_id, transfer_amount_bani, stripe_account_id, transfer_state, order_state')
    .eq('checkout_id', String(checkoutId));

  if (ordersError) {
    console.error(`[transfers] Unable to load groups for checkout ${checkoutId}:`, ordersError.message);
    return { attempted: 0, sent: 0, failed: 0 };
  }

  const summary = { attempted: 0, sent: 0, failed: 0, skipped: 0 };

  for (const order of orders || []) {
    // A group the farmer already declined, or one already paid out, is skipped.
    if (order.order_state === 'cancelled' || order.transfer_state === TRANSFER_STATES.SENT) {
      summary.skipped += 1;
      continue;
    }

    summary.attempted += 1;
    const result = await transferToFarmer({ order, checkout, eventId });
    if (result.transferred) {
      summary.sent += 1;
    } else if (result.reason === 'stripe_error' || result.reason === 'no_destination') {
      summary.failed += 1;
    } else {
      summary.skipped += 1;
    }
  }

  return summary;
};

module.exports = {
  TRANSFER_STATES,
  claimTransfer,
  markTransferResult,
  transferToFarmer,
  transferCheckoutGroups,
};
