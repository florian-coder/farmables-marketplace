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
const BACKEND_SUPABASE_KEY =
  SUPABASE_SERVICE_ROLE_KEY || SUPABASE_PUBLISHABLE_KEY;

if (!SUPABASE_SERVICE_ROLE_KEY && process.env.NODE_ENV !== 'test') {
  console.warn(
    '[supabase] SUPABASE_SERVICE_ROLE_KEY is not set. Write operations may fail under RLS policies.',
  );
}

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
  // LEG-02/LEG-03 — consent to the legal documents: which version, when, from
  // where. Append-only.
  legalAcceptances: 'legal_acceptances',
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
