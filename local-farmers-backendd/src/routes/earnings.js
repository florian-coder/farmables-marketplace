const express = require('express');

const { requireVendor } = require('../middleware/auth');
const { supabase, TABLES } = require('../lib/supabase');
const { maskIban } = require('../lib/domain');

const router = express.Router();

/** Stările în care clientul a plătit deja: banii îi revin fermierului. */
const PAID_STATES = [
  'received_by_farmer',
  'preparing_order',
  'in_transit',
  'arrived',
  'received',
];

/** Comandă ajunsă și confirmată de client — suma nu se mai mișcă. */
const CLEARED_STATES = ['received'];

/** Câte luni intră în graficul de pe pagină și cât de mult citim din istoric. */
const MONTHS_IN_CHART = 6;
const MONTHS_IN_WINDOW = 12;
const MAX_ORDERS_READ = 2000;
const TOP_PRODUCTS = 5;

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const round2 = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Math.round(parsed * 100) / 100;
};

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

/** Ultima zi a lunii — ziua în care pleacă virarea. */
const payoutDateOf = (reference) =>
  new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth() + 1, 0))
    .toISOString()
    .slice(0, 10);

const emptyBucket = (monthKey) => ({
  month: monthKey,
  label: monthLabelOf(monthKey),
  shortLabel: shortMonthLabelOf(monthKey),
  total: 0,
  cleared: 0,
  pending: 0,
  orderCount: 0,
});

/** Cheile ultimelor `count` luni, de la cea mai veche la luna curentă. */
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

const emptyPayload = (reference, iban) => ({
  currency: 'lei',
  profileApproved: false,
  iban,
  payout: {
    month: monthKeyOf(reference),
    label: monthLabelOf(monthKeyOf(reference)),
    payoutDate: payoutDateOf(reference),
    total: 0,
    cleared: 0,
    pending: 0,
    orderCount: 0,
    customerCount: 0,
    averageOrder: 0,
  },
  months: recentMonthKeys(reference, MONTHS_IN_CHART).map(emptyBucket),
  orders: [],
  topProducts: [],
  window: { months: MONTHS_IN_WINDOW, total: 0, orderCount: 0 },
});

router.get('/', requireVendor, async (req, res, next) => {
  try {
    const now = new Date();
    const currentMonth = monthKeyOf(now);

    const { data: farmer, error: farmerError } = await supabase
      .from(TABLES.farmers)
      .select('id, IBAN')
      .eq('id', req.user.id)
      .maybeSingle();
    if (farmerError && farmerError.code !== 'PGRST116') {
      return res.status(500).json({ error: farmerError.message || 'Unable to load farm profile.' });
    }

    const iban = {
      present: Boolean(farmer?.IBAN),
      masked: maskIban(farmer?.IBAN),
    };

    if (!farmer) {
      return res.json(emptyPayload(now, iban));
    }

    // Fereastra e tăiată după created_at: paid_at e mereu ulterior, deci am
    // pierde doar un coș lăsat neplătit mai bine de un an.
    const windowStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (MONTHS_IN_WINDOW - 1), 1),
    ).toISOString();

    const { data: orderRows, error: ordersError } = await supabase
      .from(TABLES.orders)
      .select('id, client_id, order_state, total_price, created_at, paid_at')
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
        total: round2(row.total_price),
        paidAt,
        month: monthKeyOf(paidAt),
        cleared: CLEARED_STATES.includes(row.order_state),
      };
    });

    const buckets = new Map(
      recentMonthKeys(now, MONTHS_IN_CHART).map((key) => [key, emptyBucket(key)]),
    );

    let windowTotal = 0;
    for (const order of orders) {
      windowTotal += order.total;
      const bucket = buckets.get(order.month);
      if (!bucket) {
        continue;
      }
      bucket.total = round2(bucket.total + order.total);
      bucket.orderCount += 1;
      if (order.cleared) {
        bucket.cleared = round2(bucket.cleared + order.total);
      } else {
        bucket.pending = round2(bucket.pending + order.total);
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

    const itemsByOrderId = new Map();
    const productTotals = new Map();
    for (const item of itemRows) {
      const orderId = String(item.order_id || '');
      itemsByOrderId.set(orderId, (itemsByOrderId.get(orderId) || 0) + 1);

      const name = item.product_name || 'Product';
      const entry = productTotals.get(name) || {
        name,
        unit: item.product_unit || '',
        quantity: 0,
        total: 0,
      };
      entry.quantity = round2(entry.quantity + Number(item.quantity || 0));
      entry.total = round2(entry.total + Number(item.line_total || 0));
      productTotals.set(name, entry);
    }

    const customerIds = new Set(currentOrders.map((order) => order.clientId).filter(Boolean));

    return res.json({
      currency: 'lei',
      profileApproved: true,
      iban,
      payout: {
        month: currentMonth,
        label: monthLabelOf(currentMonth),
        payoutDate: payoutDateOf(now),
        total: currentBucket.total,
        cleared: currentBucket.cleared,
        pending: currentBucket.pending,
        orderCount: currentBucket.orderCount,
        customerCount: customerIds.size,
        averageOrder: currentBucket.orderCount
          ? round2(currentBucket.total / currentBucket.orderCount)
          : 0,
      },
      months: [...buckets.values()],
      orders: currentOrders.map((order) => {
        const customer = customersById.get(order.clientId);
        const customerName = [customer?.name, customer?.surname].filter(Boolean).join(' ').trim();
        return {
          id: order.id,
          reference: order.id.slice(0, 8),
          customerName:
            customerName || usersById.get(order.clientId)?.username || 'Customer',
          customerLocation: [customer?.city, customer?.county].filter(Boolean).join(', '),
          orderState: order.orderState,
          cleared: order.cleared,
          total: order.total,
          paidAt: order.paidAt.toISOString(),
          itemCount: itemsByOrderId.get(order.id) || 0,
        };
      }),
      topProducts: [...productTotals.values()]
        .sort((left, right) => right.total - left.total)
        .slice(0, TOP_PRODUCTS),
      window: {
        months: MONTHS_IN_WINDOW,
        total: round2(windowTotal),
        orderCount: orders.length,
      },
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
