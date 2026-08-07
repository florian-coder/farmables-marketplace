const express = require('express');

const { getOrSetCache } = require('../lib/cacheStore');
const { getProductImage } = require('../lib/productMedia');
const { supabase, TABLES } = require('../lib/supabase');
const { DEFAULT_MARKETS, mapProductToApi } = require('../lib/domain');

const router = express.Router();

const MARKET_PRODUCTS_LIMIT = 50; // Increased limit to get more products for stats
const DAILY_RECOMMENDATION_LIMIT = 4;
const FARMER_OF_MONTH_LIMIT = 3;
const MONTH_PARAM_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const HOME_CATEGORY_CONFIG = Object.freeze([
  { key: 'fruits_and_vegetables', label: 'Fruits & Vegetables' },
  { key: 'eggs', label: 'Eggs' },
  { key: 'honey', label: 'Honey' },
]);

const PRODUCT_COLUMNS = [
  'id',
  'farmer_id',
  '"product name"',
  'category',
  'type',
  'Unit',
  'quantity',
  'Price',
  'rating',
  '"photo url"',
  '"bio check"',
  'available',
  'instant_buy',
  // LEG-04 — the mandatory particulars travel with the product everywhere.
  'labelling',
  'batch_code',
].join(', ');

const FARMER_COLUMNS = [
  'id',
  '"farm name"',
  '"display name"',
  'city',
  'county',
  // A farm that cannot receive money cannot sell: its products are filtered
  // out of every market listing below.
  'charges_enabled',
].join(', ');

const farmerCanSell = (farmer) =>
  farmer?.charges_enabled === true ||
  farmer?.charges_enabled === 1 ||
  farmer?.charges_enabled === '1';

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const resolveArray = (value) => (Array.isArray(value) ? value : []);
const normalizeId = (value) =>
  value === null || value === undefined ? '' : String(value).trim();
const toNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return parsed;
};
const roundMoney = (value) => Number(toNumber(value, 0).toFixed(2));

const sortProductsByNewest = (products) =>
  products
    .slice()
    .sort((a, b) => {
      const leftId = toNumber(a.id, 0);
      const rightId = toNumber(b.id, 0);
      if (rightId !== leftId) {
        return rightId - leftId;
      }
      return String(b.id || '').localeCompare(String(a.id || ''));
    });

const loadProducts = async (category, options = {}) => {
  const { withImageFallback = true } = options;
  let query = supabase.from(TABLES.products).select(PRODUCT_COLUMNS);
  if (category) {
    query = query.eq('category', category);
  }

  const [productsResult, farmersResult] = await Promise.all([
    query,
    supabase.from(TABLES.farmers).select(FARMER_COLUMNS),
  ]);

  if (productsResult.error) {
    throw new Error(productsResult.error.message || 'Unable to load products.');
  }
  if (farmersResult.error) {
    throw new Error(farmersResult.error.message || 'Unable to load farmers.');
  }

  const farmersById = new Map(
    (farmersResult.data || []).map((farmer) => [
      String(farmer.id),
      {
        id: String(farmer.id),
        farmName: farmer['farm name'] || '',
        displayName: farmer['display name'] || '',
        city: farmer.city || '',
        county: farmer.county || '',
      },
    ]),
  );

  // The visibility gate. Products stay in the farmer's own account; they just
  // do not appear in a market they cannot be bought from.
  const sellableFarmerIds = new Set(
    (farmersResult.data || []).filter(farmerCanSell).map((farmer) => String(farmer.id)),
  );

  return Promise.all(
    resolveArray(productsResult.data)
      .filter((product) => sellableFarmerIds.has(String(product.farmer_id)))
      .map(async (product) => {
        const vendor = farmersById.get(String(product.farmer_id)) || null;
        const mapped = mapProductToApi(product, vendor);
        if (withImageFallback && !mapped.image?.url) {
          const fallback = await getProductImage(mapped.name);
          if (fallback?.url) {
            return {
              ...mapped,
              image: fallback,
            };
          }
        }
        return mapped;
      }),
  );
};

const resolveMonthRange = (rawMonth) => {
  const now = new Date();
  let year = now.getUTCFullYear();
  let monthIndex = now.getUTCMonth();

  if (typeof rawMonth === 'string' && rawMonth.trim()) {
    const [yearPart, monthPart] = rawMonth.split('-');
    year = Number(yearPart);
    monthIndex = Number(monthPart) - 1;
  }

  const start = new Date(Date.UTC(year, monthIndex, 1));
  const end = new Date(Date.UTC(year, monthIndex + 1, 1));
  const month = `${year}-${String(monthIndex + 1).padStart(2, '0')}`;

  return {
    month,
    startIso: start.toISOString(),
    endIso: end.toISOString(),
  };
};

const toRecommendationEntry = (product) => ({
  id: product.id,
  name: product.name,
  price: roundMoney(product.price),
  unit: product.unit || 'unit',
  isBio: Boolean(product.isBio),
  vendorName: product.vendor?.farmName || product.vendor?.displayName || 'Local farmer',
  image: product.image?.url
    ? {
        url: product.image.url,
        alt: product.image.alt || `${product.name || 'Product'} image`,
      }
    : null,
});

const loadDailyRecommendations = async () => {
  const rows = await Promise.all(
    HOME_CATEGORY_CONFIG.map(async ({ key, label }) => {
      const products = await loadProducts(key);
      const recommendedProducts = sortProductsByNewest(products)
        .filter((product) => Boolean(product.available))
        .slice(0, DAILY_RECOMMENDATION_LIMIT)
        .map(toRecommendationEntry);

      return [
        key,
        {
          category: key,
          label,
          products: recommendedProducts,
        },
      ];
    }),
  );

  return Object.fromEntries(rows);
};

const loadFarmerMetadataById = async (farmerIds) => {
  const safeFarmerIds = [...new Set(resolveArray(farmerIds).map(normalizeId).filter(Boolean))];
  if (safeFarmerIds.length === 0) {
    return new Map();
  }

  const [{ data: farmers, error: farmersError }, { data: photos, error: photosError }] =
    await Promise.all([
      supabase
        .from(TABLES.farmers)
        .select('id, "display name", "farm name"')
        .in('id', safeFarmerIds),
      supabase
        .from(TABLES.farmPhotos)
        .select('id, farmer_id, image_url, is_cover')
        .in('farmer_id', safeFarmerIds)
        .order('is_cover', { ascending: false })
        .order('id', { ascending: true }),
    ]);

  if (farmersError) {
    throw new Error(farmersError.message || 'Unable to load farmers for ranking.');
  }
  if (photosError) {
    throw new Error(photosError.message || 'Unable to load farm photos for ranking.');
  }

  const metadataById = new Map();
  for (const farmer of resolveArray(farmers)) {
    const farmerId = normalizeId(farmer.id);
    if (!farmerId) {
      continue;
    }
    metadataById.set(farmerId, {
      farmerName: farmer['display name'] || '',
      farmName: farmer['farm name'] || '',
      photoUrl: null,
    });
  }

  for (const photo of resolveArray(photos)) {
    const farmerId = normalizeId(photo.farmer_id);
    if (!farmerId || !photo.image_url) {
      continue;
    }
    const existing = metadataById.get(farmerId) || {
      farmerName: '',
      farmName: '',
      photoUrl: null,
    };
    if (!existing.photoUrl) {
      existing.photoUrl = photo.image_url;
      metadataById.set(farmerId, existing);
    }
  }

  return metadataById;
};

const shuffleInPlace = (items) => {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    const temp = items[index];
    items[index] = items[randomIndex];
    items[randomIndex] = temp;
  }
  return items;
};

const toRandomFarmerWinner = (farmer) => ({
  farmerId: farmer.farmerId,
  farmerName: farmer.farmerName,
  farmName: farmer.farmName,
  photoUrl: farmer.photoUrl,
  metrics: {
    revenue: 0,
    orders: 0,
    quantity: 0,
  },
  coefficient: 0,
});

const loadFarmerOfMonth = async ({ month }) => {
  const { data: farmers, error: farmersError } = await supabase
    .from(TABLES.farmers)
    .select('id, "display name", "farm name"');

  if (farmersError) {
    throw new Error(farmersError.message || 'Unable to load farmers for homepage.');
  }

  const safeFarmers = resolveArray(farmers);
  const farmerIds = safeFarmers.map((entry) => normalizeId(entry.id)).filter(Boolean);
  const farmerMetadataById = await loadFarmerMetadataById(farmerIds);

  const candidates = safeFarmers
    .map((farmer) => {
      const farmerId = normalizeId(farmer.id);
      if (!farmerId) {
        return null;
      }
      const metadata = farmerMetadataById.get(farmerId) || {
        farmerName: '',
        farmName: '',
        photoUrl: null,
      };

      const farmerName = metadata.farmerName || farmer['display name'] || 'Local Farmer';
      const farmName = metadata.farmName || farmer['farm name'] || farmerName || 'Local Farm';

      return {
        farmerId,
        farmerName,
        farmName,
        photoUrl: metadata.photoUrl || null,
      };
    })
    .filter(Boolean);

  shuffleInPlace(candidates);
  const selectedFarmers = candidates
    .slice(0, FARMER_OF_MONTH_LIMIT)
    .map(toRandomFarmerWinner);

  return {
    month,
    categories: HOME_CATEGORY_CONFIG.map((entry, index) => ({
      category: entry.key,
      categoryLabel: entry.label,
      winner: selectedFarmers[index] || null,
    })),
  };
};

const buildMarketResponse = async (category) => {
  const products = await loadProducts(category);
  const sortedProducts = sortProductsByNewest(products);
  
  // Calculate dynamic stats
  const farmerIds = new Set(products.map(p => p.vendorId).filter(Boolean));
  const activeGrowers = farmerIds.size;
  const totalProducts = products.length;
  const biggestRating = products.reduce((max, p) => Math.max(max, p.rating || 0), 0);

  const markets = DEFAULT_MARKETS.map((market) => {
    return {
      id: market.id,
      name: market.name,
      activeGrowers,
      totalProducts,
      biggestRating: Number(biggestRating.toFixed(1)),
      products: sortedProducts.slice(0, MARKET_PRODUCTS_LIMIT),
    };
  });

  return markets;
};

router.get('/home-insights', async (req, res, next) => {
  try {
    const monthQuery = typeof req.query.month === 'string' ? req.query.month.trim() : '';
    if (monthQuery && !MONTH_PARAM_PATTERN.test(monthQuery)) {
      return res
        .status(400)
        .json({ error: 'Invalid month format. Use YYYY-MM, for example 2026-03.' });
    }

    const monthRange = resolveMonthRange(monthQuery || undefined);
    const [dailyRecommendations, farmerOfMonth] = await Promise.all([
      loadDailyRecommendations(),
      loadFarmerOfMonth(monthRange),
    ]);

    return res.json({
      generatedAt: new Date().toISOString(),
      dailyRecommendations,
      farmerOfMonth,
    });
  } catch (error) {
    return next(error);
  }
});

router.get('/', async (_req, res, next) => {
  try {
    const markets = await buildMarketResponse(null);
    return res.json({ markets });
  } catch (error) {
    return next(error);
  }
});

router.get('/:category', async (req, res, next) => {
  try {
    const { category } = req.params;
    const markets = await buildMarketResponse(category);
    return res.json({ markets });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
