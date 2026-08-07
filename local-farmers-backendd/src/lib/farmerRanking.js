// LEG-05 — the categories the site actually sells.
//
// This used to read `meat` / `fruits_and_vegetables` / `dairy_products`,
// inherited from an earlier plan for the marketplace. The site sells fruit and
// vegetables, eggs and honey — so two of the three categories were always
// empty, and "farmer of the month for Dairy" was permanently nobody. The
// categories here must match `MARKET_MENU_ITEMS` in the frontend and the
// columns of the `permission` table; those three lists are the same list.
const CATEGORY_CONFIG = Object.freeze([
  { key: 'fruits_and_vegetables', label: 'Fruits & Vegetables' },
  { key: 'eggs', label: 'Eggs' },
  { key: 'honey', label: 'Honey' },
]);

const CATEGORY_LABELS = new Map(CATEGORY_CONFIG.map((entry) => [entry.key, entry.label]));

const CATEGORY_ALIASES = new Map([
  ['fruits_and_vegetables', 'fruits_and_vegetables'],
  ['fruit_and_veg', 'fruits_and_vegetables'],
  ['fruit_veg', 'fruits_and_vegetables'],
  ['fruits_vegetables', 'fruits_and_vegetables'],
  ['fruit_vegetables', 'fruits_and_vegetables'],
  ['fruits_and_veggies', 'fruits_and_vegetables'],
  ['vegetables', 'fruits_and_vegetables'],
  ['fruits', 'fruits_and_vegetables'],
  ['legume', 'fruits_and_vegetables'],
  ['eggs', 'eggs'],
  ['egg', 'eggs'],
  ['oua', 'eggs'],
  ['honey', 'honey'],
  ['miere', 'honey'],
]);

const SCORE_WEIGHTS = Object.freeze({
  revenue: 0.5,
  orders: 0.3,
  quantity: 0.2,
});

const resolveArray = (value) => (Array.isArray(value) ? value : []);

const toNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return parsed;
};

const roundToTwo = (value) => Number(toNumber(value, 0).toFixed(2));

const normalizeCategory = (value) => {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s&-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');

  return CATEGORY_ALIASES.get(normalized) || null;
};

const mergePerformanceRows = (rows) => {
  const merged = new Map();

  for (const row of resolveArray(rows)) {
    const category = normalizeCategory(row?.category);
    const farmerId =
      row?.farmerId === null || row?.farmerId === undefined
        ? ''
        : String(row.farmerId).trim();

    if (!category || !farmerId) {
      continue;
    }

    const key = `${category}:${farmerId}`;
    const existing = merged.get(key) || {
      category,
      farmerId,
      farmerName: '',
      farmName: '',
      photoUrl: null,
      revenue: 0,
      orderCount: 0,
      quantity: 0,
    };

    existing.revenue += Math.max(0, toNumber(row.revenue, 0));
    existing.orderCount += Math.max(0, toNumber(row.orderCount, row.orders || 0));
    existing.quantity += Math.max(0, toNumber(row.quantity, 0));

    if (!existing.farmerName && typeof row.farmerName === 'string') {
      existing.farmerName = row.farmerName.trim();
    }
    if (!existing.farmName && typeof row.farmName === 'string') {
      existing.farmName = row.farmName.trim();
    }
    if (!existing.photoUrl && typeof row.photoUrl === 'string' && row.photoUrl.trim()) {
      existing.photoUrl = row.photoUrl.trim();
    }

    merged.set(key, existing);
  }

  return Array.from(merged.values());
};

const normalizeScore = (value, max) => {
  if (!Number.isFinite(max) || max <= 0) {
    return 0;
  }
  return (Math.max(0, toNumber(value, 0)) / max) * 100;
};

const resolveCategoryWinner = (categoryRows, category) => {
  const safeRows = resolveArray(categoryRows);
  const label = CATEGORY_LABELS.get(category) || category;

  if (safeRows.length === 0) {
    return {
      category,
      categoryLabel: label,
      maxima: {
        revenue: 0,
        orders: 0,
        quantity: 0,
      },
      winner: null,
    };
  }

  const maxRevenue = Math.max(...safeRows.map((row) => toNumber(row.revenue, 0)), 0);
  const maxOrders = Math.max(...safeRows.map((row) => toNumber(row.orderCount, 0)), 0);
  const maxQuantity = Math.max(...safeRows.map((row) => toNumber(row.quantity, 0)), 0);

  const scoredRows = safeRows.map((row) => {
    const revenueScore = normalizeScore(row.revenue, maxRevenue);
    const ordersScore = normalizeScore(row.orderCount, maxOrders);
    const quantityScore = normalizeScore(row.quantity, maxQuantity);
    const coefficient =
      revenueScore * SCORE_WEIGHTS.revenue +
      ordersScore * SCORE_WEIGHTS.orders +
      quantityScore * SCORE_WEIGHTS.quantity;

    return {
      ...row,
      revenue: Math.max(0, toNumber(row.revenue, 0)),
      orderCount: Math.max(0, toNumber(row.orderCount, 0)),
      quantity: Math.max(0, toNumber(row.quantity, 0)),
      revenueScore,
      ordersScore,
      quantityScore,
      coefficient,
    };
  });

  scoredRows.sort((left, right) => {
    if (right.coefficient !== left.coefficient) {
      return right.coefficient - left.coefficient;
    }
    if (right.revenue !== left.revenue) {
      return right.revenue - left.revenue;
    }
    if (right.orderCount !== left.orderCount) {
      return right.orderCount - left.orderCount;
    }
    if (right.quantity !== left.quantity) {
      return right.quantity - left.quantity;
    }
    return left.farmerId.localeCompare(right.farmerId);
  });

  const winner = scoredRows[0];

  return {
    category,
    categoryLabel: label,
    maxima: {
      revenue: roundToTwo(maxRevenue),
      orders: Math.round(maxOrders),
      quantity: roundToTwo(maxQuantity),
    },
    winner: {
      farmerId: winner.farmerId,
      farmerName: winner.farmerName || 'Local Farmer',
      farmName: winner.farmName || winner.farmerName || 'Local Farm',
      photoUrl: winner.photoUrl || null,
      metrics: {
        revenue: roundToTwo(winner.revenue),
        orders: Math.round(winner.orderCount),
        quantity: roundToTwo(winner.quantity),
      },
      scores: {
        money: roundToTwo(winner.revenueScore),
        orders: roundToTwo(winner.ordersScore),
        quantity: roundToTwo(winner.quantityScore),
      },
      coefficient: roundToTwo(winner.coefficient),
    },
  };
};

const buildMonthlyWinners = (rows) => {
  const mergedRows = mergePerformanceRows(rows);

  return {
    weights: { ...SCORE_WEIGHTS },
    categories: CATEGORY_CONFIG.map((entry) =>
      resolveCategoryWinner(
        mergedRows.filter((row) => row.category === entry.key),
        entry.key,
      ),
    ),
  };
};

module.exports = {
  CATEGORY_CONFIG,
  SCORE_WEIGHTS,
  normalizeCategory,
  buildMonthlyWinners,
};
