// The farmer's money, as it actually moves now.
//
// BIZ-02 is gone: there is no monthly payout run, no manual bank transfer and
// no reconciliation spreadsheet. Each order's share reaches the farmer's own
// Stripe account within seconds of the customer paying, and Stripe pays it on
// to their bank on its own schedule. This page reports what happened; it no
// longer promises anything about the end of the month.

const express = require('express');

const { requireVendor } = require('../middleware/auth');
const { supabase, TABLES } = require('../lib/supabase');
const { toBani } = require('../lib/money');
const { refreshConnectState } = require('../lib/connect');

const router = express.Router();

/** States in which the customer has paid and the money is the farmer's. */
const PAID_STATES = [
  'received_by_farmer',
  'preparing_order',
  'in_transit',
  'arrived',
  'received',
];

const MONTHS_IN_CHART = 6;
const MONTHS_IN_WINDOW = 12;
const MAX_ORDERS_READ = 2000;
const TOP_PRODUCTS = 5;

const MONTH_NAMES = [
  'ianuarie', 'februarie', 'martie', 'aprilie', 'mai', 'iunie',
  'iulie', 'august', 'septembrie', 'octombrie', 'noiembrie', 'decembrie',
];

const parseDate = (value) => {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const monthKeyOf = (date) =>
  `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;

const monthLabelOf = (monthKey) => {
  const [year, month] = monthKey.split('-');
  return `${MONTH_NAMES[Number(month) - 1]} ${year}`;
};

const shortMonthLabelOf = (monthKey) => {
  const [, month] = monthKey.split('-');
  return MONTH_NAMES[Number(month) - 1].slice(0, 3);
};

const emptyBucket = (monthKey) => ({
  month: monthKey,
  label: monthLabelOf(monthKey),
  shortLabel: shortMonthLabelOf(monthKey),
  totalBani: 0,
  transferredBani: 0,
  inTransitBani: 0,
  orderCount: 0,
});

const recentMonthKeys = (reference, count) => {
  const keys = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    keys.push(
      monthKeyOf(
        new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth() - offset, 1)),
      ),
    );
  }
  return keys;
};

const selectRowsByIds = async (table, columns, idColumn, ids) => {
  const filtered = [...new Set(ids.map((value) => String(value || '').trim()).filter(Boolean))];
  if (filtered.length === 0) {
    return [];
  }
  const { data, error } = await supabase.from(table).select(columns).in(idColumn, filtered);
  if (error) {
    throw new Error(error.message || `Unable to load ${table}.`);
  }
  return Array.isArray(data) ? data : [];
};

const emptyPayload = (reference, payouts) => ({
  currency: 'lei',
  profileApproved: false,
  payouts,
  summary: {
    month: monthKeyOf(reference),
    label: monthLabelOf(monthKeyOf(reference)),
    totalBani: 0,
    transferredBani: 0,
    inTransitBani: 0,
    failedBani: 0,
    orderCount: 0,
    customerCount: 0,
    averageOrderBani: 0,
  },
  months: recentMonthKeys(reference, MONTHS_IN_CHART).map(emptyBucket),
  orders: [],
  topProducts: [],
  window: { months: MONTHS_IN_WINDOW, totalBani: 0, orderCount: 0 },
});

router.get('/', requireVendor, async (req, res, next) => {
  try {
    const now = new Date();
    const currentMonth = monthKeyOf(now);

    const { data: farmer, error: farmerError } = await supabase
      .from(TABLES.farmers)
      .select('id')
      .eq('id', req.user.id)
      .maybeSingle();
    if (farmerError && farmerError.code !== 'PGRST116') {
      return res.status(500).json({ error: farmerError.message || 'Unable to load farm profile.' });
    }

    // Payout state doubles as the empty-state explanation: a farmer with no
    // Stripe account needs to be told that, not shown a zero.
    const payouts = farmer ? await refreshConnectState(farmer.id) : null;

    if (!farmer) {
      return res.json(emptyPayload(now, payouts));
    }

    const windowStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (MONTHS_IN_WINDOW - 1), 1),
    ).toISOString();

    const { data: orderRows, error: ordersError } = await supabase
      .from(TABLES.orders)
      .select(
        'id, client_id, order_state, created_at, paid_at, checkout_id, products_subtotal_bani, delivery_fee_bani, commission_bani, transfer_amount_bani, transfer_state, stripe_transfer_id',
      )
      .eq('farmer_id', farmer.id)
      .in('order_state', PAID_STATES)
      .gte('created_at', windowStart)
      .order('created_at', { ascending: false })
      .limit(MAX_ORDERS_READ);
    if (ordersError) {
      return res.status(500).json({ error: ordersError.message || 'Unable to load orders.' });
    }

    const orders = (Array.isArray(orderRows) ? orderRows : []).map((row) => {
      const paidAt = parseDate(row.paid_at) || parseDate(row.created_at) || now;
      return {
        id: String(row.id || ''),
        clientId: String(row.client_id || ''),
        orderState: row.order_state || '',
        // What the farmer earns: products plus delivery, commission excluded.
        amountBani: toBani(row.transfer_amount_bani),
        productsSubtotalBani: toBani(row.products_subtotal_bani),
        deliveryFeeBani: toBani(row.delivery_fee_bani),
        commissionBani: toBani(row.commission_bani),
        transferState: row.transfer_state || 'none',
        stripeTransferId: row.stripe_transfer_id || null,
        paidAt,
        month: monthKeyOf(paidAt),
      };
    });

    const buckets = new Map(
      recentMonthKeys(now, MONTHS_IN_CHART).map((key) => [key, emptyBucket(key)]),
    );

    let windowTotalBani = 0;
    for (const order of orders) {
      windowTotalBani += order.amountBani;
      const bucket = buckets.get(order.month);
      if (!bucket) {
        continue;
      }
      bucket.totalBani += order.amountBani;
      bucket.orderCount += 1;
      if (order.transferState === 'sent') {
        bucket.transferredBani += order.amountBani;
      } else {
        bucket.inTransitBani += order.amountBani;
      }
    }

    const currentOrders = orders
      .filter((order) => order.month === currentMonth)
      .sort((left, right) => right.paidAt - left.paidAt);
    const currentBucket = buckets.get(currentMonth) || emptyBucket(currentMonth);

    const [customerRows, userRows, itemRows] = await Promise.all([
      selectRowsByIds(
        TABLES.customers,
        'id, name, surname, city, county',
        'id',
        currentOrders.map((order) => order.clientId),
      ),
      selectRowsByIds(
        TABLES.users,
        'id, username',
        'id',
        currentOrders.map((order) => order.clientId),
      ),
      selectRowsByIds(
        TABLES.orderItems,
        'order_id, product_name, product_unit, quantity, line_total',
        'order_id',
        currentOrders.map((order) => order.id),
      ),
    ]);

    const customersById = new Map(customerRows.map((row) => [String(row.id), row]));
    const usersById = new Map(userRows.map((row) => [String(row.id), row]));

    const itemCountByOrder = new Map();
    const productTotals = new Map();
    for (const item of itemRows) {
      const orderId = String(item.order_id || '');
      itemCountByOrder.set(orderId, (itemCountByOrder.get(orderId) || 0) + 1);

      const name = item.product_name || 'Produs';
      const entry = productTotals.get(name) || {
        name,
        unit: item.product_unit || '',
        quantity: 0,
        totalBani: 0,
      };
      entry.quantity = Math.round((entry.quantity + Number(item.quantity || 0)) * 100) / 100;
      entry.totalBani += Math.round(Number(item.line_total || 0) * 100);
      productTotals.set(name, entry);
    }

    const customerIds = new Set(currentOrders.map((order) => order.clientId).filter(Boolean));
    const failedBani = currentOrders
      .filter((order) => order.transferState === 'failed' || order.transferState === 'manual_required')
      .reduce((sum, order) => sum + order.amountBani, 0);

    return res.json({
      currency: 'lei',
      profileApproved: true,
      payouts,
      summary: {
        month: currentMonth,
        label: monthLabelOf(currentMonth),
        totalBani: currentBucket.totalBani,
        transferredBani: currentBucket.transferredBani,
        inTransitBani: currentBucket.inTransitBani,
        failedBani,
        orderCount: currentBucket.orderCount,
        customerCount: customerIds.size,
        averageOrderBani: currentBucket.orderCount
          ? Math.round(currentBucket.totalBani / currentBucket.orderCount)
          : 0,
      },
      months: [...buckets.values()],
      orders: currentOrders.map((order) => {
        const customer = customersById.get(order.clientId);
        const customerName = [customer?.name, customer?.surname].filter(Boolean).join(' ').trim();
        return {
          id: order.id,
          reference: order.id.slice(0, 8),
          customerName: customerName || usersById.get(order.clientId)?.username || 'Client',
          customerLocation: [customer?.city, customer?.county].filter(Boolean).join(', '),
          orderState: order.orderState,
          amountBani: order.amountBani,
          productsSubtotalBani: order.productsSubtotalBani,
          deliveryFeeBani: order.deliveryFeeBani,
          commissionBani: order.commissionBani,
          transferState: order.transferState,
          stripeTransferId: order.stripeTransferId,
          paidAt: order.paidAt.toISOString(),
          itemCount: itemCountByOrder.get(order.id) || 0,
        };
      }),
      topProducts: [...productTotals.values()]
        .sort((left, right) => right.totalBani - left.totalBani)
        .slice(0, TOP_PRODUCTS),
      window: {
        months: MONTHS_IN_WINDOW,
        totalBani: windowTotalBani,
        orderCount: orders.length,
      },
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
