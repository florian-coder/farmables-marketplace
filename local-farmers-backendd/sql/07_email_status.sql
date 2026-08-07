-- =====================================================================
-- SEC-09b — ACCOUNTS WITH NO REAL EMAIL ADDRESS
--
-- Accounts created before email was collected were given
-- `<username>@localfarmers.app`. That domain accepts no mail. Those accounts
-- are not "unverified" — they are *absent*: the person never chose the
-- address and will never receive anything sent to it.
--
-- Until now `email_verified` was written but never enforced, so these accounts
-- could place an order whose confirmation had nowhere to go — and GEO 34/2014
-- art. 8 requires that confirmation to reach a durable medium.
--
-- RUN ONCE, IN FULL, IN THE SUPABASE SQL EDITOR. Idempotent.
-- NON-DESTRUCTIVE: nobody is locked out. They can still sign in, browse and
-- chat; only checkout asks them to supply a real address first.
-- =====================================================================


-- =====================================================================
-- PART 1/3 — See the scale of it before changing anything
-- =====================================================================

-- Run this first, on its own. It changes nothing.
--
-- select
--   count(*) filter (where email ilike '%@localfarmers.app')      as generated,
--   count(*) filter (where coalesce(email, '') = '')              as empty,
--   count(*) filter (where email_verified)                        as verified,
--   count(*)                                                      as total
-- from public.users
-- where deleted_at is null;


-- =====================================================================
-- PART 2/3 — Make the state explicit
--
-- A generated address must never read as verified. If any of these were
-- flipped to true by an earlier migration or by hand, that is a false claim
-- about an address nobody can receive mail at.
-- =====================================================================

update public.users
set email_verified = false
where email_verified is true
  and (email ilike '%@localfarmers.app' or coalesce(email, '') = '');

-- A partial index so the "please add an address" prompt costs one index scan
-- rather than a sequential one on every request.
create index if not exists users_email_missing_idx
  on public.users (id)
  where email ilike '%@localfarmers.app' or coalesce(email, '') = '';

comment on column public.users.email_verified is
  'SEC-09b — true only after the owner clicked the verification link. Never '
  'true for a generated @localfarmers.app address: that domain accepts no '
  'mail, so those accounts have no address at all until the owner supplies '
  'one. Enforced at checkout (an order confirmation must be deliverable), '
  'never at sign-in.';


-- =====================================================================
-- PART 3/3 — Verification
-- =====================================================================

-- -- Must return 0: no generated address may claim to be verified.
-- select count(*) from public.users
--   where email_verified is true
--     and (email ilike '%@localfarmers.app' or coalesce(email, '') = '');
--
-- -- Who will be asked for an address at checkout:
-- select id, username, email from public.users
--   where deleted_at is null
--     and (email ilike '%@localfarmers.app' or coalesce(email, '') = '')
--   order by username;
