const express = require('express');

const { supabase, TABLES } = require('../lib/supabase');
const { mapProductToApi } = require('../lib/domain');
const { ACTIONS, recordAudit } = require('../lib/audit');
const { adminAuthLimiter, usernameLimiter } = require('../middleware/rateLimit');

const DOCS_BUCKET = 'docs';
const SIGNED_URL_TTL_SECONDS = 120;

/** Acceptă și adresele publice salvate înainte de migrarea la bucket privat. */
const toStoragePath = (value) => {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) {
    return '';
  }
  const marker = `/${DOCS_BUCKET}/`;
  const index = raw.indexOf(marker);
  return index !== -1 ? decodeURIComponent(raw.slice(index + marker.length)) : raw;
};
const { recalculateAndPersistProductRatings } = require('../lib/productRating');
const { issueRefund, cancelPaidOrder, loadOrderForRefund } = require('../lib/refunds');
const { evaluateTransition } = require('../lib/orderState');
const { notifyFarmApproved, notifyFarmRejected } = require('../lib/notifications');
const { DISPUTE_COLUMNS, mapDispute, resolveDispute } = require('../lib/disputes');
const {
  ADMIN_COOKIE_NAME,
  ADMIN_SESSION_TTL_MS,
  SCOPES,
  createAdminSessionToken,
  ipAllowed,
  requireAdmin,
  requireAdminEnrolling,
} = require('../middleware/adminAuth');
const {
  authenticateAdmin,
  findAdmin,
  beginTotpEnrolment,
  completeTotpEnrolment,
  issueBackupCodes,
} = require('../lib/adminAccounts');

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

const setAdminCookie = (res, token) => {
  const isProduction = process.env.NODE_ENV === 'production';
  res.cookie(ADMIN_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: isProduction ? 'none' : 'lax',
    secure: isProduction,
    maxAge: ADMIN_SESSION_TTL_MS,
    path: '/',
  });
};

/** Refusal reasons, mapped to something a human can act on. */
const LOGIN_FAILURES = {
  invalid_credentials: { status: 401, error: 'Invalid admin credentials.' },
  invalid_second_factor: { status: 401, error: 'That code is not correct.' },
  code_already_used: {
    status: 401,
    // Said plainly rather than as "invalid": someone who typed the right code
    // and was refused needs to know it is not their mistake.
    error: 'That code has already been used. Wait for the next one.',
  },
  disabled: { status: 403, error: 'This admin account has been disabled.' },
  locked: {
    status: 423,
    error: 'This account is locked after too many failed attempts. Another admin must unlock it.',
  },
};

/**
 * SEC-12 — admin sign-in with a second factor.
 *
 * The environment credential is no longer a login: it can only bootstrap the
 * first `admin_users` row, and that row must enrol in TOTP before it can do
 * anything. The password is in git history and is treated as public.
 */
router.post('/login', adminAuthLimiter, usernameLimiter, async (req, res, next) => {
  try {
    const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const token = typeof req.body?.token === 'string' ? req.body.token : '';
    const backupCode = typeof req.body?.backupCode === 'string' ? req.body.backupCode : '';

    if (!ipAllowed(req)) {
      return res.status(401).json({ error: 'Invalid admin credentials.' });
    }

    const result = await authenticateAdmin({
      username,
      password,
      token,
      backupCode,
      ip: req.ip,
    });

    if (!result.ok) {
      await recordAudit({
        req,
        actorType: 'admin',
        actorId: username.slice(0, 60),
        action: ACTIONS.ADMIN_LOGIN_FAILED,
        entityType: 'admin',
        newValue: result.reason,
      });
      const failure = LOGIN_FAILURES[result.reason] || LOGIN_FAILURES.invalid_credentials;
      return res.status(failure.status).json({ error: failure.error, code: result.reason });
    }

    // Password accepted but no second factor yet: a session that can reach the
    // enrolment routes and nothing else.
    if (result.needsEnrolment) {
      setAdminCookie(
        res,
        createAdminSessionToken({
          adminId: result.admin.id,
          username: result.admin.username,
          scope: SCOPES.ENROL,
        }),
      );
      return res.json({
        authenticated: false,
        enrolmentRequired: true,
        username: result.admin.username,
      });
    }

    await recordAudit({
      req,
      actorType: 'admin',
      actorId: result.admin.username,
      action: ACTIONS.ADMIN_LOGIN,
      entityType: 'admin',
      entityId: String(result.admin.id),
      newValue: result.usedBackupCode ? 'backup_code' : 'totp',
    });

    setAdminCookie(
      res,
      createAdminSessionToken({
        adminId: result.admin.id,
        username: result.admin.username,
        scope: SCOPES.FULL,
      }),
    );

    return res.json({
      authenticated: true,
      username: result.admin.username,
      // Worth surfacing: a backup code is a one-shot, and the admin should
      // know how many they have left before they run out entirely.
      usedBackupCode: Boolean(result.usedBackupCode),
    });
  } catch (error) {
    return next(error);
  }
});

/** Start TOTP enrolment. Password-only session is enough to reach this. */
router.post('/2fa/setup', requireAdminEnrolling, async (req, res, next) => {
  try {
    const admin = await findAdmin(req.admin.username);
    if (!admin) {
      return res.status(404).json({ error: 'Admin account not found.' });
    }
    if (admin.totp_enrolled_at) {
      // Enrolled once, required forever. Re-enrolling would be a way to
      // downgrade an account back to a password, from a stolen session.
      return res.status(409).json({
        error: 'This account already has two-factor authentication. Reset it from another admin account.',
        code: 'already_enrolled',
      });
    }

    const { secret, uri } = await beginTotpEnrolment(admin);
    // The secret is shown once, here, so it can be typed into an app that
    // cannot scan. It is never returned again.
    return res.json({ secret, uri });
  } catch (error) {
    return next(error);
  }
});

/** Confirm enrolment with a code, and hand over the backup codes. */
router.post('/2fa/confirm', requireAdminEnrolling, async (req, res, next) => {
  try {
    const admin = await findAdmin(req.admin.username);
    if (!admin) {
      return res.status(404).json({ error: 'Admin account not found.' });
    }

    const result = await completeTotpEnrolment({ admin, token: req.body?.token });
    if (!result.ok) {
      return res.status(400).json({
        error:
          result.reason === 'not_started'
            ? 'Start the setup first.'
            : 'That code is not correct. Check your authenticator app and try again.',
        code: result.reason,
      });
    }

    await recordAudit({
      req,
      actorType: 'admin',
      actorId: admin.username,
      action: ACTIONS.ADMIN_2FA_ENROLLED,
      entityType: 'admin',
      entityId: String(admin.id),
    });

    // Upgrade the session in place: they proved the second factor just now.
    setAdminCookie(
      res,
      createAdminSessionToken({
        adminId: admin.id,
        username: admin.username,
        scope: SCOPES.FULL,
      }),
    );

    return res.json({
      enrolled: true,
      // Shown exactly once. We store only hashes and genuinely cannot recover
      // them — say so, because people assume support can.
      backupCodes: result.backupCodes,
      warning:
        'Save these now. They are shown once and we cannot recover them. Each one works a single time.',
    });
  } catch (error) {
    return next(error);
  }
});

/** Replace the backup codes. Requires a full session, so a live second factor. */
router.post('/2fa/backup-codes', requireAdmin, async (req, res, next) => {
  try {
    const admin = await findAdmin(req.admin.username);
    if (!admin?.totp_enrolled_at) {
      return res.status(409).json({ error: 'Set up two-factor authentication first.' });
    }

    const codes = await issueBackupCodes(admin.id);
    await recordAudit({
      req,
      actorType: 'admin',
      actorId: admin.username,
      action: ACTIONS.ADMIN_2FA_ENROLLED,
      entityType: 'admin',
      entityId: String(admin.id),
      newValue: 'backup_codes_reissued',
    });

    return res.json({ backupCodes: codes });
  } catch (error) {
    return next(error);
  }
});

router.get('/session', requireAdmin, async (req, res, next) => {
  try {
    const admin = await findAdmin(req.admin.username);
    const { data: unused } = await supabase
      .from(TABLES.adminBackupCodes)
      .select('id')
      .eq('admin_id', String(req.admin.adminId))
      .is('used_at', null);

    return res.json({
      authenticated: true,
      username: req.admin.username,
      expiresAt: req.admin.expiresAt,
      twoFactorEnrolled: Boolean(admin?.totp_enrolled_at),
      backupCodesRemaining: Array.isArray(unused) ? unused.length : 0,
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/logout', requireAdminEnrolling, (req, res) => {
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
      // No IBAN is carried over: bank details live at Stripe now. Approving a
      // farm only unlocks the Connect onboarding button on their dashboard —
      // the farm still cannot sell until `charges_enabled` comes back true.
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

    // BIZ-03 — initial permissions, derived from the documents actually
    // uploaded, merged with anything the admin granted during the pending
    // phase.
    //
    // This used to read `existingPerms?.fruits_and_veggies || true`. The
    // `|| true` made the whole expression unconditionally true, so every
    // approved farm got the right to sell fruit and vegetables regardless of
    // what they had uploaded — which made the document check for that
    // category purely decorative. Selling produce requires a producer's
    // certificate or a trade register registration, so that is what is
    // checked here.
    const hasProduceDocs = Boolean(
      request.documents?.atestat_prod ||
        request.documents?.certificat_register ||
        request.documents?.cui,
    );

    const permissionPayload = {
      id: request.user_id,
      fruits_and_veggies: Boolean(existingPerms?.fruits_and_veggies) || hasProduceDocs,
      eggs: Boolean(existingPerms?.eggs) || !!request.documents?.sanitary_doc_egg,
      honey: Boolean(existingPerms?.honey) || !!request.documents?.sanitary_doc_honey,
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

    await recordAudit({
      req,
      actorType: 'admin',
      actorId: req.admin.username,
      action: ACTIONS.FARM_APPROVED,
      entityType: 'farmer_request',
      entityId: requestId,
      newValue: String(request.user_id || ''),
    });

    // OPS-02 — being approved is worth an email; the farmer is not going to
    // keep refreshing the dashboard for days waiting for it.
    await notifyFarmApproved({
      userId: request.user_id,
      farmName: request.farm_name || 'Your farm',
    });

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

/**
 * SEC-03 — Adresă semnată pentru un act al fermierului.
 *
 * Bucket-ul `docs` e privat. Adresa se generează la cerere, expiră în două
 * minute și e legată de o sesiune de admin. Fiecare vizualizare lasă urmă în
 * jurnalul de audit: actele de identitate nu se consultă anonim.
 */
router.get('/farmer-requests/:requestId/documents/:docKey', requireAdmin, async (req, res, next) => {
  try {
    const requestId = typeof req.params?.requestId === 'string' ? req.params.requestId.trim() : '';
    const docKey = typeof req.params?.docKey === 'string' ? req.params.docKey.trim() : '';
    if (!requestId || !docKey) {
      return res.status(400).json({ error: 'requestId and docKey are required.' });
    }

    const request = await fetchRequestById(requestId);
    if (!request) {
      return res.status(404).json({ error: 'Request not found.' });
    }

    const stored = request.documents?.[docKey];
    const path = toStoragePath(stored);
    if (!path) {
      return res.status(404).json({ error: 'Document not found.' });
    }

    const { data, error } = await supabase.storage
      .from(DOCS_BUCKET)
      .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);

    if (error || !data?.signedUrl) {
      return res.status(500).json({ error: error?.message || 'Unable to sign document URL.' });
    }

    await recordAudit({
      req,
      actorType: 'admin',
      actorId: req.admin.username,
      action: ACTIONS.DOCUMENT_VIEWED,
      entityType: 'farmer_request',
      entityId: requestId,
      newValue: docKey,
    });

    return res.json({ url: data.signedUrl, expiresIn: SIGNED_URL_TTL_SECONDS });
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

/**
 * OPS-01b — refunding from the admin panel.
 *
 * The only route that can issue a *partial* refund. A customer or farmer
 * cancelling gets an all-or-nothing decision; deciding that two of five kilos
 * were missing is a judgement call, and judgement calls are made by a person
 * looking at the evidence.
 *
 * `productsBani` is what to give back of the product subtotal. The delivery
 * fee and the proportional commission follow from it — see `refundBreakdown`.
 */
router.post('/orders/:orderId/refund', requireAdmin, async (req, res, next) => {
  try {
    const orderId = String(req.params?.orderId || '').trim();
    if (!orderId) {
      return res.status(400).json({ error: 'orderId is required.' });
    }

    const order = await loadOrderForRefund(orderId);
    if (!order) {
      return res.status(404).json({ error: 'Order not found.' });
    }
    if (!order.paid_at) {
      return res.status(409).json({
        error: 'This order was never paid for, so there is nothing to refund.',
        code: 'not_paid',
      });
    }

    const rawProducts = req.body?.productsBani;
    const refundProductsBani =
      rawProducts === undefined || rawProducts === null || rawProducts === ''
        ? null
        : Number(rawProducts);

    if (refundProductsBani !== null && (!Number.isFinite(refundProductsBani) || refundProductsBani <= 0)) {
      return res.status(400).json({
        error: 'productsBani must be a positive number of bani, or omitted for a full refund.',
      });
    }

    const reason = String(req.body?.reason || '').trim().slice(0, 500);
    if (!reason) {
      return res.status(400).json({ error: 'A reason is required for every refund.' });
    }

    const result = await issueRefund({
      req,
      order,
      reason,
      actorType: 'admin',
      actorId: req.admin.username,
      refundProductsBani,
    });

    if (!result.refunded) {
      // `already_claimed` and `over_refund` are conflicts, not server errors:
      // the request was fine, the order simply is not in a state to accept it.
      const status =
        result.reason === 'already_claimed' || result.reason === 'over_refund' || result.reason === 'nothing_to_refund'
          ? 409
          : 502;
      return res.status(status).json({
        error: result.error || 'The refund could not be completed.',
        code: result.reason,
        detail: result.detail || null,
        breakdown: result.breakdown,
      });
    }

    return res.json({
      refund: {
        id: result.refundId,
        kind: result.breakdown.kind,
        amountBani: result.breakdown.amountBani,
        breakdown: result.breakdown,
        stripeRefundId: result.stripeRefundId,
        reversalId: result.reversalId,
        manualRecoveryNeeded: result.manualRecoveryNeeded,
      },
    });
  } catch (error) {
    return next(error);
  }
});

/**
 * OPS-01b / OPS-03 — cancel an order from the panel, refund included.
 *
 * Goes through the same state machine as everyone else. An admin has more
 * edges available (they can reverse a `received` order after a dispute), but
 * they are edges in the same table, not a bypass around it.
 */
router.post('/orders/:orderId/cancel', requireAdmin, async (req, res, next) => {
  try {
    const orderId = String(req.params?.orderId || '').trim();
    const reason = String(req.body?.reason || '').trim().slice(0, 500);
    if (!orderId) {
      return res.status(400).json({ error: 'orderId is required.' });
    }
    if (!reason) {
      return res.status(400).json({ error: 'A reason is required when an admin cancels an order.' });
    }

    const order = await loadOrderForRefund(orderId);
    if (!order) {
      return res.status(404).json({ error: 'Order not found.' });
    }

    const verdict = evaluateTransition({
      actor: 'admin',
      from: order.order_state,
      to: 'cancelled',
    });
    if (!verdict.ok) {
      return res.status(verdict.status).json({ error: verdict.error, code: verdict.code });
    }

    const outcome = await cancelPaidOrder({
      req,
      orderId,
      actor: 'admin',
      actorId: req.admin.username,
      reason,
      refundRequired: verdict.refundRequired,
    });

    if (!outcome.ok) {
      return res.status(outcome.status || 500).json({ error: outcome.error, code: outcome.code });
    }

    return res.json({ cancelled: true, orderId, refund: outcome.refund || null });
  } catch (error) {
    return next(error);
  }
});

/**
 * OPS-03 — search orders.
 *
 * The first thing anyone handling a complaint needs, and the thing whose
 * absence meant every question started with a database console.
 */
router.get('/orders', requireAdmin, async (req, res, next) => {
  try {
    const state = String(req.query?.state || '').trim();
    const farmerId = String(req.query?.farmerId || '').trim();
    const clientId = String(req.query?.clientId || '').trim();
    const orderId = String(req.query?.orderId || '').trim();

    let query = supabase
      .from(TABLES.orders)
      .select(
        'id, farmer_id, client_id, order_state, checkout_id, products_subtotal_bani, delivery_fee_bani, commission_bani, transfer_amount_bani, transfer_state, refund_state, refunded_bani, paid_at, cancelled_at, cancel_reason, created_at',
      );

    if (orderId) query = query.eq('id', orderId);
    if (state) query = query.eq('order_state', state);
    if (farmerId) query = query.eq('farmer_id', farmerId);
    if (clientId) query = query.eq('client_id', clientId);

    const { data, error } = await query.order('created_at', { ascending: false }).limit(100);
    if (error) {
      return res.status(500).json({ error: 'Unable to search orders.' });
    }

    return res.json({ orders: data || [] });
  } catch (error) {
    return next(error);
  }
});

/** OPS-03 / SEC-11 — the history of one order, straight from the audit log. */
router.get('/orders/:orderId/history', requireAdmin, async (req, res, next) => {
  try {
    const orderId = String(req.params?.orderId || '').trim();
    const { data, error } = await supabase
      .from(TABLES.auditLog)
      .select('actor_type, actor_id, action, old_value, new_value, created_at')
      .eq('entity_id', orderId)
      .order('created_at', { ascending: true });

    if (error) {
      return res.status(500).json({ error: 'Unable to load the order history.' });
    }

    return res.json({ history: data || [] });
  } catch (error) {
    return next(error);
  }
});

/** OPS-03 — the case queue, newest first, escalated cases first of all. */
router.get('/disputes', requireAdmin, async (req, res, next) => {
  try {
    const state = String(req.query?.state || '').trim();
    let query = supabase.from(TABLES.disputes).select(DISPUTE_COLUMNS);
    if (state) {
      query = query.eq('state', state);
    }

    const { data, error } = await query.order('created_at', { ascending: false }).limit(200);
    if (error) {
      return res.status(500).json({ error: 'Unable to load cases.' });
    }

    const disputes = (data || []).map(mapDispute);
    // Escalated first: those are the ones where a farmer stopped replying and
    // a customer has been waiting on us specifically.
    disputes.sort((left, right) => {
      const rank = (entry) => (entry.state === 'escalated' ? 0 : entry.state === 'resolved' ? 2 : 1);
      return rank(left) - rank(right);
    });

    return res.json({ disputes });
  } catch (error) {
    return next(error);
  }
});

/** OPS-03 — decide a case, and move the money if that is the answer. */
router.post('/disputes/:disputeId/resolve', requireAdmin, async (req, res, next) => {
  try {
    const { data: dispute, error } = await supabase
      .from(TABLES.disputes)
      .select(DISPUTE_COLUMNS)
      .eq('id', String(req.params?.disputeId || ''))
      .maybeSingle();

    if (error || !dispute) {
      return res.status(404).json({ error: 'Case not found.' });
    }

    const result = await resolveDispute({
      req,
      dispute,
      adminUsername: req.admin.username,
      resolution: String(req.body?.resolution || ''),
      note: req.body?.note,
      refundProductsBani: req.body?.refundProductsBani,
    });

    if (!result.ok) {
      return res.status(result.status).json({
        error: result.error,
        code: result.code,
        detail: result.detail || null,
      });
    }

    return res.json({ resolved: true, resolution: result.resolution, refund: result.refund });
  } catch (error) {
    return next(error);
  }
});

/**
 * OPS-03 / OPS-07 — read a private conversation, in context, with a reason.
 *
 * This is the most invasive thing an admin can do on this platform, so it is
 * the most tightly bound: it requires an open case or a report to point at, it
 * requires a written reason, and it writes an audit entry naming the admin
 * before it returns a single message. Nobody reads a private conversation
 * anonymously here.
 */
router.get('/conversations/:conversationId', requireAdmin, async (req, res, next) => {
  try {
    const conversationId = String(req.params?.conversationId || '').trim();
    const reason = String(req.query?.reason || '').trim().slice(0, 500);
    const disputeId = String(req.query?.disputeId || '').trim();
    const reportId = String(req.query?.reportId || '').trim();

    if (!reason) {
      return res.status(400).json({
        error: 'A reason is required to open a private conversation.',
        code: 'reason_required',
      });
    }
    if (!disputeId && !reportId) {
      return res.status(400).json({
        error: 'Opening a private conversation requires an open case or a report to point at.',
        code: 'context_required',
      });
    }

    const { data: conversation } = await supabase
      .from(TABLES.conversations)
      .select('id, customer_id, vendor_id, created_at')
      .eq('id', conversationId)
      .maybeSingle();

    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found.' });
    }

    // Logged before the data is returned, not after: a crash between the read
    // and the write must not lose the record of the read.
    await recordAudit({
      req,
      actorType: 'admin',
      actorId: req.admin.username,
      action: ACTIONS.CONVERSATION_VIEWED,
      entityType: 'conversation',
      entityId: conversationId,
      newValue: `${disputeId ? `dispute:${disputeId}` : `report:${reportId}`} — ${reason}`,
    });

    const { data: messages } = await supabase
      .from(TABLES.messages)
      .select('id, sender_user_id, text, created_at')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true });

    return res.json({
      conversation: {
        id: String(conversation.id),
        customerId: String(conversation.customer_id),
        vendorId: String(conversation.vendor_id),
      },
      messages: messages || [],
      // Said back to the admin so it is obvious this was not a quiet look.
      accessLogged: true,
    });
  } catch (error) {
    return next(error);
  }
});

/** OPS-07 — the report queue. */
router.get('/reports', requireAdmin, async (req, res, next) => {
  try {
    const state = String(req.query?.state || 'open').trim();
    const { data, error } = await supabase
      .from(TABLES.messageReports)
      .select(
        'id, message_id, conversation_id, reporter_user_id, reported_user_id, reason, detail, message_snapshot, state, action_taken, reviewed_by, reviewed_at, created_at',
      )
      .eq('state', state)
      .order('created_at', { ascending: false })
      .limit(200);

    if (error) {
      return res.status(500).json({ error: 'Unable to load reports.' });
    }

    return res.json({ reports: data || [] });
  } catch (error) {
    return next(error);
  }
});

router.post('/reports/:reportId/review', requireAdmin, async (req, res, next) => {
  try {
    const state = String(req.body?.state || '').trim();
    if (!['actioned', 'dismissed', 'reviewing'].includes(state)) {
      return res.status(400).json({ error: 'state must be reviewing, actioned or dismissed.' });
    }

    const { error } = await supabase
      .from(TABLES.messageReports)
      .update({
        state,
        action_taken: String(req.body?.actionTaken || '').slice(0, 500),
        reviewed_by: req.admin.username,
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', String(req.params?.reportId || ''));

    if (error) {
      return res.status(500).json({ error: 'Unable to update the report.' });
    }

    return res.json({ reviewed: true });
  } catch (error) {
    return next(error);
  }
});

/**
 * OPS-03 — suspend a farm.
 *
 * Not the same as `charges_enabled`: that is Stripe's field and Stripe
 * overwrites it on every `account.updated`, so a suspension written there
 * would silently undo itself. This is ours.
 *
 * P2B art. 4 requires a statement of reasons, and 30 days' notice unless the
 * suspension is a legal obligation or a repeated breach. `immediate` is the
 * escape hatch for those; it has to be asked for explicitly, so the default is
 * the compliant one.
 */
router.post('/farms/:farmerId/suspend', requireAdmin, async (req, res, next) => {
  try {
    const farmerId = String(req.params?.farmerId || '').trim();
    const reason = String(req.body?.reason || '').trim().slice(0, 1000);
    const immediate = req.body?.immediate === true;

    if (!reason) {
      return res.status(400).json({
        error: 'A statement of reasons is required (P2B Regulation art. 4).',
        code: 'reason_required',
      });
    }

    const now = new Date();
    const effectiveAt = immediate
      ? now
      : new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    const { error } = await supabase
      .from(TABLES.farmers)
      .update({
        suspended_at: now.toISOString(),
        suspended_reason: reason,
        suspended_by: req.admin.username,
        suspension_effective_at: effectiveAt.toISOString(),
        // Immediate suspensions stop sales now. A notice period leaves the
        // farm selling until it takes effect, which is the point of notice.
        ...(immediate ? { charges_enabled: false } : {}),
      })
      .eq('id', farmerId);

    if (error) {
      return res.status(500).json({ error: 'Unable to suspend the farm.' });
    }

    await recordAudit({
      req,
      actorType: 'admin',
      actorId: req.admin.username,
      action: ACTIONS.FARM_SUSPENDED,
      entityType: 'farmer',
      entityId: farmerId,
      newValue: `${immediate ? 'immediate' : '30d_notice'}: ${reason.slice(0, 200)}`,
    });

    return res.json({
      suspended: true,
      effectiveAt: effectiveAt.toISOString(),
      noticeGiven: !immediate,
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/farms/:farmerId/unsuspend', requireAdmin, async (req, res, next) => {
  try {
    const farmerId = String(req.params?.farmerId || '').trim();

    const { error } = await supabase
      .from(TABLES.farmers)
      .update({
        suspended_at: null,
        suspended_reason: '',
        suspended_by: '',
        suspension_effective_at: null,
        // `charges_enabled` is deliberately NOT restored here. It belongs to
        // Stripe, and the next `account.updated` is what should set it — if
        // Stripe is unhappy for its own reasons, lifting our suspension must
        // not paper over that.
      })
      .eq('id', farmerId);

    if (error) {
      return res.status(500).json({ error: 'Unable to lift the suspension.' });
    }

    await recordAudit({
      req,
      actorType: 'admin',
      actorId: req.admin.username,
      action: ACTIONS.FARM_UNSUSPENDED,
      entityType: 'farmer',
      entityId: farmerId,
    });

    return res.json({
      unsuspended: true,
      note: 'The farm can sell again once Stripe reports the account as able to take charges.',
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

    await recordAudit({
      req,
      actorType: 'admin',
      actorId: req.admin.username,
      action: ACTIONS.FARM_REJECTED,
      entityType: 'farmer_request',
      entityId: requestId,
      newValue: reviewNote.slice(0, 200),
    });

    // A rejection with no explanation and no message is how you lose an
    // applicant who would have fixed the one missing document.
    await notifyFarmRejected({
      userId: request.user_id,
      farmName: request.farm_name || 'your farm',
      reviewNote,
    });

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

/**
 * LEG-04 — reviewing an organic certificate.
 *
 * The whole point of the claim needing approval is that somebody actually
 * looks at the document. Approving records who did, and the expiry is what
 * makes the claim end by itself later.
 */
router.get('/organic-certificates', requireAdmin, async (req, res, next) => {
  try {
    const state = String(req.query?.state || 'pending').trim();
    const { data, error } = await supabase
      .from(TABLES.organicCertificates)
      .select('id, farmer_id, control_body, control_body_code, certificate_number, document_path, valid_from, valid_until, state, review_note, created_at')
      .eq('state', state)
      .order('created_at', { ascending: true });

    if (error) {
      return res.status(500).json({ error: 'Unable to load certificates.' });
    }
    return res.json({ certificates: data || [] });
  } catch (error) {
    return next(error);
  }
});

router.post('/organic-certificates/:certificateId/review', requireAdmin, async (req, res, next) => {
  try {
    const approve = req.body?.approve === true;
    const note = String(req.body?.note || '').trim().slice(0, 1000);

    if (!approve && !note) {
      return res.status(400).json({ error: 'A reason is required when rejecting a certificate.' });
    }

    const { data: certificate } = await supabase
      .from(TABLES.organicCertificates)
      .select('id, farmer_id, valid_until')
      .eq('id', String(req.params?.certificateId || ''))
      .maybeSingle();

    if (!certificate) {
      return res.status(404).json({ error: 'Certificate not found.' });
    }
    if (approve && (!certificate.valid_until || Date.parse(certificate.valid_until) <= Date.now())) {
      return res.status(400).json({
        error: 'This certificate has no future expiry date, so approving it would claim nothing.',
      });
    }

    const { error } = await supabase
      .from(TABLES.organicCertificates)
      .update({
        state: approve ? 'approved' : 'rejected',
        review_note: note,
        reviewed_by: req.admin.username,
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', String(certificate.id));

    if (error) {
      return res.status(500).json({ error: 'Unable to record the review.' });
    }

    await recordAudit({
      req,
      actorType: 'admin',
      actorId: req.admin.username,
      action: ACTIONS.ORGANIC_CERTIFICATE_REVIEWED,
      entityType: 'organic_certificate',
      entityId: String(certificate.id),
      newValue: approve ? `approved_until:${certificate.valid_until}` : `rejected:${note.slice(0, 100)}`,
    });

    return res.json({ reviewed: true, approved: approve });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
