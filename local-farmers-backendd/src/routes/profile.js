const express = require('express');

const { requireAuth } = require('../middleware/auth');
const { supabase, TABLES } = require('../lib/supabase');
const { normalizeText } = require('../lib/domain');
const { exportUserData, deleteAccount, DELETION_PLAN } = require('../lib/privacy');
const { ACTIONS, recordAudit } = require('../lib/audit');
const { verifyPassword, SESSION_COOKIE_NAME } = require('../lib/auth');

const router = express.Router();

const toCustomerProfile = (customer, user) => ({
  firstName: customer?.name || '',
  lastName: customer?.surname || '',
  streetAddress: customer?.['address street'] || '',
  streetNumber: customer?.['address number'] || '',
  phoneNumber: customer?.['phone number'] || '',
  email: user?.email || '',
  city: customer?.city || '',
  country: customer?.country || '',
  county: customer?.county || '',
});

const upsertCustomerRecord = async (userId, profile) => {
  const payload = {
    id: userId,
    name: profile.firstName,
    surname: profile.lastName,
    'address street': profile.streetAddress,
    'address number': profile.streetNumber,
    'phone number': profile.phoneNumber,
    city: profile.city,
    county: profile.county,
    country: profile.country,
  };

  const { data: existingCustomer, error: lookupError } = await supabase
    .from(TABLES.customers)
    .select('id')
    .eq('id', userId)
    .maybeSingle();

  if (lookupError) {
    throw new Error(lookupError.message || 'Unable to load customer profile.');
  }

  if (existingCustomer?.id) {
    const { error: updateError } = await supabase
      .from(TABLES.customers)
      .update(payload)
      .eq('id', existingCustomer.id);
    if (updateError) {
      throw new Error(updateError.message || 'Unable to update customer profile.');
    }
    return;
  }

  const { error: insertError } = await supabase
    .from(TABLES.customers)
    .insert(payload);
  if (insertError) {
    throw new Error(insertError.message || 'Unable to create customer profile.');
  }
};

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { data: user, error: userError } = await supabase
      .from(TABLES.users)
      .select('id, username, email, user_type')
      .eq('id', req.user.id)
      .maybeSingle();
    if (userError || !user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const { data: customer, error: customerError } = await supabase
      .from(TABLES.customers)
      .select(
        'id, name, surname, "address street", "address number", "phone number", city, county, country',
      )
      .eq('id', user.id)
      .maybeSingle();

    if (customerError && customerError.code !== 'PGRST116') {
      return res.status(500).json({ error: customerError.message });
    }

    return res.json({
      role: req.user.role,
      username: user.username || '',
      profile: toCustomerProfile(customer, user),
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/', requireAuth, async (req, res, next) => {
  try {
    if (req.user.role !== 'customer') {
      return res.status(403).json({
        error: 'Customer profile updates are only available for customer accounts.',
      });
    }

    const {
      firstName,
      lastName,
      streetAddress,
      streetNumber,
      phoneNumber,
      city,
      county,
      country,
      email,
    } = req.body || {};

    const nextProfile = {
      firstName: normalizeText(firstName, 120),
      lastName: normalizeText(lastName, 120),
      streetAddress: normalizeText(streetAddress, 220),
      streetNumber: normalizeText(streetNumber, 60),
      phoneNumber: normalizeText(phoneNumber, 40),
      city: normalizeText(city, 120),
      county: normalizeText(county, 120),
      country: normalizeText(country, 120),
      email: normalizeText(email, 180),
    };

    const missingFields = Object.entries(nextProfile)
      .filter(([, value]) => !value)
      .map(([key]) => key);
    if (missingFields.length > 0) {
      return res.status(400).json({
        error: `Missing required fields: ${missingFields.join(', ')}.`,
      });
    }

    await upsertCustomerRecord(req.user.id, nextProfile);

    const { error: userUpdateError } = await supabase
      .from(TABLES.users)
      .update({ email: nextProfile.email })
      .eq('id', req.user.id);
    if (userUpdateError) {
      return res.status(500).json({ error: userUpdateError.message });
    }

    return res.json({
      role: 'customer',
      username: req.user.username,
      profile: {
        ...toCustomerProfile(
          {
            name: nextProfile.firstName,
            surname: nextProfile.lastName,
            'address street': nextProfile.streetAddress,
            'address number': nextProfile.streetNumber,
            'phone number': nextProfile.phoneNumber,
            city: nextProfile.city,
            county: nextProfile.county,
            country: nextProfile.country,
          },
          { email: nextProfile.email },
        ),
      },
    });
  } catch (error) {
    return next(error);
  }
});

/**
 * GET /api/profile/export — GDPR Art. 20, data portability.
 *
 * A download, not a support ticket. Art. 20 asks for a "structured, commonly
 * used and machine-readable format"; JSON is all three and is what the data
 * already is.
 */
router.get('/export', requireAuth, async (req, res, next) => {
  try {
    const data = await exportUserData(req.user.id);

    await recordAudit({
      req,
      actorType: 'user',
      actorId: req.user.id,
      action: ACTIONS.DATA_EXPORTED,
      entityType: 'user',
      entityId: String(req.user.id),
    });

    // Content-Disposition so the browser saves it rather than rendering a wall
    // of JSON — the point is that the person walks away with the file.
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="farmables-data-${req.user.id}.json"`,
    );
    return res.send(JSON.stringify(data, null, 2));
  } catch (error) {
    return next(error);
  }
});

/**
 * GET /api/profile/deletion-plan — what deleting will and will not erase.
 *
 * Shown before the confirmation, because "delete my account" means different
 * things to different people and the gap between what someone expects and what
 * the law allows is exactly where trust is lost.
 */
router.get('/deletion-plan', requireAuth, (req, res) => {
  res.json({ plan: DELETION_PLAN });
});

/**
 * POST /api/profile/delete — GDPR Art. 17, erasure.
 *
 * Requires the account password. Not ceremony: this is irreversible, and a
 * session left open on a shared laptop should not be enough to destroy
 * someone's account.
 */
router.post('/delete', requireAuth, async (req, res, next) => {
  try {
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!password) {
      return res.status(400).json({
        error: 'Enter your password to confirm. Deleting an account cannot be undone.',
      });
    }

    const { data: account, error: accountError } = await supabase
      .from(TABLES.users)
      .select('id, password')
      .eq('id', req.user.id)
      .maybeSingle();

    if (accountError || !account) {
      return res.status(404).json({ error: 'Account not found.' });
    }

    const matches = await verifyPassword(password, account.password);
    if (!matches) {
      return res.status(401).json({ error: 'That password is not correct.' });
    }

    // An unpaid checkout holds reserved stock, and a paid order that has not
    // arrived is a contract still running. Neither survives an anonymised
    // customer in any useful form.
    const { data: openOrders } = await supabase
      .from(TABLES.orders)
      .select('id, order_state')
      .eq(req.user.role === 'vendor' ? 'farmer_id' : 'client_id', String(req.user.id))
      .in('order_state', ['pending_order', 'received_by_farmer', 'preparing_order', 'in_transit', 'arrived']);

    if (Array.isArray(openOrders) && openOrders.length > 0) {
      return res.status(409).json({
        error:
          `You have ${openOrders.length} order(s) still in progress. ` +
          'Wait for them to complete or cancel them first, then delete your account.',
        code: 'orders_in_progress',
        openOrders: openOrders.length,
      });
    }

    const result = await deleteAccount({
      req,
      userId: req.user.id,
      role: req.user.role,
    });

    if (!result.ok) {
      return res.status(500).json({ error: result.error });
    }

    res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
    return res.json({ deleted: true, plan: result.plan });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
