// Money is integer bani. Never float.
//
// A leu has 100 bani. Every amount that touches Stripe, the database or the
// commission formula is an integer number of bani, because 0.1 + 0.2 !== 0.3
// in IEEE 754 and a marketplace that loses a ban per order loses trust long
// before it loses money.
//
// The only place floats are allowed is the boundary with the legacy
// `numeric(12,2)` columns (`unit_price`, `line_total`, `total_price`), and
// they are converted immediately by `leiToBani`.

/** Convert a lei amount (number or numeric string) to integer bani. */
const leiToBani = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  // Round half away from zero on the ban, the same rule the SQL side uses.
  return Math.sign(parsed) * Math.round(Math.abs(parsed) * 100);
};

/** Convert integer bani back to a lei number, for the legacy numeric columns. */
const baniToLei = (bani) => {
  const parsed = Number(bani);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Math.round(parsed) / 100;
};

/** Coerce anything that claims to be bani into a non-negative integer. */
const toBani = (value, fallback = 0) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(0, Math.round(parsed));
};

/** "12,50 lei" — Romanian formatting, for emails and error messages. */
const formatBani = (bani) => {
  const value = baniToLei(toBani(bani));
  return `${value.toFixed(2).replace('.', ',')} lei`;
};

/**
 * Platform commission on a product subtotal, rounded half-up to the ban.
 *
 * Half-up and not banker's rounding: it is the rule a human doing the same
 * arithmetic by hand would use, so a farmer recomputing the invoice gets our
 * number. `Math.round` on a positive number is already half-up, and the
 * operands stay well inside Number.MAX_SAFE_INTEGER (a 100.000 lei subtotal
 * times 10.000 bps is 1e11).
 */
const commissionBani = (productsSubtotalBani, commissionBps) => {
  const subtotal = toBani(productsSubtotalBani);
  const bps = toBani(commissionBps);
  return Math.floor((subtotal * bps + 5000) / 10000);
};

/**
 * Delivery fee for one farmer on one order.
 *
 * `freeThresholdBani` is optional: null / 0 means the farmer has not set a
 * free-delivery threshold, so the fee always applies.
 */
const deliveryFeeBani = ({ feeBani, freeThresholdBani, productsSubtotalBani }) => {
  const fee = toBani(feeBani);
  const threshold = toBani(freeThresholdBani);
  if (fee === 0) {
    return 0;
  }
  if (threshold > 0 && toBani(productsSubtotalBani) >= threshold) {
    return 0;
  }
  return fee;
};

/**
 * Totals for one farmer group. The four numbers are the contract with Stripe
 * and with the database: everything downstream re-derives from them.
 */
const groupTotals = ({ productsSubtotalBani, deliveryFeeBani: fee, commissionBps }) => {
  const products = toBani(productsSubtotalBani);
  const delivery = toBani(fee);
  const commission = commissionBani(products, commissionBps);
  return {
    productsSubtotalBani: products,
    deliveryFeeBani: delivery,
    commissionBani: commission,
    // What the farmer receives: products plus delivery, commission excluded.
    transferAmountBani: products + delivery,
    // What the customer pays for this farmer.
    customerTotalBani: products + delivery + commission,
  };
};

/**
 * Sum farmer groups into the single amount we charge the card.
 *
 * Commission is rounded per group and only then summed — rounding the
 * aggregate instead would produce a charge that does not equal the sum of the
 * transfers plus our fee, and the difference would silently come out of the
 * platform balance. `assertTotalsBalance` is the guard that this never drifts.
 */
const sumGroups = (groups) => {
  const totals = {
    productsSubtotalBani: 0,
    deliveryFeeBani: 0,
    commissionBani: 0,
    transferAmountBani: 0,
    customerTotalBani: 0,
  };

  for (const group of groups) {
    totals.productsSubtotalBani += toBani(group.productsSubtotalBani);
    totals.deliveryFeeBani += toBani(group.deliveryFeeBani);
    totals.commissionBani += toBani(group.commissionBani);
    totals.transferAmountBani += toBani(group.transferAmountBani);
    totals.customerTotalBani += toBani(group.customerTotalBani);
  }

  return totals;
};

/**
 * The invariant: what we charge equals what we transfer out plus what we keep.
 *
 * Throws rather than returning false. A pricing bug that reaches Stripe is a
 * bug that moves real money, so it has to stop the request, not degrade it.
 */
const assertTotalsBalance = (totals) => {
  const charged = toBani(totals.customerTotalBani);
  const distributed = toBani(totals.transferAmountBani) + toBani(totals.commissionBani);

  if (charged !== distributed) {
    throw new Error(
      `Pricing invariant violated: charging ${charged} bani but distributing ${distributed} bani ` +
        `(transfers ${totals.transferAmountBani} + commission ${totals.commissionBani}).`,
    );
  }

  const composed =
    toBani(totals.productsSubtotalBani) +
    toBani(totals.deliveryFeeBani) +
    toBani(totals.commissionBani);
  if (charged !== composed) {
    throw new Error(
      `Pricing invariant violated: total ${charged} bani does not equal ` +
        `products ${totals.productsSubtotalBani} + delivery ${totals.deliveryFeeBani} + ` +
        `commission ${totals.commissionBani}.`,
    );
  }

  return true;
};

module.exports = {
  leiToBani,
  baniToLei,
  toBani,
  formatBani,
  commissionBani,
  deliveryFeeBani,
  groupTotals,
  sumGroups,
  assertTotalsBalance,
};
