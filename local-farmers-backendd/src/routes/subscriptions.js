// LOG-06 — recurring baskets.
//
// Not Stripe Subscriptions, deliberately. Stripe's model bills a fixed amount
// on a schedule; a vegetable box is a different amount every week because the
// season decides, goes to a different farm's Connect account, and is skipped
// when someone is away. Each of those is a fight with the abstraction.
//
// So the schedule lives here, and each delivery becomes an ordinary cart the
// customer pays for like any other — which means refunds, disputes, transfers
// and the commission all work exactly as they already do, with no second money
// path to keep correct.
//
// **We never take money for food that does not exist yet.** Charging three
// months up front for vegetables nobody has grown makes us a deposit-taker
// rather than a marketplace, and it makes a farm's bad season the customer's
// loss.

const express = require('express');

const { requireAuth } = require('../middleware/auth');
const { supabase, TABLES } = require('../lib/supabase');
const { parseSubscriptionInput, nextDeliveryDate } = require('../lib/seasonality');
const { ACTIONS, recordAudit } = require('../lib/audit');

const router = express.Router();

const SUBSCRIPTION_COLUMNS = [
  'id',
  'customer_id',
  'farmer_id',
  'name',
  'items',
  'frequency',
  'delivery_weekday',
  'state',
  'paused_until',
  'next_delivery_date',
  'last_generated_date',
  'max_deliveries',
  'deliveries_generated',
  'created_at',
].join(', ');

const mapSubscription = (row) => ({
  id: String(row.id),
  farmerId: String(row.farmer_id),
  name: row.name || '',
  items: Array.isArray(row.items) ? row.items : [],
  frequency: row.frequency,
  deliveryWeekday: Number(row.delivery_weekday ?? 6),
  state: row.state,
  pausedUntil: row.paused_until || null,
  nextDeliveryDate: row.next_delivery_date || null,
  deliveriesGenerated: Number(row.deliveries_generated || 0),
  maxDeliveries: row.max_deliveries === null ? null : Number(row.max_deliveries),
  createdAt: row.created_at || null,
});

const loadOwnSubscription = async (id, userId) => {
  const { data } = await supabase
    .from(TABLES.subscriptions)
    .select(SUBSCRIPTION_COLUMNS)
    .eq('id', String(id))
    .maybeSingle();

  if (!data || String(data.customer_id) !== String(userId)) {
    return null;
  }
  return data;
};

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const column = req.user.role === 'vendor' ? 'farmer_id' : 'customer_id';
    const { data, error } = await supabase
      .from(TABLES.subscriptions)
      .select(SUBSCRIPTION_COLUMNS)
      .eq(column, String(req.user.id))
      .order('created_at', { ascending: false });

    if (error) {
      return res.status(500).json({ error: 'Unable to load your baskets.' });
    }

    return res.json({ subscriptions: (data || []).map(mapSubscription) });
  } catch (error) {
    return next(error);
  }
});

/** POST /api/subscriptions — set up a basket that repeats. */
router.post('/', requireAuth, async (req, res, next) => {
  try {
    if (req.user.role !== 'customer') {
      return res.status(403).json({ error: 'Only customer accounts can set up a basket.' });
    }

    const parsed = parseSubscriptionInput(req.body || {});
    if (!parsed.ok) {
      return res.status(400).json({ error: parsed.error });
    }

    // Everything in one basket has to come from one farm: a basket is one
    // delivery, and two farms is two vans.
    const productIds = parsed.value.items.map((item) => item.productId);
    const { data: products } = await supabase
      .from(TABLES.products)
      .select('id, farmer_id, "product name"')
      .in('id', productIds);

    const farmerIds = [...new Set((products || []).map((row) => String(row.farmer_id)))];
    if ((products || []).length !== productIds.length) {
      return res.status(400).json({ error: 'One of those products no longer exists.' });
    }
    if (farmerIds.length !== 1) {
      return res.status(400).json({
        error: 'A recurring basket has to come from a single farm — one basket is one delivery.',
        code: 'multiple_farms',
      });
    }

    const first = nextDeliveryDate({
      weekday: parsed.value.deliveryWeekday,
      frequency: parsed.value.frequency,
    });

    const { data: created, error } = await supabase
      .from(TABLES.subscriptions)
      .insert({
        customer_id: String(req.user.id),
        farmer_id: farmerIds[0],
        name: parsed.value.name,
        items: parsed.value.items,
        frequency: parsed.value.frequency,
        delivery_weekday: parsed.value.deliveryWeekday,
        next_delivery_date: first.date.toISOString().slice(0, 10),
        max_deliveries: parsed.value.maxDeliveries,
        state: 'active',
      })
      .select(SUBSCRIPTION_COLUMNS)
      .single();

    if (error) {
      return res.status(500).json({ error: 'Unable to create the basket.' });
    }

    await recordAudit({
      req,
      actorType: 'customer',
      actorId: req.user.id,
      action: ACTIONS.SUBSCRIPTION_CREATED,
      entityType: 'subscription',
      entityId: String(created.id),
      newValue: `${parsed.value.frequency}:${farmerIds[0]}`,
    });

    return res.status(201).json({
      subscription: mapSubscription(created),
      note: 'Each delivery is paid for separately, at the price on the day. Nothing is charged now.',
    });
  } catch (error) {
    return next(error);
  }
});

/**
 * PATCH /api/subscriptions/:id — pause, resume, or change the day.
 *
 * Pausing rather than cancelling is the point: someone away for three weeks
 * should not have to rebuild the basket when they get back.
 */
router.patch('/:subscriptionId', requireAuth, async (req, res, next) => {
  try {
    const subscription = await loadOwnSubscription(req.params.subscriptionId, req.user.id);
    if (!subscription) {
      return res.status(404).json({ error: 'Basket not found.' });
    }
    if (subscription.state === 'cancelled') {
      return res.status(409).json({ error: 'This basket has been cancelled.', code: 'cancelled' });
    }

    const patch = {};

    if (req.body?.state === 'paused' || req.body?.state === 'active') {
      patch.state = req.body.state;
      if (req.body.state === 'active') {
        patch.paused_until = null;
      }
    }

    if (req.body?.pausedUntil) {
      const value = String(req.body.pausedUntil).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return res.status(400).json({ error: 'pausedUntil must look like 2026-09-01.' });
      }
      patch.paused_until = value;
      patch.state = 'paused';
    }

    if (req.body?.deliveryWeekday !== undefined) {
      const weekday = Number(req.body.deliveryWeekday);
      if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
        return res.status(400).json({ error: 'deliveryWeekday must be 0 to 6.' });
      }
      patch.delivery_weekday = weekday;
      const next = nextDeliveryDate({ weekday, frequency: subscription.frequency });
      patch.next_delivery_date = next.date.toISOString().slice(0, 10);
    }

    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'Nothing to change.' });
    }

    const { error } = await supabase
      .from(TABLES.subscriptions)
      .update(patch)
      .eq('id', String(subscription.id));

    if (error) {
      return res.status(500).json({ error: 'Unable to update the basket.' });
    }

    return res.json({ updated: true, state: patch.state || subscription.state });
  } catch (error) {
    return next(error);
  }
});

router.delete('/:subscriptionId', requireAuth, async (req, res, next) => {
  try {
    const subscription = await loadOwnSubscription(req.params.subscriptionId, req.user.id);
    if (!subscription) {
      return res.status(404).json({ error: 'Basket not found.' });
    }

    const { error } = await supabase
      .from(TABLES.subscriptions)
      .update({
        state: 'cancelled',
        cancelled_at: new Date().toISOString(),
        cancel_reason: String(req.body?.reason || 'customer_cancelled').slice(0, 500),
      })
      .eq('id', String(subscription.id));

    if (error) {
      return res.status(500).json({ error: 'Unable to cancel the basket.' });
    }

    await recordAudit({
      req,
      actorType: 'customer',
      actorId: req.user.id,
      action: ACTIONS.SUBSCRIPTION_CANCELLED,
      entityType: 'subscription',
      entityId: String(subscription.id),
    });

    // Cancelling stops future deliveries and touches nothing already paid
    // for — there is no money held in advance to give back.
    return res.json({ cancelled: true });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
