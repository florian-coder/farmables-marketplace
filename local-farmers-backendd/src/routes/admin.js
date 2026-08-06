const express = require('express');

const { supabase, TABLES } = require('../lib/supabase');
const { mapProductToApi, normalizeIban } = require('../lib/domain');
const { recalculateAndPersistProductRatings } = require('../lib/productRating');
const {
  ADMIN_COOKIE_NAME,
  ADMIN_PASSWORD,
  ADMIN_SESSION_TTL_MS,
  ADMIN_USERNAME,
  createAdminSessionToken,
  requireAdmin,
} = require('../middleware/adminAuth');

const router = express.Router();

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
  'iban',
  'farm_images',
  'documents',
  'status',
  'review_note',
  'reviewed_at',
  'reviewed_by',
  'created_at',
  'updated_at',
].join(', ');

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
  }
  return normalized;
};

const mapRequestMeta = (request, usersById, productsByFarmer = new Map(), permissionsByFarmer = new Map()) => {
  const user = usersById.get(String(request.user_id)) || null;
  const permissions = permissionsByFarmer.get(String(request.user_id)) || null;
  return {
    id: String(request.id || ''),
    userId: String(request.user_id || ''),
    username: user?.username || '',
    status: request.status || 'pending',
    reviewNote: request.review_note || '',
    reviewedAt: request.reviewed_at || null,
    reviewedBy: request.reviewed_by || '',
    createdAt: request.created_at || null,
    updatedAt: request.updated_at || null,
    products: productsByFarmer.get(String(request.user_id)) || [],
    permissions: permissions || { fruits_and_veggies: false, eggs: false, honey: false },
    payload: {
      farmName: request.farm_name || '',
      displayName: request.display_name || request.farm_name || '',
      streetAddress: request.street_address || '',
      streetNumber: request.street_number || '',
      county: request.county || '',
      city: request.city || '',
      phoneNumber: request.phone_number || '',
      email: request.email || user?.email || '',
      organicCertificate: request.organic_certificate || '',
      deliveryRadiusKm:
        request.delivery_radius_km === null || request.delivery_radius_km === undefined
          ? null
          : Number(request.delivery_radius_km),
      bio: request.bio || '',
      farmImages: Array.isArray(request.farm_images) ? request.farm_images : [],
      documents: request.documents || {},
    },
  };
};

const fetchRequestById = async (requestId) => {
  const { data, error } = await supabase
    .from(TABLES.farmerRequests)
    .select(REQUEST_COLUMNS)
    .eq('id', requestId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message || 'Unable to load farmer request.');
  }
  return data || null;
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

router.post('/login', async (req, res) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';

  if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid admin credentials.' });
  }

  const token = createAdminSessionToken();
  const isProduction = process.env.NODE_ENV === 'production';
  res.cookie(ADMIN_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: isProduction ? 'none' : 'lax',
    secure: isProduction,
    maxAge: ADMIN_SESSION_TTL_MS,
    path: '/',
  });

  return res.json({
    authenticated: true,
    username: ADMIN_USERNAME,
  });
});

router.get('/session', requireAdmin, (req, res) =>
  res.json({
    authenticated: true,
    username: req.admin.username,
    expiresAt: req.admin.expiresAt,
  }));

router.post('/logout', requireAdmin, (req, res) => {
  res.clearCookie(ADMIN_COOKIE_NAME, { path: '/' });
  return res.status(204).end();
});

router.get('/farmer-requests', requireAdmin, async (_req, res, next) => {
  try {
    const { data: requests, error: requestsError } = await supabase
      .from(TABLES.farmerRequests)
      .select(REQUEST_COLUMNS)
      .order('updated_at', { ascending: false });

    if (requestsError) {
      return res.status(500).json({ error: requestsError.message || 'Unable to load requests.' });
    }

    const userIds = Array.from(
      new Set((requests || []).map((entry) => String(entry.user_id)).filter(Boolean)),
    );
    const usersById = new Map();
    const productsByFarmer = new Map();
    const permissionsByFarmer = new Map();
    if (userIds.length > 0) {
      const [{ data: users, error: usersError }, { data: products, error: productsError }, { data: permissions, error: permissionsError }] =
        await Promise.all([
          supabase.from(TABLES.users).select('id, username, email').in('id', userIds),
          supabase.from(TABLES.products).select(PRODUCT_COLUMNS).in('farmer_id', userIds),
          supabase.from(TABLES.permissions).select('id, fruits_and_veggies, honey, eggs').in('id', userIds),
        ]);

      if (usersError) {
        return res.status(500).json({ error: usersError.message || 'Unable to load users.' });
      }
      if (productsError) {
        return res.status(500).json({ error: productsError.message || 'Unable to load products.' });
      }
      for (const user of users || []) {
        usersById.set(String(user.id), user);
      }
      for (const product of products || []) {
        const farmerId = String(product.farmer_id || '');
        if (!farmerId) {
          continue;
        }
        const list = productsByFarmer.get(farmerId) || [];
        list.push(mapProductToApi(product));
        productsByFarmer.set(farmerId, list);
      }
      for (const perm of permissions || []) {
        permissionsByFarmer.set(String(perm.id), perm);
      }
    }

    return res.json({
      requests: (requests || []).map((entry) => mapRequestMeta(entry, usersById, productsByFarmer, permissionsByFarmer)),
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/farmer-requests/:requestId/approve', requireAdmin, async (req, res, next) => {
  try {
    const requestId = typeof req.params?.requestId === 'string' ? req.params.requestId.trim() : '';
    if (!requestId) {
      return res.status(400).json({ error: 'requestId is required.' });
    }

    const request = await fetchRequestById(requestId);
    if (!request) {
      return res.status(404).json({ error: 'Request not found.' });
    }

    const farmerPayload = {
      id: request.user_id,
      'farm name': request.farm_name || '',
      'display name': request.display_name || request.farm_name || '',
      'street address': request.street_address || '',
      'street number': request.street_number || '',
      county: request.county || '',
      city: request.city || '',
      'phone number': request.phone_number || '',
      email: request.email || '',
      'organic operator certificate': request.organic_certificate || '',
      'delivery radius': request.delivery_radius_km,
      bio: request.bio || '',
      IBAN: normalizeIban(request.iban),
    };

    const { error: farmerError } = await supabase
      .from(TABLES.farmers)
      .upsert(farmerPayload, { onConflict: 'id' });
    if (farmerError) {
      return res.status(500).json({ error: farmerError.message || 'Unable to approve request.' });
    }
    
    const { data: existingPerms } = await supabase
      .from(TABLES.permissions)
      .select('fruits_and_veggies, eggs, honey')
      .eq('id', request.user_id)
      .single();

    // Set initial permissions during approval based on uploaded documents.
    // If they have eggs doc, allow eggs. If they have honey doc, allow honey.
    // Fruits and veggies are generally open to any registered individual.
    // Merge with any permissions the admin might have already granted during the pending phase.
    const permissionPayload = {
      id: request.user_id,
      fruits_and_veggies: existingPerms?.fruits_and_veggies || true, 
      eggs: existingPerms?.eggs || !!request.documents?.sanitary_doc_egg,
      honey: existingPerms?.honey || !!request.documents?.sanitary_doc_honey,
    };
    
    const { error: permissionError } = await supabase
      .from(TABLES.permissions)
      .upsert(permissionPayload, { onConflict: 'id' });
      
    if (permissionError) {
      console.error('[admin] Failed to set initial permissions:', permissionError);
    }

    const docsPayload = {
      id: request.user_id,
      atestat_prod: request.documents?.atestat_prod || null,
      atestat_prod_2: request.documents?.atestat_prod_2 || null,
      certificat_register: request.documents?.certificat_register || null,
      cui: request.documents?.cui || null,
      carnet_commerce: request.documents?.carnet_commerce || null,
      sanitary_doc_egg: request.documents?.sanitary_doc_egg || null,
      sanitary_doc_honey: request.documents?.sanitary_doc_honey || null,
    };
    
    const { error: docsError } = await supabase
      .from('farmer_docs')
      .upsert(docsPayload, { onConflict: 'id' });
      
    if (docsError) {
      console.error('[admin] Failed to save farmer docs on approval:', docsError);
    }

    await syncFarmPhotos(request.user_id, normalizePublicUrls(request.farm_images));

    if (request.email) {
      const { error: userEmailError } = await supabase
        .from(TABLES.users)
        .update({ email: request.email })
        .eq('id', request.user_id);
      if (userEmailError) {
        return res.status(500).json({ error: userEmailError.message || 'Unable to update email.' });
      }
    }

    const now = new Date().toISOString();
    const { data: updatedRequest, error: updateRequestError } = await supabase
      .from(TABLES.farmerRequests)
      .update({
        status: 'approved',
        review_note: '',
        reviewed_at: now,
        reviewed_by: req.admin.username,
      })
      .eq('id', requestId)
      .select(REQUEST_COLUMNS)
      .single();

    if (updateRequestError) {
      return res.status(500).json({ error: updateRequestError.message || 'Unable to update request status.' });
    }

    const { data: users } = await supabase
      .from(TABLES.users)
      .select('id, username, email')
      .eq('id', request.user_id)
      .limit(1);
    const usersById = new Map();
    for (const user of users || []) {
      usersById.set(String(user.id), user);
    }

    return res.json({
      request: mapRequestMeta(updatedRequest, usersById),
    });
  } catch (error) {
    return next(error);
  }
});

router.delete('/farmer-requests/:requestId/farm', requireAdmin, async (req, res, next) => {
  try {
    const requestId = typeof req.params?.requestId === 'string' ? req.params.requestId.trim() : '';
    if (!requestId) {
      return res.status(400).json({ error: 'requestId is required.' });
    }

    const request = await fetchRequestById(requestId);
    if (!request) {
      return res.status(404).json({ error: 'Request not found.' });
    }
    if (request.status !== 'approved') {
      return res.status(400).json({ error: 'Only approved farms can be deleted.' });
    }

    const farmerId = request.user_id;
    const { data: deletedProducts, error: deleteProductsError } = await supabase
      .from(TABLES.products)
      .delete()
      .eq('farmer_id', farmerId)
      .select('id');
    if (deleteProductsError) {
      return res.status(500).json({ error: deleteProductsError.message || 'Unable to delete farm products.' });
    }

    const { error: deleteFarmPhotosError } = await supabase
      .from(TABLES.farmPhotos)
      .delete()
      .eq('farmer_id', farmerId);
    if (deleteFarmPhotosError) {
      return res.status(500).json({ error: deleteFarmPhotosError.message || 'Unable to delete farm photos.' });
    }

    const { error: deleteFarmerError } = await supabase
      .from(TABLES.farmers)
      .delete()
      .eq('id', farmerId);
    if (deleteFarmerError) {
      return res.status(500).json({ error: deleteFarmerError.message || 'Unable to delete farm.' });
    }

    const { error: deleteRequestError } = await supabase
      .from(TABLES.farmerRequests)
      .delete()
      .eq('id', requestId);
    if (deleteRequestError) {
      return res.status(500).json({ error: deleteRequestError.message || 'Unable to delete approved request.' });
    }

    if (Array.isArray(deletedProducts) && deletedProducts.length > 0) {
      try {
        await recalculateAndPersistProductRatings({ supabase, tables: TABLES });
      } catch (ratingError) {
        console.error(
          '[ratings] Unable to recalculate product ratings after farm delete:',
          ratingError,
        );
      }
    }

    return res.json({
      deleted: {
        requestId,
        farmerId: String(farmerId || ''),
        products: Array.isArray(deletedProducts) ? deletedProducts.length : 0,
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.patch('/farmer-requests/:requestId/permissions', requireAdmin, async (req, res, next) => {
  try {
    const requestId = typeof req.params?.requestId === 'string' ? req.params.requestId.trim() : '';
    if (!requestId) {
      return res.status(400).json({ error: 'requestId is required.' });
    }

    const request = await fetchRequestById(requestId);
    if (!request) {
      return res.status(404).json({ error: 'Request not found.' });
    }
    if (request.status !== 'approved' && request.status !== 'pending') {
      return res.status(400).json({ error: 'Permissions can only be changed for approved or pending farms.' });
    }

    const { fruits_and_veggies, eggs, honey } = req.body;

    const payload = {};
    if (typeof fruits_and_veggies === 'boolean') payload.fruits_and_veggies = fruits_and_veggies;
    if (typeof eggs === 'boolean') payload.eggs = eggs;
    if (typeof honey === 'boolean') payload.honey = honey;

    if (Object.keys(payload).length === 0) {
      return res.status(400).json({ error: 'No valid permissions provided to update.' });
    }

    const { data: updatedPermissions, error: updateError } = await supabase
      .from(TABLES.permissions)
      .update(payload)
      .eq('id', request.user_id)
      .select()
      .single();

    if (updateError) {
      return res.status(500).json({ error: updateError.message || 'Unable to update permissions.' });
    }

    return res.json({ permissions: updatedPermissions });
  } catch (error) {
    return next(error);
  }
});

router.delete('/products/:productId', requireAdmin, async (req, res, next) => {
  try {
    const productId = typeof req.params?.productId === 'string' ? req.params.productId.trim() : '';
    if (!productId) {
      return res.status(400).json({ error: 'productId is required.' });
    }

    const { data: deletedRows, error: deleteError } = await supabase
      .from(TABLES.products)
      .delete()
      .eq('id', productId)
      .select(PRODUCT_COLUMNS);

    if (deleteError) {
      return res.status(500).json({ error: deleteError.message || 'Unable to delete product.' });
    }

    const deletedProduct = Array.isArray(deletedRows) ? deletedRows[0] : null;
    if (!deletedProduct) {
      return res.status(404).json({ error: 'Product not found.' });
    }

    try {
      await recalculateAndPersistProductRatings({ supabase, tables: TABLES });
    } catch (ratingError) {
      console.error(
        '[ratings] Unable to recalculate product ratings after admin product delete:',
        ratingError,
      );
    }

    return res.json({
      product: mapProductToApi(deletedProduct),
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/farmer-requests/:requestId/reject', requireAdmin, async (req, res, next) => {
  try {
    const requestId = typeof req.params?.requestId === 'string' ? req.params.requestId.trim() : '';
    if (!requestId) {
      return res.status(400).json({ error: 'requestId is required.' });
    }

    const request = await fetchRequestById(requestId);
    if (!request) {
      return res.status(404).json({ error: 'Request not found.' });
    }

    const reviewNote =
      typeof req.body?.reviewNote === 'string' ? req.body.reviewNote.trim().slice(0, 1000) : '';
    if (!reviewNote) {
      return res.status(400).json({ error: 'reviewNote is required when rejecting a request.' });
    }

    const now = new Date().toISOString();
    const { data: updatedRequest, error: updateRequestError } = await supabase
      .from(TABLES.farmerRequests)
      .update({
        status: 'rejected',
        review_note: reviewNote,
        reviewed_at: now,
        reviewed_by: req.admin.username,
      })
      .eq('id', requestId)
      .select(REQUEST_COLUMNS)
      .single();

    if (updateRequestError) {
      return res.status(500).json({ error: updateRequestError.message || 'Unable to reject request.' });
    }

    const { data: users } = await supabase
      .from(TABLES.users)
      .select('id, username, email')
      .eq('id', request.user_id)
      .limit(1);
    const usersById = new Map();
    for (const user of users || []) {
      usersById.set(String(user.id), user);
    }

    return res.json({
      request: mapRequestMeta(updatedRequest, usersById),
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
