-- =====================================================================
-- RUN 2 — ONLY AFTER BOTH APPS ARE DEPLOYED
--
-- This is sql/09_rls_hardening.sql, unchanged, separated so it cannot be run
-- by accident with the rest.
--
-- ⚠ ORDER, AND IT MATTERS:
--     1. run RUN_1_BEFORE_DEPLOY.sql
--     2. deploy the BACKEND  (SSE endpoint + server-side Realtime)
--     3. deploy the FRONTEND (no Supabase client at all any more)
--     4. run THIS file
--
--   Between 3 and 4 nothing is broken — you are simply still exposed.
--   Running this before 3 freezes live updates for anyone mid-session.
-- =====================================================================


-- =====================================================================
-- SEC-01 — ROW-LEVEL SECURITY ON EVERYTHING
--
-- The last remaining *Critical*. New tables (`checkouts`, `order_transfers`,
-- `platform_settings`, `legal_acceptances`) already had RLS on. The seven
-- original ones — `orders`, `order_items`, `order_replies`, `messages`,
-- `conversations`, `farmer_requests`, `products` — were never covered by any
-- migration, which means the publishable key in the JS bundle could **read and
-- write them directly**. Every order, every private message, for everybody.
--
-- ⚠ THIS FILE IS THE SECOND HALF OF A TWO-PART CHANGE. Run it only after the
--   backend carrying the SSE event stream is deployed.
--
--   Enabling RLS on `orders` and `messages` breaks browser Realtime, because
--   our sessions are custom HMAC cookies rather than Supabase Auth: there is no
--   `auth.uid()` for a policy to check against. That is why this was blocked.
--   The fix was to move the subscription server-side — one Realtime connection
--   per backend process, using the service role, fanned out to browsers over
--   Server-Sent Events (`src/lib/eventStream.js`). The browser now holds no
--   database key at all; `@supabase/supabase-js` has been removed from the
--   frontend entirely.
--
--   DEPLOY ORDER:
--     1. deploy the backend (SSE endpoint + server-side subscription)
--     2. deploy the frontend (no Supabase client)
--     3. run THIS file
--   Between 2 and 3 nothing is broken; you are simply still exposed.
--
-- ⚠ The backend MUST have SUPABASE_SERVICE_ROLE_KEY set. It bypasses RLS; the
--   publishable key does not, and after this file it can do nothing whatsoever.
--   The backend now refuses to start without it.
--
-- RUN ONCE, IN FULL, IN THE SUPABASE SQL EDITOR. Idempotent.
-- =====================================================================


-- =====================================================================
-- PART 1/4 — See where you stand first
-- =====================================================================

-- Run this alone, before anything else. It changes nothing.
-- Any `rowsecurity = false` is a table the JS bundle can still read and write.
--
-- select tablename, rowsecurity from pg_tables
-- where schemaname = 'public'
-- order by rowsecurity, tablename;


-- =====================================================================
-- PART 2/4 — RLS on, with no policies
--
-- No policies is the point, not an omission. RLS enabled with zero policies
-- denies everyone except the service role, which bypasses RLS entirely. Since
-- the browser never talks to Postgres any more, "service role only" is the
-- complete and correct answer, and it needs no `auth.uid()` we do not have.
-- =====================================================================

do $$
declare
  t text;
begin
  foreach t in array array[
    -- The seven the audit named.
    'orders',
    'order_items',
    'order_replies',
    'messages',
    'conversations',
    'farmer_requests',
    'products',
    -- Everything else in public, so the answer to "which tables are exposed"
    -- is "none" rather than a list someone has to keep checking.
    'users',
    'farmers',
    'customers',
    'permission',
    'farm_photos',
    'farmer_docs',
    'auth_tokens',
    'audit_log',
    'stripe_events',
    'checkouts',
    'order_transfers',
    'platform_settings',
    'legal_acceptances',
    'refunds',
    'email_outbox',
    'admin_users',
    'admin_backup_codes'
  ]
  loop
    if exists (
      select 1 from pg_tables where schemaname = 'public' and tablename = t
    ) then
      execute format('alter table public.%I enable row level security', t);
      -- Belt and braces: even if a policy is added by accident later, the
      -- roles PostgREST exposes have no grants to use it with.
      execute format('revoke all on public.%I from anon, authenticated', t);
    end if;
  end loop;
end;
$$;


-- =====================================================================
-- PART 3/4 — SEC-03: the documents bucket must be private
--
-- `sql/security_hardening.sql` set this. The audit lists it as UNVERIFIED, so
-- this re-asserts it and PART 4 checks it.
--
-- ⚠ Addresses that were public before the bucket was closed may still be in
--   someone's browser cache or in a CDN. The bucket flag stops new anonymous
--   reads immediately; it cannot un-cache what was already served. If any
--   identity document was ever fetched over a public URL, treat it as
--   disclosed and ask the producer to re-upload.
-- =====================================================================

update storage.buckets set public = false where id = 'docs';


-- =====================================================================
-- PART 4/4 — Verification
-- Run this block separately, after the rest has gone through.
-- =====================================================================

-- -- Must return 0 rows. Anything listed is still readable with the
-- -- publishable key.
-- select tablename from pg_tables
--   where schemaname = 'public' and rowsecurity = false;
--
-- -- The seven from the audit, explicitly:
-- select tablename, rowsecurity from pg_tables
--   where schemaname = 'public'
--     and tablename in ('orders','order_items','order_replies','messages',
--                       'conversations','farmer_requests','products')
--   order by tablename;
--
-- -- SEC-03 — must show public = false:
-- select id, public, file_size_limit from storage.buckets order by id;
--
-- -- Sanity check from the app side, after deploying: sign in, open /orders,
-- -- and confirm updates still arrive live. They come over
-- -- GET /api/events/stream now, not from Supabase — check the Network tab for
-- -- an open `event-stream` request rather than a websocket to supabase.co.
