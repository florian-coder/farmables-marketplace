const express = require('express');
const crypto = require('crypto');
const path = require('path');
const multer = require('multer');

const { requireVendor } = require('../middleware/auth');
const { supabase, TABLES, BUCKET_ALIASES } = require('../lib/supabase');
const {
  mapFarmerToVendor,
  mapProductToApi,
  normalizeText,
  toIntFlag,
  toNumberOrNull,
} = require('../lib/domain');
const { ACTIONS, recordAudit } = require('../lib/audit');
const { serializeAvailability, parseAvailabilityInput } = require('../lib/availability');
const {
  validateLabelling,
  organicClaimAllowed,
  ORGANIC_REFUSALS,
  requiredFieldsFor,
} = require('../lib/labelling');
const { recalculateAndPersistProductRatings } = require('../lib/productRating');
const { mapConnectState } = require('../lib/connect');

const router = express.Router();

const MAX_PROFILE_IMAGES = 10;

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
/** SEC-10: actele sunt scanate sau exportate ca PDF, nu doar fotografiate. */
const DOCUMENT_TYPES = [...IMAGE_TYPES, 'application/pdf'];

const makeUploader = (allowed, label) =>
  multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      if (allowed.includes(file.mimetype)) {
        cb(null, true);
        return;
      }
      cb(new Error(`Invalid file type for ${label}. Allowed: ${allowed.join(', ')}.`));
    },
  });

const upload = makeUploader(IMAGE_TYPES, 'images');
const documentUpload = makeUploader(DOCUMENT_TYPES, 'documents');

/**
 * Rulează un middleware de multer și transformă erorile lui în răspunsuri
 * lizibile. Fără asta, un PDF prea mare sau de tip greșit ajungea la handlerul
 * global și fermierul primea „Internal Server Error", fără nicio indicație.
 */
const runUpload = (middleware) => (req, res, next) => {
  middleware(req, res, (err) => {
    if (!err) {
      return next();
    }
    if (err instanceof multer.MulterError) {
      const message =
        err.code === 'LIMIT_FILE_SIZE'
          ? 'File is too large. The limit is 5 MB per file.'
          : `Upload error: ${err.message}`;
      return res.status(400).json({ error: message });
    }
    return res.status(400).json({ error: err.message || 'Upload failed.' });
  });
};

const DOCS_BUCKET = 'docs';

/**
 * SEC-03 — În baza de date păstrăm calea din bucket, nu o adresă publică.
 * Bucket-ul e privat, deci adresele se semnează la cerere, pentru admin.
 * Acceptă și adresele publice salvate înainte de migrare.
 */
const toStoragePath = (value) => {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) {
    return '';
  }
  const marker = `/${DOCS_BUCKET}/`;
  const index = raw.indexOf(marker);
  if (index !== -1) {
    return decodeURIComponent(raw.slice(index + marker.length));
  }
  return raw;
};

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
  // Payout state. The IBAN column is deprecated and no longer read: Stripe
  // Connect holds the bank details now.
  'stripe_account_id',
  'charges_enabled',
  'payouts_enabled',
  'details_submitted',
  'requirements_due',
  'onboarding_completed_at',
  'delivery_fee_bani',
  'min_order_value_bani',
  'free_delivery_threshold_bani',
  'payout_settings_set_at',
].join(', ');

const REQUEST_COLUMNS = [
  'id',
  'user_id',
  'farm_name',
  'display_name',
  'street_address',
  'street_number',
  'county',
  'city',
  'phone_number',
  'email',
  'organic_certificate',
  'delivery_radius_km',
  'bio',
  'farm_images',
  'documents',
  'status',
  'review_note',
  'reviewed_at',
  'reviewed_by',
  'created_at',
  'updated_at',
].join(', ');

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
  // LOG-06 — the season window and the pre-order slot.
  'season_start_month',
  'season_end_month',
  'preorder_enabled',
  'preorder_available_from',
  'preorder_capacity',
  'preorder_committed',
].join(', ');

const normalizePublicUrls = (images) => {
  if (!Array.isArray(images)) {
    return [];
  }

  const seen = new Set();
  const normalized = [];
  for (const entry of images) {
    if (typeof entry !== 'string') {
      continue;
    }
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
    if (normalized.length >= MAX_PROFILE_IMAGES) {
      break;
    }
  }
  return normalized;
};

const fetchUserRow = async (userId) => {
  const { data: user, error } = await supabase
    .from(TABLES.users)
    .select('id, username, email')
    .eq('id', userId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message || 'Unable to load user.');
  }
  return user || null;
};

const fetchFarmerByUserId = async (userId) => {
  const { data: farmer, error } = await supabase
    .from(TABLES.farmers)
    .select(FARMER_COLUMNS)
    .eq('id', userId)
    .maybeSingle();

  if (error && error.code !== 'PGRST116') {
    throw new Error(error.message || 'Unable to load farmer profile.');
  }
  return farmer || null;
};

const fetchFarmerRequestByUserId = async (userId) => {
  const { data: request, error } = await supabase
    .from(TABLES.farmerRequests)
    .select(REQUEST_COLUMNS)
    .eq('user_id', userId)
    .maybeSingle();

  if (error && error.code !== 'PGRST116') {
    throw new Error(error.message || 'Unable to load farmer request.');
  }
  return request || null;
};

const fetchFarmPhotos = async (farmerId) => {
  const { data: photos, error } = await supabase
    .from(TABLES.farmPhotos)
    .select('id, farmer_id, image_url, caption, is_cover')
    .eq('farmer_id', farmerId)
    .order('is_cover', { ascending: false })
    .order('id', { ascending: true });

  if (error) {
    throw new Error(error.message || 'Unable to load farm gallery.');
  }
  return Array.isArray(photos) ? photos : [];
};

const syncFarmPhotos = async (farmerId, imageUrls) => {
  const { error: deleteError } = await supabase
    .from(TABLES.farmPhotos)
    .delete()
    .eq('farmer_id', farmerId);
  if (deleteError) {
    throw new Error(deleteError.message || 'Unable to replace farm photos.');
  }

  if (!Array.isArray(imageUrls) || imageUrls.length === 0) {
    return;
  }

  const rows = imageUrls.map((url, index) => ({
    farmer_id: farmerId,
    image_url: url,
    caption: '',
    is_cover: index === 0,
  }));

  const { error: insertError } = await supabase.from(TABLES.farmPhotos).insert(rows);
  if (insertError) {
    throw new Error(insertError.message || 'Unable to save farm photos.');
  }
};

const getFileExtension = (file) => {
  const ext = path.extname(file.originalname || '').toLowerCase();
  if (ext) {
    return ext;
  }
  if (file.mimetype === 'image/png') {
    return '.png';
  }
  if (file.mimetype === 'image/webp') {
    return '.webp';
  }
  return '.jpg';
};

const isBucketNotFoundError = (error) => {
  const message =
    typeof error?.message === 'string' ? error.message.toLowerCase() : '';
  return message.includes('bucket not found');
};

const uploadToBucket = async ({ bucketNames, uploadPath, file }) => {
  for (const bucket of bucketNames) {
    const { error: uploadError } = await supabase.storage
      .from(bucket)
      .upload(uploadPath, file.buffer, {
        contentType: file.mimetype,
        upsert: false,
      });

    if (uploadError) {
      if (isBucketNotFoundError(uploadError)) {
        continue;
      }
      throw new Error(uploadError.message || 'Upload failed.');
    }

    const { data: publicData } = supabase.storage
      .from(bucket)
      .getPublicUrl(uploadPath);
    if (!publicData?.publicUrl) {
      throw new Error('Could not resolve public URL for uploaded image.');
    }
    return publicData.publicUrl;
  }

  throw new Error(`Bucket not found. Tried: ${bucketNames.join(', ')}`);
};

const resolveVendorResponse = async (farmer, userEmail) => {
  const farmPhotos = await fetchFarmPhotos(farmer.id);
  return {
    ...mapFarmerToVendor(farmer, {
      email: userEmail,
      farmPhotos,
    }),
    // The Stripe state the payouts card renders instead of the old IBAN field.
    payouts: mapConnectState(farmer),
  };
};

const mapRequestToVendorResponse = (request, userEmail = '') => ({
  id: String(request?.user_id || ''),
  farmName: request?.farm_name || '',
  displayName: request?.display_name || request?.farm_name || '',
  streetAddress: request?.street_address || '',
  streetNumber: request?.street_number || '',
  county: request?.county || '',
  city: request?.city || '',
  phoneNumber: request?.phone_number || '',
  email: request?.email || userEmail || '',
  organicCertificate: request?.organic_certificate || '',
  deliveryRadiusKm: toNumberOrNull(request?.delivery_radius_km),
  bio: request?.bio || '',
  farmImages: normalizePublicUrls(request?.farm_images),
  documents: request?.documents || {},
  // A farm still awaiting approval has no Stripe account yet; the payouts
  // card renders the "approval first" state from this.
  payouts: mapConnectState({}),
});

const mapRequestMeta = (request) => {
  if (!request) {
    return null;
  }

  return {
    id: String(request.id || ''),
    userId: String(request.user_id || ''),
    status: request.status || 'pending',
    reviewNote: request.review_note || '',
    reviewedAt: request.reviewed_at || null,
    reviewedBy: request.reviewed_by || '',
    createdAt: request.created_at || null,
    updatedAt: request.updated_at || null,
  };
};

router.get('/profile', requireVendor, async (req, res, next) => {
  try {
    const userRow = await fetchUserRow(req.user.id);
    const farmer = await fetchFarmerByUserId(req.user.id);
    const request = await fetchFarmerRequestByUserId(req.user.id);
    const userEmail = userRow?.email || req.user.email || '';

    if (request && request.status !== 'approved') {
      return res.json({
        vendor: mapRequestToVendorResponse(request, userEmail),
        profileApproved: Boolean(farmer),
        requestStatus: request.status || 'pending',
        request: mapRequestMeta(request),
      });
    }

    if (farmer) {
      const vendor = await resolveVendorResponse(farmer, userEmail);
      return res.json({
        vendor,
        profileApproved: true,
        requestStatus: request?.status || 'approved',
        request: mapRequestMeta(request),
      });
    }

    if (request) {
      return res.json({
        vendor: mapRequestToVendorResponse(request, userEmail),
        profileApproved: false,
        requestStatus: request.status || 'pending',
        request: mapRequestMeta(request),
      });
    }

    return res.json({
      vendor: mapRequestToVendorResponse(
        {
          user_id: req.user.id,
          email: userEmail,
          farm_images: [],
        },
        userEmail,
      ),
      profileApproved: false,
      requestStatus: 'not_submitted',
      request: null,
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/upload-image', requireVendor, (req, res) => {
  upload.single('photo')(req, res, async (err) => {
    try {
      if (err instanceof multer.MulterError) {
        return res.status(400).json({ error: `Upload error: ${err.message}` });
      }
      if (err) {
        return res.status(500).json({ error: `Server error: ${err.message}` });
      }
      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded.' });
      }

      const ownerId = String(req.user.id);
      const fileName = `${crypto.randomUUID()}${getFileExtension(req.file)}`;
      const uploadPath = `${ownerId}/products/${fileName}`;
      const publicUrl = await uploadToBucket({
        bucketNames: BUCKET_ALIASES.productPhotos,
        uploadPath,
        file: req.file,
      });

      return res.json({ imageUrl: publicUrl });
    } catch (uploadError) {
      return res.status(500).json({ error: uploadError.message || 'Upload failed.' });
    }
  });
});

router.post('/upload-farm-images', requireVendor, (req, res) => {
  upload.array('photos', MAX_PROFILE_IMAGES)(req, res, async (err) => {
    try {
      if (err instanceof multer.MulterError) {
        return res.status(400).json({ error: `Upload error: ${err.message}` });
      }
      if (err) {
        return res.status(500).json({ error: `Server error: ${err.message}` });
      }
      if (!Array.isArray(req.files) || req.files.length === 0) {
        return res.status(400).json({ error: 'No images uploaded.' });
      }

      const ownerId = String(req.user.id);
      const urls = [];
      for (const file of req.files.slice(0, MAX_PROFILE_IMAGES)) {
        const fileName = `${crypto.randomUUID()}${getFileExtension(file)}`;
        const uploadPath = `${ownerId}/gallery/${fileName}`;
        const publicUrl = await uploadToBucket({
          bucketNames: BUCKET_ALIASES.farmPhotos,
          uploadPath,
          file,
        });
        urls.push(publicUrl);
      }

      return res.json({ images: urls });
    } catch (uploadError) {
      return res.status(500).json({ error: uploadError.message || 'Upload failed.' });
    }
  });
});

router.post('/profile', requireVendor, runUpload(documentUpload.any()), async (req, res, next) => {
  try {
    const {
      farmName,
      displayName,
      streetAddress,
      streetNumber,
      county,
      city,
      phoneNumber,
      email,
      organicCertificate,
      deliveryRadiusKm,
      bio,
    } = req.body || {};

    let farmImages = req.body.farmImages;
    if (typeof farmImages === 'string') {
      try { farmImages = JSON.parse(farmImages); } catch (e) { farmImages = []; }
    }

    if (typeof farmName !== 'string' || !farmName.trim()) {
      return res.status(400).json({ error: 'farmName is required.' });
    }
    if (farmImages !== undefined && !Array.isArray(farmImages)) {
      return res.status(400).json({ error: 'farmImages must be an array of URLs.' });
    }

    // No IBAN is asked for here any more. Bank details are collected by
    // Stripe during Connect onboarding — see routes/connect.js.
    const deliveryRadius = toNumberOrNull(deliveryRadiusKm);
    if (
      deliveryRadiusKm !== undefined &&
      deliveryRadiusKm !== null &&
      deliveryRadiusKm !== '' &&
      (deliveryRadius === null || deliveryRadius < 0)
    ) {
      return res.status(400).json({ error: 'deliveryRadiusKm must be a positive number.' });
    }

    const existingRequest = await fetchFarmerRequestByUserId(req.user.id);
    const normalizedFarmImages =
      farmImages !== undefined
        ? normalizePublicUrls(farmImages)
        : normalizePublicUrls(existingRequest?.farm_images);

    let documents = existingRequest?.documents || {};
    
    // Process new document files
    const files = req.files || [];
    if (files.length > 0) {
      const folderId = crypto.randomUUID();
      for (const file of files) {
        const fieldName = file.fieldname;
        const ext = getFileExtension(file);
        const pathStr = `folder_${folderId}/${fieldName}${ext}`;

        const { error: uploadError } = await supabase.storage
          .from(DOCS_BUCKET)
          .upload(pathStr, file.buffer, {
            contentType: file.mimetype,
            upsert: true,
          });

        if (uploadError) {
          return res.status(500).json({ error: 'File upload failed: ' + uploadError.message });
        }

        // Calea, nu adresa publică: bucket-ul e privat, iar adresa se semnează
        // la cerere, doar pentru adminul autentificat.
        documents[fieldName] = pathStr;
      }
    }

    const requestPayload = {
      user_id: req.user.id,
      farm_name: normalizeText(farmName, 120),
      display_name:
        normalizeText(displayName, 120) || normalizeText(farmName, 120),
      street_address: normalizeText(streetAddress, 200),
      street_number: normalizeText(streetNumber, 40),
      county: normalizeText(county, 120),
      city: normalizeText(city, 120),
      phone_number: normalizeText(phoneNumber, 40),
      email: normalizeText(email, 180),
      organic_certificate: normalizeText(organicCertificate, 200),
      delivery_radius_km: deliveryRadius,
      bio: normalizeText(bio, 1000),
      farm_images: normalizedFarmImages,
      documents: documents,
      status: 'pending',
      review_note: '',
      reviewed_at: null,
      reviewed_by: '',
    };

    const { data: requestRow, error: upsertError } = await supabase
      .from(TABLES.farmerRequests)
      .upsert(requestPayload, { onConflict: 'user_id' })
      .select(REQUEST_COLUMNS)
      .single();

    if (upsertError || !requestRow) {
      return res.status(500).json({ error: upsertError?.message || 'Unable to save request.' });
    }

    const userRow = await fetchUserRow(req.user.id);
    return res.json({
      vendor: mapRequestToVendorResponse(requestRow, userRow?.email || req.user.email || ''),
      profileApproved: false,
      requestStatus: requestRow.status || 'pending',
      request: mapRequestMeta(requestRow),
    });
  } catch (error) {
    return next(error);
  }
});

router.get('/products', requireVendor, async (req, res, next) => {
  try {
    const farmer = await fetchFarmerByUserId(req.user.id);
    if (!farmer) {
      return res.json({ products: [] });
    }

    const { data: products, error } = await supabase
      .from(TABLES.products)
      .select(PRODUCT_COLUMNS)
      .eq('farmer_id', farmer.id)
      .order('id', { ascending: false });
    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.json({
      products: (products || []).map((product) => mapProductToApi(product)),
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/products', requireVendor, async (req, res, next) => {
  try {
    const {
      name,
      category,
      unit,
      available,
      isBio,
      instantBuy,
      quantity,
      price,
      type,
      imageUrl,
    } =
      req.body || {};
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'name is required.' });
    }

    const priceValue = Number(price);
    if (!Number.isFinite(priceValue) || priceValue < 0) {
      return res.status(400).json({ error: 'price must be a positive number.' });
    }
    const quantityValue = Number(quantity);
    if (!Number.isFinite(quantityValue) || quantityValue < 0) {
      return res.status(400).json({ error: 'quantity must be a positive number or zero.' });
    }

    const farmer = await fetchFarmerByUserId(req.user.id);
    if (!farmer) {
      return res.status(400).json({ error: 'Vendor profile is required.' });
    }

    // Check permissions before allowing product creation
    const { data: permissions, error: permError } = await supabase
      .from('permission')
      .select('fruits_and_veggies, eggs, honey')
      .eq('id', farmer.id)
      .single();

    if (permError) {
      return res.status(500).json({ error: 'Unable to verify seller permissions.' });
    }

    if (category === 'fruits_and_vegetables' && !permissions?.fruits_and_veggies) {
      return res.status(403).json({ error: 'You do not have permission to sell Fruits and Vegetables.' });
    }
    if (category === 'eggs' && !permissions?.eggs) {
      return res.status(403).json({ error: 'You do not have permission to sell Eggs.' });
    }
    if (category === 'honey' && !permissions?.honey) {
      return res.status(403).json({ error: 'You do not have permission to sell Honey.' });
    }

    const resolvedCategory = normalizeText(category, 80) || 'fruits_and_vegetables';

    // LEG-04 — food information is not optional, and it has to be there
    // BEFORE the purchase is concluded (Reg. 1169/2011). Refusing the publish
    // is the only enforcement point that works: a product listed without its
    // mandatory particulars is already non-compliant by the time anyone looks.
    const labelCheck = validateLabelling({
      category: resolvedCategory,
      labelling: req.body?.labelling || {},
    });
    if (!labelCheck.ok) {
      return res.status(400).json({
        error: 'This product is missing food information the law requires before it can be sold.',
        code: 'labelling_incomplete',
        missing: labelCheck.missing,
        problems: labelCheck.errors,
        required: requiredFieldsFor(resolvedCategory),
      });
    }

    // "Bio" is a claim, not an adjective. Regulation (EU) 2018/848 requires a
    // certificate from an approved control body; saying it without one is a
    // misleading commercial practice (Law 363/2007). So it is never the
    // farmer's own say-so.
    let organicAllowed = false;
    if (isBio) {
      const { data: certificate } = await supabase
        .from(TABLES.organicCertificates)
        .select('id, state, valid_until')
        .eq('farmer_id', String(farmer.id))
        .in('state', ['pending', 'approved'])
        .maybeSingle();

      const verdict = organicClaimAllowed(certificate);
      if (!verdict.allowed) {
        return res.status(403).json({
          error: ORGANIC_REFUSALS[verdict.reason] || ORGANIC_REFUSALS.no_certificate,
          code: `organic_${verdict.reason}`,
        });
      }
      organicAllowed = true;
    }

    const payload = {
      farmer_id: farmer.id,
      'product name': normalizeText(name, 180),
      category: resolvedCategory,
      type: normalizeText(type, 80),
      Unit: normalizeText(unit, 40) || 'unit',
      quantity: Number(quantityValue.toFixed(2)),
      Price: Number(priceValue.toFixed(2)),
      available: toIntFlag(available !== false),
      instant_buy: Boolean(instantBuy),
      'photo url': typeof imageUrl === 'string' && imageUrl.trim() ? imageUrl.trim() : null,
      labelling: labelCheck.labelling,
      labelling_validated_at: new Date().toISOString(),
      batch_code: normalizeText(req.body?.batchCode, 80),
      'bio check': toIntFlag(organicAllowed),
    };

    const { data: insertedProduct, error: insertError } = await supabase
      .from(TABLES.products)
      .insert(payload)
      .select(PRODUCT_COLUMNS)
      .single();

    if (insertError) {
      return res.status(500).json({ error: insertError.message });
    }

    try {
      await recalculateAndPersistProductRatings({ supabase, tables: TABLES });
    } catch (ratingError) {
      console.error(
        '[ratings] Unable to recalculate product ratings after product insert:',
        ratingError,
      );
    }

    const { data: refreshedProduct, error: refreshedError } = await supabase
      .from(TABLES.products)
      .select(PRODUCT_COLUMNS)
      .eq('id', insertedProduct.id)
      .maybeSingle();

    const responseProduct =
      !refreshedError && refreshedProduct ? refreshedProduct : insertedProduct;

    return res.status(201).json({ product: mapProductToApi(responseProduct) });
  } catch (error) {
    return next(error);
  }
});

router.delete('/products/:productId', requireVendor, async (req, res, next) => {
  try {
    const { productId } = req.params;
    if (!productId) {
      return res.status(400).json({ error: 'productId is required.' });
    }

    const farmer = await fetchFarmerByUserId(req.user.id);
    if (!farmer) {
      return res.status(400).json({ error: 'Vendor profile is required.' });
    }

    const { data: deletedRows, error: deleteError } = await supabase
      .from(TABLES.products)
      .delete()
      .eq('id', productId)
      .eq('farmer_id', farmer.id)
      .select(PRODUCT_COLUMNS);

    if (deleteError) {
      return res.status(500).json({ error: deleteError.message });
    }

    const deletedProduct = Array.isArray(deletedRows) ? deletedRows[0] : null;
    if (!deletedProduct) {
      return res.status(404).json({ error: 'Product not found.' });
    }

    try {
      await recalculateAndPersistProductRatings({ supabase, tables: TABLES });
    } catch (ratingError) {
      console.error(
        '[ratings] Unable to recalculate product ratings after product delete:',
        ratingError,
      );
    }

    return res.json({ product: mapProductToApi(deletedProduct) });
  } catch (error) {
    return next(error);
  }
});

/**
 * OPS-06 — when this farm is open, and how much it can take.
 *
 * Every default is "no restriction": every farm that exists today has none
 * configured, and none of them should suddenly go dark because a column
 * appeared.
 */
router.get('/availability', requireVendor, async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from(TABLES.farmers)
      .select('id, working_hours, closed_dates, daily_order_capacity, lead_time_hours, suspended_at, suspended_reason, suspension_effective_at')
      .eq('id', req.user.id)
      .maybeSingle();

    if (error || !data) {
      return res.status(404).json({ error: 'Farm profile not found.' });
    }

    return res.json({
      availability: serializeAvailability(data),
      // OPS-03 / P2B art. 4 — a suspended farm is told why, and when it takes
      // effect. Finding out by watching your sales stop is not a statement of
      // reasons.
      suspension: data.suspended_at
        ? {
            suspendedAt: data.suspended_at,
            reason: data.suspended_reason || '',
            effectiveAt: data.suspension_effective_at || null,
          }
        : null,
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/availability', requireVendor, async (req, res, next) => {
  try {
    const parsed = parseAvailabilityInput(req.body || {});
    if (!parsed.ok) {
      return res.status(400).json({ error: parsed.error });
    }

    const { error } = await supabase
      .from(TABLES.farmers)
      .update(parsed.patch)
      .eq('id', req.user.id);

    if (error) {
      return res.status(500).json({ error: 'Unable to save your availability.' });
    }

    await recordAudit({
      req,
      actorType: 'farmer',
      actorId: req.user.id,
      action: ACTIONS.FARM_AVAILABILITY_CHANGED,
      entityType: 'farmer',
      entityId: String(req.user.id),
      newValue: `capacity=${parsed.patch.daily_order_capacity}`,
    });

    return res.json({ availability: serializeAvailability(parsed.patch) });
  } catch (error) {
    return next(error);
  }
});

/**
 * LEG-04 — the organic certificate.
 *
 * Uploaded by the farm, checked by an admin, and it expires. The claim turns
 * itself off when it lapses, without anyone having to remember — which is the
 * whole reason this is a record with a date rather than a boolean.
 */
router.get('/organic-certificate', requireVendor, async (req, res, next) => {
  try {
    const { data } = await supabase
      .from(TABLES.organicCertificates)
      .select('id, control_body, certificate_number, valid_from, valid_until, state, review_note, reviewed_at')
      .eq('farmer_id', String(req.user.id))
      .order('created_at', { ascending: false })
      .limit(1);

    const certificate = (data || [])[0] || null;
    const verdict = organicClaimAllowed(certificate);

    return res.json({
      certificate,
      canClaimOrganic: verdict.allowed,
      reason: verdict.allowed ? null : ORGANIC_REFUSALS[verdict.reason] || null,
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/organic-certificate', requireVendor, runUpload(documentUpload.any()), async (req, res, next) => {
  try {
    const controlBody = normalizeText(req.body?.controlBody, 160);
    const certificateNumber = normalizeText(req.body?.certificateNumber, 120);
    const validFrom = normalizeText(req.body?.validFrom, 10);
    const validUntil = normalizeText(req.body?.validUntil, 10);

    if (!controlBody || !certificateNumber) {
      return res.status(400).json({
        error: 'The control body and the certificate number are both required.',
      });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(validUntil)) {
      return res.status(400).json({
        error: 'An expiry date is required — the organic claim ends when the certificate does.',
      });
    }
    if (Date.parse(validUntil) <= Date.now()) {
      return res.status(400).json({ error: 'That certificate has already expired.' });
    }

    // A renewal replaces whatever is there rather than stacking: the partial
    // unique index allows one live certificate per farm.
    await supabase
      .from(TABLES.organicCertificates)
      .delete()
      .eq('farmer_id', String(req.user.id))
      .in('state', ['pending', 'rejected']);

    const { error } = await supabase.from(TABLES.organicCertificates).insert({
      farmer_id: String(req.user.id),
      control_body: controlBody,
      control_body_code: normalizeText(req.body?.controlBodyCode, 40),
      certificate_number: certificateNumber,
      valid_from: validFrom || null,
      valid_until: validUntil,
      state: 'pending',
    });

    if (error) {
      return res.status(500).json({ error: 'Unable to save the certificate.' });
    }

    return res.status(201).json({
      submitted: true,
      message: 'Submitted for review. Your products can be listed as organic once it is approved.',
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
