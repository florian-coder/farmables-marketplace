// LOG-06 — seasons, pre-orders and baskets that repeat.
//
// Three things that look separate and are not: all of them are about a product
// that exists at a different time from when someone wants to buy it.
//
//   * **Season.** A product outside its window is not "out of stock", it is
//     out of season — and the difference in wording is the difference between
//     "this shop is empty" and "come back in June". One of those loses the
//     customer permanently.
//   * **Pre-order.** In season but not yet harvested. The customer commits and
//     the farm plants against a real number instead of a guess.
//   * **Subscription.** A basket that repeats, which is the only model that
//     gives a farm a number to plan against.
//
// The rounding-corner decision: a season may **wrap the year**. November to
// February is 11 → 2, which is how a winter crop actually works, and a naive
// `start <= month <= end` gets it exactly backwards.

const MONTH_NAMES = [
  '',
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

const FREQUENCY_DAYS = Object.freeze({
  weekly: 7,
  fortnightly: 14,
  monthly: 28,
});

const toMonth = (value) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 12 ? parsed : null;
};

/**
 * Is this month inside the window?
 *
 * Handles the wrap: 11 → 2 means November, December, January, February.
 */
const isMonthInSeason = (month, startMonth, endMonth) => {
  const start = toMonth(startMonth);
  const end = toMonth(endMonth);

  // No window configured is "all year", which is every product today.
  if (start === null || end === null) {
    return true;
  }
  if (start <= end) {
    return month >= start && month <= end;
  }
  // Wrapped: in season if we are past the start OR before the end.
  return month >= start || month <= end;
};

/**
 * What to say about a product right now.
 *
 * Returns `{ inSeason, canPreorder, label, availableFrom }`. The label is
 * customer-facing text, because "false" tells a shopper nothing.
 */
const seasonStatus = (product, now = new Date()) => {
  const month = now.getUTCMonth() + 1;
  const start = toMonth(product?.season_start_month);
  const end = toMonth(product?.season_end_month);
  const inSeason = isMonthInSeason(month, start, end);

  const window =
    start !== null && end !== null ? `${MONTH_NAMES[start]} to ${MONTH_NAMES[end]}` : '';

  if (inSeason) {
    return {
      inSeason: true,
      canPreorder: false,
      label: window ? `In season (${window})` : '',
      seasonWindow: window,
    };
  }

  const canPreorder =
    Boolean(product?.preorder_enabled) &&
    Boolean(product?.preorder_available_from) &&
    Number(product?.preorder_capacity || 0) > Number(product?.preorder_committed || 0);

  return {
    inSeason: false,
    canPreorder,
    // "Back in June" keeps the customer; "out of stock" loses them.
    label: canPreorder
      ? `Pre-order now — ready ${product.preorder_available_from}`
      : window
        ? `Back in season in ${MONTH_NAMES[start]}`
        : 'Not available right now',
    seasonWindow: window,
    availableFrom: product?.preorder_available_from || null,
  };
};

/**
 * May this quantity be pre-ordered?
 *
 * `preorder_capacity` is separate from `quantity` because a pre-order does not
 * consume stock — without its own ceiling a farm can promise a field it has
 * not planted.
 */
const preorderBlocker = (product, quantity) => {
  if (!product?.preorder_enabled) {
    return { code: 'preorder_disabled', message: 'This product cannot be pre-ordered.' };
  }
  if (!product.preorder_available_from) {
    return {
      code: 'no_delivery_date',
      // OUG 34/2014 art. 19 requires a delivery date. "Sometime" is not one.
      message: 'This product has no expected delivery date yet, so it cannot be pre-ordered.',
    };
  }

  const capacity = Number(product.preorder_capacity || 0);
  const committed = Number(product.preorder_committed || 0);
  const wanted = Number(quantity || 0);

  if (!Number.isFinite(wanted) || wanted <= 0) {
    return { code: 'invalid_quantity', message: 'Quantity must be a positive number.' };
  }
  if (committed + wanted > capacity) {
    const remaining = Math.max(0, capacity - committed);
    return {
      code: 'preorder_full',
      message:
        remaining > 0
          ? `Only ${remaining} left to pre-order for this harvest.`
          : 'This harvest is fully pre-ordered.',
    };
  }

  return null;
};

/** The next delivery date on or after `from`, on the chosen weekday. */
const nextDeliveryDate = ({ from = new Date(), weekday = 6, frequency = 'weekly' }) => {
  const days = FREQUENCY_DAYS[frequency] || FREQUENCY_DAYS.weekly;
  const date = new Date(from.getTime());
  date.setUTCHours(0, 0, 0, 0);

  // Move to the next occurrence of the weekday, never today: a basket
  // generated on the morning of delivery is a basket nobody packed.
  let delta = (weekday - date.getUTCDay() + 7) % 7;
  if (delta === 0) {
    delta = 7;
  }
  date.setUTCDate(date.getUTCDate() + delta);

  // For anything longer than weekly the weekday still anchors it; the interval
  // is applied when the schedule advances, not here.
  return { date, intervalDays: days };
};

/** Validate a subscription before it is created. */
const parseSubscriptionInput = (body) => {
  const frequency = String(body?.frequency || 'weekly');
  if (!Object.prototype.hasOwnProperty.call(FREQUENCY_DAYS, frequency)) {
    return { ok: false, error: `frequency must be one of: ${Object.keys(FREQUENCY_DAYS).join(', ')}.` };
  }

  const weekday = Number(body?.deliveryWeekday ?? 6);
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
    return { ok: false, error: 'deliveryWeekday must be a number from 0 (Sunday) to 6 (Saturday).' };
  }

  const items = Array.isArray(body?.items) ? body.items : [];
  if (items.length === 0) {
    return { ok: false, error: 'A basket needs at least one product.' };
  }

  const cleaned = [];
  for (const entry of items) {
    const productId = String(entry?.productId || '').trim();
    const quantity = Number(entry?.quantity);
    if (!productId) {
      return { ok: false, error: 'Every basket item needs a productId.' };
    }
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return { ok: false, error: 'Every basket item needs a positive quantity.' };
    }
    cleaned.push({ productId, quantity: Number(quantity.toFixed(2)) });
  }

  const maxDeliveries =
    body?.maxDeliveries === undefined || body?.maxDeliveries === null
      ? null
      : Number(body.maxDeliveries);
  if (maxDeliveries !== null && (!Number.isInteger(maxDeliveries) || maxDeliveries < 1)) {
    return { ok: false, error: 'maxDeliveries must be a whole number of at least 1, or omitted.' };
  }

  return {
    ok: true,
    value: {
      frequency,
      deliveryWeekday: weekday,
      items: cleaned,
      maxDeliveries,
      name: String(body?.name || 'Weekly basket').slice(0, 120),
    },
  };
};

module.exports = {
  MONTH_NAMES,
  FREQUENCY_DAYS,
  isMonthInSeason,
  seasonStatus,
  preorderBlocker,
  nextDeliveryDate,
  parseSubscriptionInput,
};
