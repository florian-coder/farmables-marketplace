// LOG-06 — turning a schedule into a basket.
//
// The sweep runs from the same hourly timer as OPS-04 and OPS-03. For every
// subscription due, it builds an ordinary cart — a `placed_order` row with
// items — and emails the customer that it is waiting for them.
//
// **It does not charge anything.** The customer pays for the basket like any
// other cart, at the price on the day. Two reasons, and the second is the one
// that matters:
//
//   1. A vegetable box is a different amount every week; a stored card charged
//      for an amount nobody has seen is how chargebacks happen.
//   2. Taking money for food that does not exist yet makes us a deposit-taker
//      rather than a marketplace, and turns a farm's bad season into the
//      customer's loss.
//
// The cost is that a customer has to click. The benefit is that nobody is ever
// billed for a basket they did not look at, and the farm still gets the number
// it needs to plan — the commitment is visible the moment the basket is built.

const { supabase, TABLES } = require('./supabase');
const { notify } = require('./outbox');
const { emailForUser } = require('./notifications');
const { ACTIONS, recordAudit } = require('./audit');

/** How far ahead a basket is prepared, so there is time to review it. */
const PREPARE_DAYS_AHEAD = 2;

const isoDate = (date) => date.toISOString().slice(0, 10);

const dueSubscriptions = async () => {
  const cutoff = new Date(Date.now() + PREPARE_DAYS_AHEAD * 24 * 60 * 60 * 1000);

  const { data, error } = await supabase
    .from(TABLES.subscriptions)
    .select(
      'id, customer_id, farmer_id, name, items, frequency, next_delivery_date, paused_until, state, deliveries_generated, max_deliveries',
    )
    .eq('state', 'active')
    .lte('next_delivery_date', isoDate(cutoff))
    .limit(100);

  if (error) {
    console.error('[subscriptions] Could not load due baskets:', error.message);
    return [];
  }
  return data || [];
};

/**
 * Build one basket as an unpaid cart order.
 *
 * Returns `{ built, reason }`. Never throws: one broken subscription must not
 * stop the rest of the run.
 */
const buildBasket = async (subscription) => {
  // A pause with a date resumes by itself. Without one it waits for the
  // customer, which is what "paused indefinitely" should mean.
  if (subscription.paused_until && Date.parse(subscription.paused_until) > Date.now()) {
    return { built: false, reason: 'paused' };
  }

  const items = Array.isArray(subscription.items) ? subscription.items : [];
  if (items.length === 0) {
    return { built: false, reason: 'empty' };
  }

  const productIds = items.map((item) => String(item.productId));
  const { data: products } = await supabase
    .from(TABLES.products)
    .select('id, farmer_id, "product name", Unit, Price, quantity, available')
    .in('id', productIds);

  const byId = new Map((products || []).map((row) => [String(row.id), row]));

  // Only what the farm can actually supply this week. A basket that silently
  // drops half its contents is worse than one that says so, which is what the
  // email does.
  const availableLines = [];
  const unavailable = [];
  for (const item of items) {
    const product = byId.get(String(item.productId));
    const inStock =
      product &&
      (product.available === true || Number(product.available) === 1) &&
      Number(product.quantity || 0) >= Number(item.quantity || 0);

    if (!inStock) {
      unavailable.push(product?.['product name'] || 'a product');
      continue;
    }
    availableLines.push({ product, quantity: Number(item.quantity) });
  }

  if (availableLines.length === 0) {
    return { built: false, reason: 'nothing_available', unavailable };
  }

  const { data: order, error: orderError } = await supabase
    .from(TABLES.orders)
    .insert({
      farmer_id: String(subscription.farmer_id),
      client_id: String(subscription.customer_id),
      order_state: 'placed_order',
      subscription_id: String(subscription.id),
      expected_delivery_date: subscription.next_delivery_date,
    })
    .select('id')
    .single();

  if (orderError || !order) {
    console.error('[subscriptions] Could not create the basket order:', orderError?.message);
    return { built: false, reason: 'insert_failed' };
  }

  const rows = availableLines.map((line) => ({
    order_id: String(order.id),
    product_id: String(line.product.id),
    product_name: line.product['product name'] || '',
    product_unit: line.product.Unit || 'unit',
    quantity: line.quantity,
    unit_price: Number(line.product.Price || 0),
  }));

  const { error: itemsError } = await supabase.from(TABLES.orderItems).insert(rows);
  if (itemsError) {
    // Roll the empty order back rather than leaving a basket with no contents
    // sitting in someone's cart.
    await supabase.from(TABLES.orders).delete().eq('id', String(order.id));
    return { built: false, reason: 'items_failed' };
  }

  return { built: true, orderId: String(order.id), unavailable, lines: rows.length };
};

/** Run the whole sweep. Called hourly from `orderMaintenance`. */
const generateDueBaskets = async () => {
  const summary = { considered: 0, built: 0, skipped: 0 };

  for (const subscription of await dueSubscriptions()) {
    summary.considered += 1;

    try {
      const result = await buildBasket(subscription);

      if (result.built) {
        summary.built += 1;

        const to = await emailForUser(subscription.customer_id);
        if (to) {
          notify({
            // Keyed on the delivery date, so a re-run of the sweep does not
            // email twice about the same week.
            eventKey: `basket-ready:${subscription.id}:${subscription.next_delivery_date}`,
            template: 'order.state.customer',
            to,
            userId: String(subscription.customer_id),
            payload: {
              orderId: result.orderId,
              farmName: subscription.name || 'your farm',
              state: 'basket_ready',
            },
          });
        }

        await recordAudit({
          actorType: 'system',
          actorId: 'subscription-run',
          action: ACTIONS.SUBSCRIPTION_BASKET_BUILT,
          entityType: 'subscription',
          entityId: String(subscription.id),
          newValue: `order:${result.orderId}:${result.lines}_lines`,
        });
      } else {
        summary.skipped += 1;
      }

      // Advance whether or not a basket was built. A week the farm could not
      // supply is a week missed, not a week owed — otherwise a paused or
      // unsupplied subscription silently accumulates a backlog and delivers
      // five baskets at once when it resumes.
      await supabase.rpc('advance_subscription', {
        p_subscription_id: String(subscription.id),
        p_from_date: subscription.next_delivery_date,
      });
    } catch (error) {
      summary.skipped += 1;
      console.error(`[subscriptions] Basket ${subscription.id} failed:`, error?.message || error);
    }
  }

  return summary;
};

module.exports = { PREPARE_DAYS_AHEAD, dueSubscriptions, buildBasket, generateDueBaskets };
