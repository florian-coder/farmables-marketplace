const express = require('express');

const { supabase, TABLES } = require('../lib/supabase');
const { mapFarmerToVendor, mapProductToApi } = require('../lib/domain');

const router = express.Router();

const FARMER_COLUMNS = [
  'id',
  '"farm name"',
  '"display name"',
  '"street address"',
  '"street number"',
  'city',
  'county',
  '"phone number"',
  'email',
  '"organic operator certificate"',
  '"delivery radius"',
  'bio',
  'charges_enabled',
  'delivery_fee_bani',
  'min_order_value_bani',
  'free_delivery_threshold_bani',
].join(', ');

/** Only farms that can actually receive money are shown to buyers. */
const canSell = (farmer) =>
  farmer?.charges_enabled === true ||
  farmer?.charges_enabled === 1 ||
  farmer?.charges_enabled === '1';

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

const resolveArray = (value) => (Array.isArray(value) ? value : []);

const fetchFarmersWithRelations = async () => {
  const { data: farmers, error: farmersError } = await supabase
    .from(TABLES.farmers)
    .select(FARMER_COLUMNS);
  if (farmersError) {
    throw new Error(farmersError.message || 'Unable to load farmers.');
  }

  const safeFarmers = resolveArray(farmers);
  const farmerIds = safeFarmers.map((entry) => entry.id);
  const userIds = safeFarmers.map((entry) => entry.id);

  const [{ data: users }, { data: products }, { data: farmPhotos }] = await Promise.all([
    supabase
      .from(TABLES.users)
      .select('id, email')
      .in('id', userIds.length > 0 ? userIds : [-1]),
    supabase
      .from(TABLES.products)
      .select(PRODUCT_COLUMNS)
      .in('farmer_id', farmerIds.length > 0 ? farmerIds : [-1]),
    supabase
      .from(TABLES.farmPhotos)
      .select('id, farmer_id, image_url, caption, is_cover')
      .in('farmer_id', farmerIds.length > 0 ? farmerIds : [-1]),
  ]);

  const usersById = new Map(resolveArray(users).map((entry) => [entry.id, entry]));
  const productsByFarmer = new Map();
  for (const product of resolveArray(products)) {
    const list = productsByFarmer.get(product.farmer_id) || [];
    list.push(product);
    productsByFarmer.set(product.farmer_id, list);
  }

  const photosByFarmer = new Map();
  for (const photo of resolveArray(farmPhotos)) {
    const list = photosByFarmer.get(photo.farmer_id) || [];
    list.push(photo);
    photosByFarmer.set(photo.farmer_id, list);
  }

  return safeFarmers.map((farmer) => ({
    farmer,
    user: usersById.get(farmer.id) || null,
    products: productsByFarmer.get(farmer.id) || [],
    farmPhotos: photosByFarmer.get(farmer.id) || [],
  }));
};

router.get('/', async (_req, res, next) => {
  try {
    const rows = await fetchFarmersWithRelations();
    const vendors = rows
      .filter((entry) => canSell(entry.farmer))
      .map((entry) => {
        const vendor = mapFarmerToVendor(entry.farmer, {
          email: entry.user?.email || '',
          farmPhotos: entry.farmPhotos,
        });
        const productCount = entry.products.length;
        const ratingValues = entry.products
          .map((product) => Number(product.rating))
          .filter((value) => Number.isFinite(value));
        const vendorRating =
          ratingValues.length > 0
            ? Number(
                (
                  ratingValues.reduce((sum, value) => sum + value, 0) /
                  ratingValues.length
                ).toFixed(2),
              )
            : 0;

        return {
          ...vendor,
          productCount,
          vendorRating,
        };
      })
      .sort((a, b) =>
        (a.farmName || a.displayName || '').localeCompare(
          b.farmName || b.displayName || '',
          undefined,
          { sensitivity: 'base' },
        ),
      );

    return res.json({ vendors });
  } catch (error) {
    return next(error);
  }
});

router.get('/:vendorId', async (req, res, next) => {
  try {
    const { vendorId } = req.params;
    if (!vendorId) {
      return res.status(400).json({ error: 'vendorId is required.' });
    }

    const rows = await fetchFarmersWithRelations();
    const match = rows.find((entry) => String(entry.farmer.id) === String(vendorId));
    if (!match) {
      return res.status(404).json({ error: 'Vendor profile not found.' });
    }
    // A farm that cannot receive money is not published, and its public page
    // answers the same way a nonexistent one does.
    if (!canSell(match.farmer)) {
      return res.status(404).json({ error: 'Vendor profile not found.' });
    }

    const vendor = mapFarmerToVendor(match.farmer, {
      email: match.user?.email || '',
      farmPhotos: match.farmPhotos,
    });

    const products = match.products
      .slice()
      .sort((a, b) => Number(b.id || 0) - Number(a.id || 0))
      .map((product) => mapProductToApi(product));

    return res.json({
      vendor,
      products,
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
