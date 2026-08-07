const express = require('express');

const { supabase, TABLES } = require('../lib/supabase');
const { missingOperatorFields } = require('../lib/operator');

const router = express.Router();

router.get('/', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

/**
 * The things that fail quietly.
 *
 * Not part of `/health` itself: Render polls that one, and a check that hits
 * the database on every poll turns a health probe into load. This is the
 * endpoint a human opens when something feels wrong — a stuck notification
 * queue, a refund that needs collecting by hand, an operator identification
 * block still on placeholders. All three are invisible until someone asks.
 */
router.get('/diagnostics', async (_req, res) => {
  const report = { status: 'ok', checks: {} };

  const count = async (table, apply) => {
    try {
      const query = apply(supabase.from(table).select('id'));
      const { data, error } = await query;
      if (error) {
        return { error: error.message };
      }
      return { count: Array.isArray(data) ? data.length : 0 };
    } catch (error) {
      return { error: error?.message || 'query failed' };
    }
  };

  report.checks.emailsFailed = await count(TABLES.emailOutbox, (q) => q.eq('state', 'failed'));
  report.checks.emailsPending = await count(TABLES.emailOutbox, (q) => q.eq('state', 'pending'));
  report.checks.refundsNeedingRecovery = await count(TABLES.refunds, (q) =>
    q.eq('state', 'refund_pending_manual'),
  );
  report.checks.refundsFailed = await count(TABLES.refunds, (q) => q.eq('state', 'failed'));
  report.checks.transfersFailed = await count(TABLES.orderTransfers, (q) => q.eq('state', 'failed'));

  const missingOperator = missingOperatorFields();
  report.checks.operatorIdentification = missingOperator.length
    ? { missing: missingOperator }
    : { ok: true };

  const degraded =
    missingOperator.length > 0 ||
    Object.values(report.checks).some((check) => check.error || (check.count || 0) > 0);
  report.status = degraded ? 'attention' : 'ok';

  return res.json(report);
});

module.exports = router;
