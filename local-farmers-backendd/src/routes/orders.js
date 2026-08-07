const express = require('express');

const { requireAuth } = require('../middleware/auth');
const { supabase, TABLES } = require('../lib/supabase');
const {
  RATING_ORDER_STATES,
  recalculateAndPersistProductRatings,
} = require('../lib/productRating');
const {
  ORDER_STATES,
  actorForRole,
  allowedTransitions,
  evaluateTransition,
} = require('../lib/orderState');
const { ACTIONS, recordAudit } = require('../lib/audit');
const { cancelPaidOrder } = require('../lib/refunds');
const { notifyCustomerOrderState } = require('../lib/notifications');
const { recordFulfilment } = require('../lib/fulfilment');

const router = express.Router();

const MAX_REPLY_LENGTH = 1200;

const ORDER_COLUMNS = [
  'id',
  'farmer_id',
  'client_id',
  'order_state',
  'total_price',
  'created_at',
  'updated_at',
  // Money frozen at placement time. An `orders` row is one farmer's group
  // inside a `checkouts` payment, and these five columns are what that group
  // was worth on the day it was placed — a later fee or rate change never
  // rewrites them.
  'checkout_id',
  'products_subtotal_bani',
  'delivery_fee_bani',
  'commission_bani',
  'commission_bps',
  'transfer_amount_bani',
  'transfer_state',
  'paid_at',
  // OPS-01b — what has gone back, so the card can say so without a join.
  'refund_state',
  'refunded_bani',
  'cancelled_at',
  'cancelled_by',
  'cancel_reason',
].join(', ');

const ORDER_ITEM_COLUMNS = [
  'id',
  'order_id',
  'product_id',
  'product_name',
  'product_unit',
  'quantity',
  'unit_price',
  'line_total',
  'created_at',
  'updated_at',
  // OPS-06 — what was ordered stays `quantity`; this is what arrived.
  'fulfilled_quantity',
].join(', ');

const ORDER_REPLY_COLUMNS = [
  'id',
  'order_id',
  'sender_user_id',
  'message',
  'created_at',
].join(', ');

const PRODUCT_COLUMNS = [
  'id',
  'farmer_id',
  '"product name"',
  'Unit',
  'Price',
  'available',
  'instant_buy',
].join(', ');

const PENDING_STATES = ['placed_order', 'pending_order'];
const ACTIVE_STATES = ['received_by_farmer', 'preparing_order', 'in_transit', 'arrived'];
const HISTORY_STATES = ['received', 'cancelled'];

const ORDER_BUCKETS = {
  pending: PENDING_STATES,
  active: ACTIVE_STATES,
  history: HISTORY_STATES,
};

// Payment is no longer a per-order action: the whole cart is paid once, from
// the cart summary, so "Pay & Place order" is gone from here. What remains
// per order is what a single farmer group can still do on its own — and which
// of those moves are legal is decided by `lib/orderState.js`, not here.

const resolveArray = (value) => (Array.isArray(value) ? value : []);

const normalizeIdentifier = (value) => {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value).trim();
};

const normalizeReplyText = (value) => {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim().slice(0, MAX_REPLY_LENGTH);
};

const toNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return parsed;
};

const normalizeQuantity = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Number(parsed.toFixed(2));
};

const formatMoney = (value) => Number(toNumber(value, 0).toFixed(2));

const toPartnerForCustomer = (order, farmersById) => {
  const farmer = farmersById.get(order.farmerId) || null;
  return {
    id: order.farmerId,
    role: 'vendor',
    title: farmer?.farmName || farmer?.displayName || 'Farmer',
    subtitle: [farmer?.city, farmer?.county].filter(Boolean).join(', '),
  };
};

const toPartnerForVendor = (order, usersById, customersById) => {
  const user = usersById.get(order.clientId) || null;
  const customer = customersById.get(order.clientId) || null;
  const customerName = [customer?.name, customer?.surname]
    .filter(Boolean)
    .join(' ')
    .trim();

  return {
    id: order.clientId,
    role: 'customer',
    title: customerName || user?.username || 'Customer',
    subtitle: [customer?.city, customer?.county].filter(Boolean).join(', '),
  };
};

const toBaniValue = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : 0;
};

const mapOrderRow = (row) => ({
  id: normalizeIdentifier(row.id),
  farmerId: normalizeIdentifier(row.farmer_id),
  clientId: normalizeIdentifier(row.client_id),
  orderState: row.order_state || 'placed_order',
  totalPrice: formatMoney(row.total_price),
  createdAt: row.created_at || null,
  updatedAt: row.updated_at || null,
  checkoutId: normalizeIdentifier(row.checkout_id),
  productsSubtotalBani: toBaniValue(row.products_subtotal_bani),
  deliveryFeeBani: toBaniValue(row.delivery_fee_bani),
  commissionBani: toBaniValue(row.commission_bani),
  commissionBps: toBaniValue(row.commission_bps),
  transferAmountBani: toBaniValue(row.transfer_amount_bani),
  transferState: row.transfer_state || 'none',
  paidAt: row.paid_at || null,
  refundState: row.refund_state || 'none',
  refundedBani: toBaniValue(row.refunded_bani),
  cancelledAt: row.cancelled_at || null,
  cancelledBy: row.cancelled_by || null,
  cancelReason: row.cancel_reason || '',
});

const mapOrderItemRow = (row) => ({
  id: normalizeIdentifier(row.id),
  orderId: normalizeIdentifier(row.order_id),
  productId: normalizeIdentifier(row.product_id),
  productName: row.product_name || '',
  productUnit: row.product_unit || '',
  quantity: toNumber(row.quantity, 0),
  unitPrice: formatMoney(row.unit_price),
  lineTotal: formatMoney(row.line_total),
  fulfilledQuantity:
    row.fulfilled_quantity === null || row.fulfilled_quantity === undefined
      ? null
      : toNumber(row.fulfilled_quantity, 0),
  createdAt: row.created_at || null,
  updatedAt: row.updated_at || null,
});

const mapOrderReplyRow = (row) => ({
  id: normalizeIdentifier(row.id),
  orderId: normalizeIdentifier(row.order_id),
  senderUserId: normalizeIdentifier(row.sender_user_id),
  message: row.message || '',
  createdAt: row.created_at || null,
});

const selectRowsByIds = async (table, columns, idColumn, ids, errorMessage) => {
  const filteredIds = resolveArray(ids)
    .map((value) => normalizeIdentifier(value))
    .filter(Boolean);

  if (filteredIds.length === 0) {
    return [];
  }

  const { data, error } = await supabase
    .from(table)
    .select(columns)
    .in(idColumn, filteredIds);

  if (error) {
    throw new Error(error.message || errorMessage);
  }
  return resolveArray(data);
};

const fetchVendorRecord = async (userId) => {
  const { data: farmer, error } = await supabase
    .from(TABLES.farmers)
    .select('id, "farm name", "display name", city, county')
    .eq('id', userId)
    .maybeSingle();

  if (error && error.code !== 'PGRST116') {
    throw new Error(error.message || 'Unable to load vendor profile.');
  }

  return farmer || null;
};

const canAccessOrder = (user, vendorRecord, order) => {
  if (!user || !order) {
    return false;
  }

  if (user.role === 'customer') {
    return order.clientId === normalizeIdentifier(user.id);
  }

  if (user.role === 'vendor') {
    return Boolean(vendorRecord && order.farmerId === normalizeIdentifier(vendorRecord.id));
  }

  return false;
};

const resolveAllowedActions = (role, orderState) =>
  allowedTransitions(actorForRole(role), orderState);

const fetchOrdersByStates = async ({ user, vendorRecord, states }) => {
  const safeStates = resolveArray(states).filter((state) => ORDER_STATES.includes(state));
  if (safeStates.length === 0) {
    return [];
  }

  let query = supabase
    .from(TABLES.orders)
    .select(ORDER_COLUMNS)
    .in('order_state', safeStates);

  if (user.role === 'customer') {
    query = query.eq('client_id', user.id);
  } else if (user.role === 'vendor') {
    if (!vendorRecord) {
      return [];
    }
    query = query.eq('farmer_id', vendorRecord.id);
    // Vendors should see unpaid orders (pending_order) but NOT carts (placed_order).
    query = query.neq('order_state', 'placed_order');
  } else {
    return [];
  }

  const { data, error } = await query
    .order('updated_at', { ascending: false })
    .order('created_at', { ascending: false });

  if (error) {
    throw new Error(error.message || 'Unable to load orders.');
  }

  return resolveArray(data).map(mapOrderRow);
};

const fetchOrderById = async (orderId) => {
  const id = normalizeIdentifier(orderId);
  if (!id) {
    return null;
  }

  const { data, error } = await supabase
    .from(TABLES.orders)
    .select(ORDER_COLUMNS)
    .eq('id', id)
    .maybeSingle();

  if (error) {
    throw new Error(error.message || 'Unable to load order.');
  }
  if (!data) {
    return null;
  }
  return mapOrderRow(data);
};

const fetchOrderDetails = async ({ orders, user }) => {
  const orderList = resolveArray(orders);
  if (orderList.length === 0) {
    return [];
  }

  const orderIds = orderList.map((entry) => entry.id);
  const farmerIds = [...new Set(orderList.map((entry) => entry.farmerId).filter(Boolean))];
  const clientIds = [...new Set(orderList.map((entry) => entry.clientId).filter(Boolean))];

  const [itemsRows, repliesRows, usersRows, customersRows, farmersRows] = await Promise.all([
    selectRowsByIds(
      TABLES.orderItems,
      ORDER_ITEM_COLUMNS,
      'order_id',
      orderIds,
      'Unable to load order items.',
    ),
    selectRowsByIds(
      TABLES.orderReplies,
      ORDER_REPLY_COLUMNS,
      'order_id',
      orderIds,
      'Unable to load order replies.',
    ),
    selectRowsByIds(
      TABLES.users,
      'id, username, email',
      'id',
      clientIds,
      'Unable to load users.',
    ),
    selectRowsByIds(
      TABLES.customers,
      'id, name, surname, city, county',
      'id',
      clientIds,
      'Unable to load customers.',
    ),
    selectRowsByIds(
      TABLES.farmers,
      'id, "farm name", "display name", city, county',
      'id',
      farmerIds,
      'Unable to load farmers.',
    ),
  ]);

  const itemsByOrderId = new Map();
  for (const item of resolveArray(itemsRows).map(mapOrderItemRow)) {
    const list = itemsByOrderId.get(item.orderId) || [];
    list.push(item);
    itemsByOrderId.set(item.orderId, list);
  }

  const repliesByOrderId = new Map();
  for (const reply of resolveArray(repliesRows).map(mapOrderReplyRow)) {
    const list = repliesByOrderId.get(reply.orderId) || [];
    list.push(reply);
    repliesByOrderId.set(reply.orderId, list);
  }
  for (const [orderId, replies] of repliesByOrderId.entries()) {
    replies.sort((a, b) => {
      const left = Date.parse(a.createdAt || '') || 0;
      const right = Date.parse(b.createdAt || '') || 0;
      return left - right;
    });
    repliesByOrderId.set(orderId, replies);
  }

  const usersById = new Map(
    resolveArray(usersRows).map((entry) => [normalizeIdentifier(entry.id), entry]),
  );
  const customersById = new Map(
    resolveArray(customersRows).map((entry) => [normalizeIdentifier(entry.id), entry]),
  );
  const farmersById = new Map(
    resolveArray(farmersRows).map((entry) => [
      normalizeIdentifier(entry.id),
      {
        id: normalizeIdentifier(entry.id),
        farmName: entry['farm name'] || '',
        displayName: entry['display name'] || '',
        city: entry.city || '',
        county: entry.county || '',
      },
    ]),
  );

  return orderList.map((order) => {
    const partner =
      user.role === 'customer'
        ? toPartnerForCustomer(order, farmersById)
        : toPartnerForVendor(order, usersById, customersById);

    const customer = customersById.get(order.clientId) || null;
    const customerUser = usersById.get(order.clientId) || null;
    const customerName = [customer?.name, customer?.surname]
      .filter(Boolean)
      .join(' ')
      .trim();
    const customerTitle = customerName || customerUser?.username || 'Customer';
    const farmerTitle =
      farmersById.get(order.farmerId)?.farmName ||
      farmersById.get(order.farmerId)?.displayName ||
      'Farmer';

    const replies = (repliesByOrderId.get(order.id) || []).map((reply) => ({
      id: reply.id,
      senderUserId: reply.senderUserId,
      senderName:
        reply.senderUserId === order.farmerId
          ? farmerTitle
          : reply.senderUserId === order.clientId
            ? customerTitle
            : usersById.get(reply.senderUserId)?.username || 'User',
      message: reply.message,
      createdAt: reply.createdAt,
      isOwn: reply.senderUserId === normalizeIdentifier(user.id),
    }));

    const items = (itemsByOrderId.get(order.id) || [])
      .slice()
      .sort((a, b) => {
        const left = Date.parse(a.createdAt || '') || 0;
        const right = Date.parse(b.createdAt || '') || 0;
        return left - right;
      })
      .map((item) => ({
        id: item.id,
        productId: item.productId,
        productName: item.productName,
        productUnit: item.productUnit,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        lineTotal: item.lineTotal,
        fulfilledQuantity: item.fulfilledQuantity,
      }));

    return {
      id: order.id,
      farmerId: order.farmerId,
      clientId: order.clientId,
      orderState: order.orderState,
      totalPrice: order.totalPrice,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
      checkoutId: order.checkoutId,
      productsSubtotalBani: order.productsSubtotalBani,
      deliveryFeeBani: order.deliveryFeeBani,
      commissionBani: order.commissionBani,
      commissionBps: order.commissionBps,
      transferAmountBani: order.transferAmountBani,
      transferState: order.transferState,
      paidAt: order.paidAt,
      refundState: order.refundState,
      refundedBani: order.refundedBani,
      cancelledAt: order.cancelledAt,
      cancelledBy: order.cancelledBy,
      cancelReason: order.cancelReason,
      partner,
      items,
      replies,
      allowedActions: resolveAllowedActions(user.role, order.orderState),
    };
  });
};

const fetchDetailedOrder = async ({ orderId, user, vendorRecord }) => {
  const order = await fetchOrderById(orderId);
  if (!order) {
    return null;
  }
  if (!canAccessOrder(user, vendorRecord, order)) {
    return null;
  }

  const details = await fetchOrderDetails({ orders: [order], user });
  return details[0] || null;
};

const requireCustomer = (req, res) => {
  if (req.user.role !== 'customer') {
    res.status(403).json({ error: 'Only customer accounts can place cart orders.' });
    return false;
  }
  return true;
};

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const bucketRaw = normalizeIdentifier(req.query.bucket || 'pending').toLowerCase();
    const bucket = bucketRaw || 'pending';
    const states = ORDER_BUCKETS[bucket];

    if (!states) {
      return res.status(400).json({ error: 'bucket must be pending, active, or history.' });
    }

    const vendorRecord =
      req.user.role === 'vendor' ? await fetchVendorRecord(req.user.id) : null;
    const orders = await fetchOrdersByStates({
      user: req.user,
      vendorRecord,
      states,
    });
    const detailedOrders = await fetchOrderDetails({
      orders,
      user: req.user,
    });

    return res.json({
      bucket,
      orders: detailedOrders,
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/cart/items', requireAuth, async (req, res, next) => {
  try {
    if (!requireCustomer(req, res)) {
      return null;
    }

    const productId = normalizeIdentifier(req.body?.productId);
    const quantity = normalizeQuantity(req.body?.quantity ?? 1);

    if (!productId) {
      return res.status(400).json({ error: 'productId is required.' });
    }
    if (quantity === null) {
      return res.status(400).json({ error: 'quantity must be a positive number.' });
    }

    const { data: product, error: productError } = await supabase
      .from(TABLES.products)
      .select(PRODUCT_COLUMNS)
      .eq('id', productId)
      .maybeSingle();
    if (productError) {
      return res.status(500).json({ error: productError.message || 'Unable to load product.' });
    }
    if (!product) {
      return res.status(404).json({ error: 'Product not found.' });
    }
    if (!product.instant_buy) {
      return res.status(400).json({
        error: 'This product is inquiry-only. Use Send inquiry to contact the farmer.',
      });
    }

    const isAvailable = product.available === true || Number(product.available) === 1;
    if (!isAvailable) {
      return res.status(400).json({ error: 'Product is not available right now.' });
    }

    const farmerId = normalizeIdentifier(product.farmer_id);
    if (!farmerId) {
      return res.status(400).json({ error: 'Product does not have a valid farmer.' });
    }

    // The catalog already hides these products, but the endpoint is what
    // actually enforces it: a stale tab or a direct call must not be able to
    // put an unpayable farm into a cart that we then cannot settle.
    const { data: farmerPayout, error: farmerPayoutError } = await supabase
      .from(TABLES.farmers)
      .select('id, charges_enabled, "farm name"')
      .eq('id', farmerId)
      .maybeSingle();

    if (farmerPayoutError) {
      return res.status(500).json({ error: 'Unable to verify the farm right now.' });
    }
    const farmerCanSell =
      farmerPayout?.charges_enabled === true ||
      farmerPayout?.charges_enabled === 1 ||
      farmerPayout?.charges_enabled === '1';
    if (!farmerCanSell) {
      return res.status(409).json({
        error: `${farmerPayout?.['farm name'] || 'This farm'} cannot receive payments yet, so its products cannot be bought.`,
      });
    }

    const { data: openOrders, error: openOrderError } = await supabase
      .from(TABLES.orders)
      .select(ORDER_COLUMNS)
      .eq('client_id', req.user.id)
      .eq('farmer_id', farmerId)
      .eq('order_state', 'placed_order')
      .order('created_at', { ascending: false })
      .limit(1);

    if (openOrderError) {
      return res
        .status(500)
        .json({ error: openOrderError.message || 'Unable to load cart order.' });
    }

    let orderRow = resolveArray(openOrders).map(mapOrderRow)[0] || null;
    if (!orderRow) {
      const { data: insertedOrder, error: insertOrderError } = await supabase
        .from(TABLES.orders)
        .insert({
          farmer_id: farmerId,
          client_id: req.user.id,
          order_state: 'placed_order',
        })
        .select(ORDER_COLUMNS)
        .single();

      if (insertOrderError || !insertedOrder) {
        return res.status(500).json({
          error: insertOrderError?.message || 'Unable to create cart order.',
        });
      }
      orderRow = mapOrderRow(insertedOrder);
    }

    const { data: existingItem, error: existingItemError } = await supabase
      .from(TABLES.orderItems)
      .select(ORDER_ITEM_COLUMNS)
      .eq('order_id', orderRow.id)
      .eq('product_id', productId)
      .maybeSingle();

    if (existingItemError && existingItemError.code !== 'PGRST116') {
      return res.status(500).json({
        error: existingItemError.message || 'Unable to load existing cart item.',
      });
    }

    const previousQuantity = toNumber(existingItem?.quantity, 0);
    const nextQuantity = Number((previousQuantity + quantity).toFixed(2));
    const unitPrice = formatMoney(product.Price);

    const upsertPayload = {
      order_id: orderRow.id,
      product_id: productId,
      product_name: product['product name'] || '',
      product_unit: product.Unit || 'unit',
      quantity: nextQuantity,
      unit_price: unitPrice,
    };

    const { error: upsertItemError } = await supabase
      .from(TABLES.orderItems)
      .upsert(upsertPayload, { onConflict: 'order_id,product_id' });
    if (upsertItemError) {
      return res
        .status(500)
        .json({ error: upsertItemError.message || 'Unable to update cart item.' });
    }

    const vendorRecord = null;
    const detailedOrder = await fetchDetailedOrder({
      orderId: orderRow.id,
      user: req.user,
      vendorRecord,
    });

    return res.status(201).json({
      order: detailedOrder,
      addedProduct: {
        id: productId,
        name: product['product name'] || '',
        quantityAdded: quantity,
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.patch('/:orderId/state', requireAuth, async (req, res, next) => {
  try {
    const orderId = normalizeIdentifier(req.params.orderId);
    const nextState = normalizeIdentifier(req.body?.nextState);
    const reason = String(req.body?.reason || '').trim().slice(0, 500);

    if (!orderId) {
      return res.status(400).json({ error: 'orderId is required.' });
    }

    const vendorRecord =
      req.user.role === 'vendor' ? await fetchVendorRecord(req.user.id) : null;
    const order = await fetchOrderById(orderId);
    if (!order) {
      return res.status(404).json({ error: 'Order not found.' });
    }
    if (!canAccessOrder(req.user, vendorRecord, order)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // One decision, one place. The route no longer knows the rules — it only
    // knows how to carry out whichever verdict comes back.
    const actor = actorForRole(req.user.role);
    const verdict = evaluateTransition({ actor, from: order.orderState, to: nextState });
    if (!verdict.ok) {
      return res.status(verdict.status).json({ error: verdict.error, code: verdict.code });
    }

    if (verdict.deletesRow) {
      // An untouched cart has no payment, no reserved stock and no accounting
      // trace, so it is removed outright rather than kept as a cancelled row.
      const { error: deleteError } = await supabase
        .from(TABLES.orders)
        .delete()
        .eq('id', orderId)
        .eq('order_state', 'placed_order');

      if (deleteError) {
        return res.status(500).json({ error: deleteError.message || 'Unable to delete cart.' });
      }

      return res.json({ order: { id: orderId, deleted: true } });
    }

    if (nextState === 'cancelled') {
      // OPS-01b — cancelling is never just a status write. The stock goes back
      // on the shelf and the money starts its way back to the customer, both
      // driven from one place so the two cannot diverge.
      const outcome = await cancelPaidOrder({
        req,
        orderId,
        actor,
        actorId: req.user.id,
        reason,
        refundRequired: verdict.refundRequired,
      });

      if (!outcome.ok) {
        return res.status(outcome.status || 500).json({
          error: outcome.error || 'Unable to cancel order.',
          code: outcome.code,
        });
      }

      const cancelledOrder = await fetchDetailedOrder({
        orderId,
        user: req.user,
        vendorRecord,
      });
      return res.json({ order: cancelledOrder, refund: outcome.refund || null });
    }

    const statePatch = { order_state: nextState };
    // OPS-04 — stamp the moment it reached the door. `updated_at` moves for
    // every write, so it cannot be the clock a deadline is measured against.
    if (nextState === 'arrived') {
      statePatch.arrived_at = new Date().toISOString();
    }

    const { error: updateError } = await supabase
      .from(TABLES.orders)
      .update(statePatch)
      .eq('id', orderId);
    if (updateError) {
      return res.status(500).json({ error: updateError.message || 'Unable to update order.' });
    }

    await recordAudit({
      req,
      actorType: actor,
      actorId: req.user.id,
      action: ACTIONS.ORDER_STATE_CHANGED,
      entityType: 'order',
      entityId: orderId,
      oldValue: order.orderState,
      newValue: nextState,
    });

    // OPS-02 — the customer is not sitting on the orders page waiting for a
    // Realtime event. Realtime only works while a tab is open.
    await notifyCustomerOrderState({
      order: { id: orderId, client_id: order.clientId, farmer_id: order.farmerId },
      state: nextState,
    });

    const includedBefore = RATING_ORDER_STATES.includes(order.orderState);
    const includedAfter = RATING_ORDER_STATES.includes(nextState);
    if (includedBefore !== includedAfter) {
      try {
        await recalculateAndPersistProductRatings({ supabase, tables: TABLES });
      } catch (ratingError) {
        console.error(
          '[ratings] Unable to recalculate product ratings after order state change:',
          ratingError,
        );
      }
    }

    const detailedOrder = await fetchDetailedOrder({
      orderId,
      user: req.user,
      vendorRecord,
    });
    return res.json({
      order: detailedOrder,
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/:orderId/replies', requireAuth, async (req, res, next) => {
  try {
    const orderId = normalizeIdentifier(req.params.orderId);
    const message = normalizeReplyText(req.body?.message);

    if (!orderId) {
      return res.status(400).json({ error: 'orderId is required.' });
    }
    if (!message) {
      return res.status(400).json({ error: 'message is required.' });
    }

    const vendorRecord =
      req.user.role === 'vendor' ? await fetchVendorRecord(req.user.id) : null;
    const order = await fetchOrderById(orderId);
    if (!order) {
      return res.status(404).json({ error: 'Order not found.' });
    }
    if (!canAccessOrder(req.user, vendorRecord, order)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { data: insertedReply, error: insertReplyError } = await supabase
      .from(TABLES.orderReplies)
      .insert({
        order_id: orderId,
        sender_user_id: req.user.id,
        message,
      })
      .select(ORDER_REPLY_COLUMNS)
      .single();

    if (insertReplyError || !insertedReply) {
      return res.status(500).json({
        error: insertReplyError?.message || 'Unable to add order reply.',
      });
    }

    return res.status(201).json({
      reply: {
        id: normalizeIdentifier(insertedReply.id),
        orderId: normalizeIdentifier(insertedReply.order_id),
        senderUserId: normalizeIdentifier(insertedReply.sender_user_id),
        message: insertedReply.message || '',
        createdAt: insertedReply.created_at || null,
      },
    });
  } catch (error) {
    return next(error);
  }
});

/**
 * OPS-06 + LOG-04 — record what actually went in the box.
 *
 * The finding was "a farmer with 3 of 5 kg can only decline the whole order".
 * Now they deliver the 3, record it, and the customer is refunded the
 * difference automatically — no complaint, no dispute, no waiting.
 *
 * Small differences are absorbed by the tolerance (±10% by default): a bag of
 * tomatoes is never exactly a kilo, and refunding 50 g would cost more in
 * Stripe fees than it returns.
 */
router.post('/:orderId/fulfilment', requireAuth, async (req, res, next) => {
  try {
    if (req.user.role !== 'vendor') {
      return res.status(403).json({ error: 'Only the farm can record what was delivered.' });
    }

    const orderId = normalizeIdentifier(req.params.orderId);
    const vendorRecord = await fetchVendorRecord(req.user.id);
    const order = await fetchOrderById(orderId);

    if (!order) {
      return res.status(404).json({ error: 'Order not found.' });
    }
    if (!canAccessOrder(req.user, vendorRecord, order)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Recording is part of handing the order over, so it belongs to the states
    // where that is happening. Before that there is nothing to weigh; after
    // `received` the customer has already confirmed what they got.
    if (!['preparing_order', 'in_transit', 'arrived'].includes(order.orderState)) {
      return res.status(409).json({
        error: 'You can record what was delivered while the order is being prepared or on its way.',
        code: 'wrong_state',
      });
    }

    const fulfilled = req.body?.fulfilled;
    if (fulfilled && typeof fulfilled !== 'object') {
      return res.status(400).json({ error: 'fulfilled must be a map of item id to quantity.' });
    }

    const result = await recordFulfilment({
      req,
      order: { id: orderId },
      fulfilled: fulfilled || {},
      actorId: req.user.id,
    });

    if (!result.ok) {
      return res.status(result.status || 500).json({ error: result.error, code: result.code });
    }

    const detailedOrder = await fetchDetailedOrder({ orderId, user: req.user, vendorRecord });
    return res.json({
      order: detailedOrder,
      fulfilment: {
        kind: result.evaluation.kind,
        shortfallBani: result.evaluation.shortfallBani,
        toleranceBps: result.evaluation.toleranceBps,
        lines: result.evaluation.lines,
      },
      refund: result.refund,
    });
  } catch (error) {
    return next(error);
  }
});

router.patch('/:orderId/items/:itemId', requireAuth, async (req, res, next) => {
  try {
    if (!requireCustomer(req, res)) {
      return null;
    }

    const orderId = normalizeIdentifier(req.params.orderId);
    const itemId = normalizeIdentifier(req.params.itemId);
    const quantityRaw = req.body?.quantity;

    if (!orderId || !itemId) {
      return res.status(400).json({ error: 'orderId and itemId are required.' });
    }

    const vendorRecord = null;
    const order = await fetchOrderById(orderId);
    if (!order) {
      return res.status(404).json({ error: 'Order not found.' });
    }
    if (!canAccessOrder(req.user, vendorRecord, order)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    if (order.orderState !== 'placed_order') {
      return res.status(400).json({ error: 'You can only modify quantities for items in your cart.' });
    }

    if (quantityRaw === 0 || quantityRaw === '0') {
      const { error: deleteError } = await supabase
        .from(TABLES.orderItems)
        .delete()
        .eq('id', itemId)
        .eq('order_id', orderId);

      if (deleteError) {
        return res.status(500).json({ error: deleteError.message || 'Unable to remove item.' });
      }
    } else {
      const quantity = normalizeQuantity(quantityRaw);
      if (quantity === null) {
        return res.status(400).json({ error: 'quantity must be a positive number or zero.' });
      }

      const { error: updateError } = await supabase
        .from(TABLES.orderItems)
        .update({ quantity })
        .eq('id', itemId)
        .eq('order_id', orderId);

      if (updateError) {
        return res.status(500).json({ error: updateError.message || 'Unable to update item quantity.' });
      }
    }

    const detailedOrder = await fetchDetailedOrder({
      orderId,
      user: req.user,
      vendorRecord,
    });
    return res.json({
      order: detailedOrder,
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
