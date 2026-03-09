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
const { recalculateAndPersistProductRatings } = require('../lib/productRating');

const router = express.Router();

const MAX_PROFILE_IMAGES = 10;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
      return;
    }
    cb(new Error('Invalid file type. Only JPEG, PNG, and WebP are allowed.'));
  },
});

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
  return mapFarmerToVendor(farmer, {
    email: userEmail,
    farmPhotos,
  });
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

router.post('/profile', requireVendor, upload.any(), async (req, res, next) => {
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
          .from('docs')
          .upload(pathStr, file.buffer, {
            contentType: file.mimetype,
            upsert: true,
          });

        if (uploadError) {
          return res.status(500).json({ error: 'File upload failed: ' + uploadError.message });
        }

        const { data: urlData } = supabase.storage.from('docs').getPublicUrl(pathStr);
        documents[fieldName] = urlData.publicUrl;
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

    const payload = {
      farmer_id: farmer.id,
      'product name': normalizeText(name, 180),
      category: normalizeText(category, 80) || 'fruits_and_vegetables',
      type: normalizeText(type, 80),
      Unit: normalizeText(unit, 40) || 'unit',
      quantity: Number(quantityValue.toFixed(2)),
      Price: Number(priceValue.toFixed(2)),
      available: toIntFlag(available !== false),
      'bio check': toIntFlag(Boolean(isBio)),
      instant_buy: Boolean(instantBuy),
      'photo url': typeof imageUrl === 'string' && imageUrl.trim() ? imageUrl.trim() : null,
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

module.exports = router;
