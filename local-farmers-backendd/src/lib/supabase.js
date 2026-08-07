const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  'https://haioudiwjgzrcockxuex.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SECRET_KEY ||
  '';
const SUPABASE_PUBLISHABLE_KEY =
  process.env.SUPABASE_PUBLISHABLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  'sb_publishable_SrXQmteKotnJKVZbgLZJUQ_3BNl6B4A';
// SEC-01 — the backend needs the service role key, and there is no longer a
// useful fallback.
//
// This used to fall back to the publishable key with a console warning. That
// was survivable while most tables had RLS switched off; now that every table
// has RLS on with no policies, the publishable key can read and write exactly
// nothing. A process that boots on it looks healthy and fails every single
// query — the same reasoning as `config.js`: not starting beats starting
// broken.
if (!SUPABASE_SERVICE_ROLE_KEY && process.env.NODE_ENV !== 'test') {
  throw new Error(
    [
      'SUPABASE_SERVICE_ROLE_KEY is not set.',
      '',
      'Every table now has row-level security enabled with no policies, so the',
      'publishable key can read and write nothing at all. Booting without the',
      'service role key would produce a process that answers health checks and',
      'fails every query.',
      '',
      'Find it in the Supabase dashboard under Project Settings → API.',
    ].join('\n'),
  );
}

const BACKEND_SUPABASE_KEY = SUPABASE_SERVICE_ROLE_KEY || SUPABASE_PUBLISHABLE_KEY;

const TABLES = {
  users: 'users',
  farmers: 'farmers',
  customers: 'customers',
  products: 'products',
  farmPhotos: 'farm_photos',
  farmerRequests: 'farmer_requests',
  conversations: 'conversations',
  messages: 'messages',
  orders: 'orders',
  orderItems: 'order_items',
  orderReplies: 'order_replies',
  permissions: 'permission',
  authTokens: 'auth_tokens',
  auditLog: 'audit_log',
  stripeEvents: 'stripe_events',
  // Payments foundation. `checkouts` is the parent payment (one card charge,
  // one transfer_group); each `orders` row under it is one farmer's group,
  // with its own subtotal, delivery fee, commission and delivery state.
  checkouts: 'checkouts',
  orderTransfers: 'order_transfers',
  platformSettings: 'platform_settings',
  // OPS-01b — the refund ledger. One row per money-back event, with the
  // Stripe reversal and refund ids that prove it happened.
  refunds: 'refunds',
  // OPS-02 — queued notifications. `event_key` is unique, so a webhook
  // redelivery cannot email the same person twice.
  emailOutbox: 'email_outbox',
  // LEG-02/LEG-03 — consent to the legal documents: which version, when, from
  // where. Append-only.
  legalAcceptances: 'legal_acceptances',
  // SEC-12 — admins as people. One row per human, with their own TOTP secret
  // and their own backup codes, so an audit entry names someone.
  adminUsers: 'admin_users',
  adminBackupCodes: 'admin_backup_codes',
  // OPS-07 — moderation. Reports are the only signal that scales; blocks are
  // personal and one-directional.
  messageReports: 'message_reports',
  userBlocks: 'user_blocks',
  // OPS-03 — disputes, and the private bucket their evidence lives in.
  disputes: 'disputes',
  disputeEvidence: 'dispute_evidence',
  // LEG-04 — "bio" is a claim, and a claim needs a certificate with an expiry.
  organicCertificates: 'organic_certificates',
  // LOG-06 — the basket that repeats. The schedule lives here; each delivery
  // becomes an ordinary checkout, so there is no second money path.
  subscriptions: 'subscriptions',
};

const dedupe = (values) => {
  const seen = new Set();
  const list = [];
  for (const value of values) {
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    list.push(value);
  }
  return list;
};

const BUCKETS = {
  productPhotos: process.env.SUPABASE_BUCKET_PRODUCT_PHOTOS || 'product photos',
  farmPhotos:
    process.env.SUPABASE_BUCKET_FARMER_PHOTOS ||
    process.env.SUPABASE_BUCKET_FARM_PHOTOS ||
    'farmer photos',
};

const BUCKET_ALIASES = {
  productPhotos: dedupe([
    BUCKETS.productPhotos,
    'product photos',
    'product-photos',
    'product_photos',
  ]),
  farmPhotos: dedupe([
    BUCKETS.farmPhotos,
    'farmer photos',
    'farmer-photos',
    'farmer_photos',
    'farm photos',
    'farm-photos',
    'farm_photos',
  ]),
};

const supabase = createClient(SUPABASE_URL, BACKEND_SUPABASE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

module.exports = {
  supabase,
  TABLES,
  BUCKETS,
  BUCKET_ALIASES,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_PUBLISHABLE_KEY,
};
