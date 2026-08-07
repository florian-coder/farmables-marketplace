const express = require('express');

const { supabase, TABLES } = require('../lib/supabase');
const { mapProductToApi } = require('../lib/domain');
const { fetchSellableFarmerIds } = require('../lib/connect');

const router = express.Router();

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
].join(', ');

router.get('/', async (_req, res, next) => {
  try {
    const [productsResult, farmersResult] = await Promise.all([
      supabase.from(TABLES.products).select(PRODUCT_COLUMNS),
      supabase.from(TABLES.farmers).select(FARMER_COLUMNS),
    ]);

    if (productsResult.error) {
      return res.status(500).json({ error: productsResult.error.message });
    }
    if (farmersResult.error) {
      return res.status(500).json({ error: farmersResult.error.message });
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

    // A farmer without `charges_enabled` has no way to receive money, so
    // their products cannot be bought — and a catalog entry that cannot be
    // bought is worse than no entry. The products stay in the farmer's own
    // account, they simply do not surface here.
    const sellableFarmerIds = await fetchSellableFarmerIds(
      (productsResult.data || []).map((product) => product.farmer_id),
    );

    const products = (productsResult.data || [])
      .filter((product) => sellableFarmerIds.has(String(product.farmer_id)))
      .map((product) => {
        const vendor = farmersById.get(String(product.farmer_id)) || null;
        return mapProductToApi(product, vendor);
      });

    return res.json({ products });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
