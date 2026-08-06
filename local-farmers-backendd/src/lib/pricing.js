// The cart price breakdown, computed in exactly one place.
//
// The cart UI, the checkout validation and the Stripe line items all read
// from `buildCartQuote`. A second implementation anywhere would eventually
// disagree with this one, and the customer would see one number and be
// charged another — which is the surprise-cost problem OUG 34/2014 exists to
// prevent.
//
// Note on the data model: an `orders` row is one farmer's group. A cart with
// three farms is three `orders` rows, tied together at payment time by one
// `checkouts` row (one card charge, one Stripe transfer_group).

const { supabase, TABLES } = require('./supabase');
const { getPlatformSettings } = require('./platformSettings');
const {
  leiToBani,
  toBani,
  formatBani,
  deliveryFeeBani,
  groupTotals,
  sumGroups,
  assertTotalsBalance,
} = require('./money');

const CART_STATE = 'placed_order';

const FARMER_PRICING_COLUMNS = [
  'id',
  '"farm name"',
  '"display name"',
  'stripe_account_id',
  'charges_enabled',
  'delivery_fee_bani',
  'min_order_value_bani',
  'free_delivery_threshold_bani',
].join(', ');

const asBool = (value) => value === true || value === 1 || value === '1';

/** Why a farmer's sub-cart cannot be paid for right now, in Romanian. */
const blockingReason = ({ farmer, farmName, productsSubtotalBani }) => {
  if (!farmer) {
    return {
      code: 'farmer_missing',
      message: `Ferma nu mai există. Golește produsele ei din coș.`,
    };
  }
  if (!farmer.stripe_account_id || !asBool(farmer.charges_enabled)) {
    return {
      code: 'farmer_not_payable',
      message: `${farmName} nu poate încă primi plăți. Produsele ei nu pot fi cumpărate acum.`,
    };
  }

  const minimum = toBani(farmer.min_order_value_bani);
  if (minimum > 0 && productsSubtotalBani < minimum) {
    const missing = minimum - productsSubtotalBani;
    return {
      code: 'below_minimum',
      message: `Mai adaugă ${formatBani(missing)} de la ${farmName} ca să atingi comanda minimă de ${formatBani(minimum)}.`,
      missingBani: missing,
      minimumBani: minimum,
    };
  }

  if (productsSubtotalBani <= 0) {
    return {
      code: 'empty_group',
      message: `Sub-coșul de la ${farmName} este gol.`,
    };
  }

  return null;
};

/**
 * Price the customer's whole cart.
 *
 * Returns one entry per farmer plus the totals, and never throws on a
 * business problem — an unpayable group is reported as `blocked`, so the cart
 * page can explain it instead of failing.
 */
const buildCartQuote = async ({ clientId }) => {
  const { commissionBps, minChargeBani } = await getPlatformSettings();

  const { data: orderRows, error: ordersError } = await supabase
    .from(TABLES.orders)
    .select('id, farmer_id, client_id, order_state, created_at')
    .eq('client_id', clientId)
    .eq('order_state', CART_STATE)
    .order('created_at', { ascending: true });

  if (ordersError) {
    throw new Error(ordersError.message || 'Unable to load cart.');
  }

  const orders = Array.isArray(orderRows) ? orderRows : [];
  if (orders.length === 0) {
    return {
      commissionBps,
      minChargeBani,
      groups: [],
      totals: {
        productsSubtotalBani: 0,
        deliveryFeeBani: 0,
        commissionBani: 0,
        transferAmountBani: 0,
        customerTotalBani: 0,
      },
      payable: false,
      blockers: [],
    };
  }

  const orderIds = orders.map((row) => String(row.id));
  const farmerIds = [...new Set(orders.map((row) => String(row.farmer_id)).filter(Boolean))];

  const [itemsResult, farmersResult] = await Promise.all([
    supabase
      .from(TABLES.orderItems)
      .select('id, order_id, product_id, product_name, product_unit, quantity, unit_price, line_total')
      .in('order_id', orderIds),
    supabase.from(TABLES.farmers).select(FARMER_PRICING_COLUMNS).in('id', farmerIds),
  ]);

  if (itemsResult.error) {
    throw new Error(itemsResult.error.message || 'Unable to load cart items.');
  }
  if (farmersResult.error) {
    throw new Error(farmersResult.error.message || 'Unable to load farms.');
  }

  const itemsByOrder = new Map();
  for (const item of itemsResult.data || []) {
    const key = String(item.order_id);
    const list = itemsByOrder.get(key) || [];
    list.push(item);
    itemsByOrder.set(key, list);
  }

  const farmersById = new Map((farmersResult.data || []).map((row) => [String(row.id), row]));

  const groups = [];
  for (const order of orders) {
    const orderId = String(order.id);
    const farmerId = String(order.farmer_id);
    const farmer = farmersById.get(farmerId) || null;
    const farmName = farmer?.['farm name'] || farmer?.['display name'] || 'Fermă';

    const items = (itemsByOrder.get(orderId) || []).map((item) => ({
      id: String(item.id),
      productId: String(item.product_id),
      productName: item.product_name || '',
      productUnit: item.product_unit || '',
      quantity: Number(item.quantity || 0),
      unitPriceBani: leiToBani(item.unit_price),
      lineTotalBani: leiToBani(item.line_total),
    }));

    // Sum the stored line totals, not quantity × price: `line_total` is what
    // the database trigger rounded and what the customer has been looking at.
    const productsSubtotalBani = items.reduce((sum, item) => sum + item.lineTotalBani, 0);

    const fee = deliveryFeeBani({
      feeBani: farmer?.delivery_fee_bani,
      freeThresholdBani: farmer?.free_delivery_threshold_bani,
      productsSubtotalBani,
    });

    const totals = groupTotals({
      productsSubtotalBani,
      deliveryFeeBani: fee,
      commissionBps,
    });

    const blocked = blockingReason({ farmer, farmName, productsSubtotalBani });

    groups.push({
      orderId,
      farmerId,
      farmName,
      stripeAccountId: String(farmer?.stripe_account_id || ''),
      items,
      ...totals,
      commissionBps,
      minOrderValueBani: toBani(farmer?.min_order_value_bani),
      freeDeliveryThresholdBani:
        farmer?.free_delivery_threshold_bani === null ||
        farmer?.free_delivery_threshold_bani === undefined
          ? null
          : toBani(farmer.free_delivery_threshold_bani),
      // The farmer's own fee, before the free-delivery threshold waived it.
      listedDeliveryFeeBani: toBani(farmer?.delivery_fee_bani),
      deliveryFeeWaived: toBani(farmer?.delivery_fee_bani) > 0 && fee === 0,
      blocked,
    });
  }

  const totals = sumGroups(groups);
  // Fails loudly rather than charging a card for a number that does not add up.
  assertTotalsBalance(totals);

  const blockers = groups.filter((group) => group.blocked).map((group) => group.blocked);

  if (totals.customerTotalBani > 0 && totals.customerTotalBani < minChargeBani) {
    blockers.push({
      code: 'below_stripe_minimum',
      message: `Plata cu cardul se poate face de la ${formatBani(minChargeBani)}. Mai adaugă produse în coș.`,
    });
  }

  return {
    commissionBps,
    minChargeBani,
    groups,
    totals,
    payable: blockers.length === 0 && groups.length > 0 && totals.customerTotalBani > 0,
    blockers,
  };
};

/** The shape the cart and checkout pages render. All amounts in bani. */
const serializeQuote = (quote) => ({
  commissionBps: quote.commissionBps,
  commissionPercentLabel: `${(quote.commissionBps / 100).toFixed(quote.commissionBps % 100 === 0 ? 0 : 2)}%`,
  groups: quote.groups.map((group) => ({
    orderId: group.orderId,
    farmerId: group.farmerId,
    farmName: group.farmName,
    productsSubtotalBani: group.productsSubtotalBani,
    deliveryFeeBani: group.deliveryFeeBani,
    listedDeliveryFeeBani: group.listedDeliveryFeeBani,
    deliveryFeeWaived: group.deliveryFeeWaived,
    commissionBani: group.commissionBani,
    customerTotalBani: group.customerTotalBani,
    minOrderValueBani: group.minOrderValueBani,
    freeDeliveryThresholdBani: group.freeDeliveryThresholdBani,
    itemCount: group.items.length,
    blocked: group.blocked,
  })),
  totals: quote.totals,
  payable: quote.payable,
  blockers: quote.blockers,
});

module.exports = {
  CART_STATE,
  FARMER_PRICING_COLUMNS,
  buildCartQuote,
  serializeQuote,
};
