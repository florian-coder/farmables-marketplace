// The bridge between "this happened" and "queue an email".
//
// Route code should not know recipient lookup, event-key conventions or
// debounce windows. It calls one function per event, and every one of them
// returns without throwing — a notification is never allowed to fail the
// thing it is describing.
//
// Every function derives its own `event_key` from the fact, so the same event
// arriving twice (a Stripe webhook redelivery, a redirect racing the webhook)
// queues one message, not two.

const { supabase, TABLES } = require('./supabase');
const { notify } = require('./outbox');
const { toBani } = require('./money');

/** The address we can actually reach a user at, or '' if there is not one. */
const emailForUser = async (userId) => {
  const id = String(userId || '').trim();
  if (!id) {
    return '';
  }
  const { data, error } = await supabase
    .from(TABLES.users)
    .select('email')
    .eq('id', id)
    .maybeSingle();

  if (error || !data) {
    return '';
  }
  const email = String(data.email || '').trim();
  // SEC-09b — the legacy auto-generated addresses do not exist. Sending to
  // them is not a delivery failure to retry, it is a message with no reader.
  if (!email || email.endsWith('@localfarmers.app')) {
    return '';
  }
  return email;
};

const nameForCustomer = async (userId) => {
  const { data } = await supabase
    .from(TABLES.customers)
    .select('name, surname')
    .eq('id', String(userId))
    .maybeSingle();
  return [data?.name, data?.surname].filter(Boolean).join(' ').trim();
};

const farmNameFor = async (farmerId) => {
  const { data } = await supabase
    .from(TABLES.farmers)
    .select('"farm name", "display name"')
    .eq('id', String(farmerId))
    .maybeSingle();
  return data?.['farm name'] || data?.['display name'] || 'the farm';
};

/** A farmer has a new paid order. The single most time-critical message. */
const notifyFarmerNewOrder = async ({ order, items = [] }) => {
  const to = await emailForUser(order.farmer_id);
  if (!to) return;

  const [farmName, customerName] = await Promise.all([
    farmNameFor(order.farmer_id),
    nameForCustomer(order.client_id),
  ]);

  notify({
    eventKey: `order-new:${order.id}`,
    template: 'order.new.farmer',
    to,
    userId: String(order.farmer_id),
    payload: {
      orderId: String(order.id),
      farmName,
      customerName,
      items: items.map((item) => ({
        name: item.product_name || '',
        unit: item.product_unit || '',
        quantity: Number(item.quantity || 0),
        lineTotalBani: Math.round(Number(item.line_total || 0) * 100),
      })),
      totalBani: toBani(order.transfer_amount_bani),
      deliveryFeeBani: toBani(order.delivery_fee_bani),
    },
  });
};

/**
 * The distance-contract confirmation, on a durable medium.
 *
 * Required by GEO 34/2014 art. 8: the trader confirms the contract with the
 * full price breakdown. This is the one email in the system that is a legal
 * obligation rather than a courtesy.
 */
const notifyCustomerOrderConfirmed = async ({ checkout, orders = [], acceptedTerms = [] }) => {
  const to = await emailForUser(checkout.client_id);
  if (!to) return;

  const groups = await Promise.all(
    orders.map(async (order) => ({
      farmName: await farmNameFor(order.farmer_id),
      productsSubtotalBani: toBani(order.products_subtotal_bani),
      deliveryFeeBani: toBani(order.delivery_fee_bani),
      commissionBani: toBani(order.commission_bani),
    })),
  );

  notify({
    eventKey: `checkout-confirmed:${checkout.id}`,
    template: 'order.confirmation.customer',
    to,
    userId: String(checkout.client_id),
    payload: {
      checkoutId: String(checkout.id),
      groups,
      productsSubtotalBani: toBani(checkout.products_subtotal_bani),
      deliveryFeeBani: toBani(checkout.delivery_fee_total_bani),
      commissionBani: toBani(checkout.commission_total_bani),
      totalBani: toBani(checkout.total_bani),
      acceptedTerms,
    },
  });
};

/** Order moved along. Cancellations have their own, richer message. */
const notifyCustomerOrderState = async ({ order, state }) => {
  if (state === 'cancelled' || state === 'received_by_farmer') {
    // `cancelled` is covered by the cancellation email; `received_by_farmer`
    // is what the payment confirmation already told them.
    return;
  }
  const to = await emailForUser(order.client_id);
  if (!to) return;

  notify({
    eventKey: `order-state:${order.id}:${state}`,
    template: 'order.state.customer',
    to,
    userId: String(order.client_id),
    payload: {
      orderId: String(order.id),
      farmName: await farmNameFor(order.farmer_id),
      state,
    },
  });
};

/** Cancelled — and, in the same breath, where the money went. */
const notifyCustomerCancelled = async ({ order, reason, refundAmountBani, cancelledBy }) => {
  const to = await emailForUser(order.client_id);
  if (!to) return;

  notify({
    eventKey: `order-cancelled:${order.id}`,
    template: 'order.cancelled.customer',
    to,
    userId: String(order.client_id),
    payload: {
      orderId: String(order.id),
      farmName: await farmNameFor(order.farmer_id),
      reason: String(reason || ''),
      refundAmountBani: toBani(refundAmountBani),
      cancelledBy,
    },
  });
};

const notifyCustomerRefundCompleted = async ({ order, refundId, amountBani, isPartial }) => {
  const to = await emailForUser(order.client_id);
  if (!to) return;

  notify({
    // Keyed on the refund, not the order: a partial refund followed by
    // another one is two facts, and the customer should hear about both.
    eventKey: `refund-completed:${refundId}`,
    template: 'refund.completed.customer',
    to,
    userId: String(order.client_id),
    payload: { orderId: String(order.id), amountBani: toBani(amountBani), isPartial },
  });
};

const notifyFarmerTransferSent = async ({ order, amountBani }) => {
  const to = await emailForUser(order.farmer_id);
  if (!to) return;

  notify({
    eventKey: `transfer-sent:${order.id}`,
    template: 'transfer.sent.farmer',
    to,
    userId: String(order.farmer_id),
    payload: { orderId: String(order.id), amountBani: toBani(amountBani) },
  });
};

/**
 * A new chat message, at most one email per conversation per 15 minutes.
 *
 * The debounce is the event key, not a timer: rounding the clock down to a
 * 15-minute bucket means the second message in the same bucket hits the
 * unique index and is dropped. No state to keep, and it survives a restart.
 */
const CHAT_DEBOUNCE_MINUTES = 15;

const notifyChatMessage = async ({ conversationId, recipientUserId, senderName, preview }) => {
  const to = await emailForUser(recipientUserId);
  if (!to) return;

  const bucket = Math.floor(Date.now() / (CHAT_DEBOUNCE_MINUTES * 60 * 1000));

  notify({
    eventKey: `chat:${conversationId}:${recipientUserId}:${bucket}`,
    template: 'chat.message',
    to,
    userId: String(recipientUserId),
    payload: {
      senderName: senderName || 'Someone',
      preview: String(preview || '').slice(0, 140),
    },
    // A short delay so a burst of messages arrives as one email describing
    // the conversation, rather than one about its first line.
    delayMinutes: 2,
  });
};

const notifyFarmApproved = async ({ userId, farmName }) => {
  const to = await emailForUser(userId);
  if (!to) return;
  notify({
    eventKey: `farm-approved:${userId}`,
    template: 'farm.approved',
    to,
    userId: String(userId),
    payload: { farmName },
  });
};

const notifyFarmRejected = async ({ userId, farmName, reviewNote }) => {
  const to = await emailForUser(userId);
  if (!to) return;
  notify({
    // Keyed with the note so a re-review after changes can be sent again.
    eventKey: `farm-rejected:${userId}:${String(reviewNote || '').slice(0, 40)}`,
    template: 'farm.rejected',
    to,
    userId: String(userId),
    payload: { farmName, reviewNote },
  });
};

const notifyConnectIncomplete = async ({ userId, farmName, requirementsDue = [] }) => {
  const to = await emailForUser(userId);
  if (!to) return;
  // Keyed by day: a farm that stays incomplete is nudged once a day, not once
  // per `account.updated` event, and Stripe sends plenty of those.
  const day = new Date().toISOString().slice(0, 10);
  notify({
    eventKey: `connect-incomplete:${userId}:${day}`,
    template: 'connect.incomplete.farmer',
    to,
    userId: String(userId),
    payload: { farmName, requirementsDue },
  });
};

const notifyAutoConfirmWarning = async ({ order, daysLeft }) => {
  const to = await emailForUser(order.client_id);
  if (!to) return;
  notify({
    eventKey: `autoconfirm-warning:${order.id}`,
    template: 'order.autoconfirm_warning.customer',
    to,
    userId: String(order.client_id),
    payload: {
      orderId: String(order.id),
      farmName: await farmNameFor(order.farmer_id),
      daysLeft,
    },
  });
};

/**
 * Every notification is fire-and-forget from the caller's point of view.
 *
 * `safely` is what makes that true even for the lookups above: a missing
 * `customers` row must not turn into a rejected promise inside a route that
 * has already answered the browser.
 */
const safely = (fn) => (...args) => {
  Promise.resolve()
    .then(() => fn(...args))
    .catch((error) => {
      console.error('[notify] Notification failed:', error?.message || error);
    });
};

module.exports = {
  emailForUser,
  CHAT_DEBOUNCE_MINUTES,
  notifyFarmerNewOrder: safely(notifyFarmerNewOrder),
  notifyCustomerOrderConfirmed: safely(notifyCustomerOrderConfirmed),
  notifyCustomerOrderState: safely(notifyCustomerOrderState),
  notifyCustomerCancelled: safely(notifyCustomerCancelled),
  notifyCustomerRefundCompleted: safely(notifyCustomerRefundCompleted),
  notifyFarmerTransferSent: safely(notifyFarmerTransferSent),
  notifyChatMessage: safely(notifyChatMessage),
  notifyFarmApproved: safely(notifyFarmApproved),
  notifyFarmRejected: safely(notifyFarmRejected),
  notifyConnectIncomplete: safely(notifyConnectIncomplete),
  notifyAutoConfirmWarning: safely(notifyAutoConfirmWarning),
};
