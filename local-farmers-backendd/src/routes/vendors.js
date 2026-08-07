const express = require('express');

const { supabase, TABLES } = require('../lib/supabase');
const { mapFarmerToVendor, mapProductToApi } = require('../lib/domain');
const { getUserFromRequest } = require('../middleware/auth');
const {
  hasPaidOrderBetween,
  publicTraderDetails,
  applyContactVisibility,
} = require('../lib/traderDetails');

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
  // LEG-07 / DSA art. 30 — who the customer is actually contracting with.
  'legal_name',
  'trade_register_number',
  'cui',
  'trader_type',
  // OPS-03 — a suspended farm is not published.
  'suspended_at',
  'suspension_effective_at',
].join(', ');

/** Only farms that can actually receive money are shown to buyers. */
const canSell = (farmer) => {
  const chargesEnabled =
    farmer?.charges_enabled === true ||
    farmer?.charges_enabled === 1 ||
    farmer?.charges_enabled === '1';
  if (!chargesEnabled) {
    return false;
  }
  // OPS-03 — a suspension that has taken effect unpublishes the farm.
  if (
    farmer?.suspended_at &&
    (!farmer.suspension_effective_at ||
      Date.parse(farmer.suspension_effective_at) <= Date.now())
  ) {
    return false;
  }
  return true;
};

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
        const vendor = applyContactVisibility(
          {
            ...mapFarmerToVendor(entry.farmer, {
              email: entry.user?.email || '',
              farmPhotos: entry.farmPhotos,
            }),
            // LEG-07 — identification is public, always. It is a matter of
            // public record and it is not a channel anyone can spam.
            trader: publicTraderDetails(entry.farmer),
          },
          // OPS-05 — a directory listing has no order in view, so never.
          { revealContact: false },
        );
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

    // OPS-05 — phone and email were rendering as tel:/mailto: to anyone at
    // all. That is a scraped contact list waiting to happen, and it is how a
    // marketplace gets disintermediated: the customer calls, pays cash, and
    // loses every protection they were about to have. Revealed once there is
    // a paid order between the two of them — "ever", not "currently", because
    // re-hiding a number someone already wrote down is theatre.
    const viewer = await getUserFromRequest(req);
    const revealContact =
      viewer?.role === 'customer'
        ? await hasPaidOrderBetween({ customerId: viewer.id, farmerId: match.farmer.id })
        : String(viewer?.id || '') === String(match.farmer.id);

    const vendor = applyContactVisibility(
      {
        ...mapFarmerToVendor(match.farmer, {
          email: match.user?.email || '',
          farmPhotos: match.farmPhotos,
        }),
        trader: publicTraderDetails(match.farmer),
      },
      { revealContact },
    );

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
