-- =====================================================================
-- RUN 1 — EVERYTHING THAT GOES IN BEFORE THE BACKEND DEPLOY
--
-- Paste this whole file into the Supabase SQL Editor and run it once.
-- It is idempotent: running it a second time changes nothing.
--
-- It is the concatenation of sql/03 through sql/14, minus 09, in dependency
-- order. The individual files are still there and still authoritative — this
-- is a convenience so you paste once instead of eleven times.
--
-- ⚠ 09_rls_hardening.sql IS NOT IN HERE, ON PURPOSE.
--   It turns on row-level security, which cuts the browser's old Supabase
--   Realtime connection. Its replacement (a backend SSE channel) only exists
--   once BOTH apps are deployed. Run it after, from RUN_2_AFTER_DEPLOY.sql.
--
-- ⚠ The backend will not boot without SUPABASE_SERVICE_ROLE_KEY. Set it first.
--
-- What this creates:
--   refunds, email_outbox, admin_users, admin_backup_codes, message_reports,
--   user_blocks, disputes, dispute_evidence, organic_certificates,
--   subscriptions
--   + columns on orders, order_items, products, farmers, users,
--     platform_settings
--   + functions: cancel_order_with_stock, apply_refund_result,
--     claim_due_emails, orders_accepted_today, expire_organic_claims,
--     advance_subscription
--   + the private `dispute-evidence` storage bucket
-- =====================================================================



-- #####################################################################
-- ###  03_refunds.sql
-- #####################################################################

-- =====================================================================
-- OPS-01b — REFUNDS
--
-- Solves: the other half of OPS-01. A paid order already becomes `cancelled`
-- instead of being deleted; what was missing is the money going back and the
-- stock returning to the shelf.
--
-- RUN ONCE, IN FULL, IN THE SUPABASE SQL EDITOR.
-- Idempotent. NON-DESTRUCTIVE — it adds tables, columns and functions only.
--
-- ⚠ RUN THIS BEFORE DEPLOYING THE BACKEND. The backend calls
--    `cancel_order_with_stock`, which does not exist until this file has run,
--    and every cancellation would fail in the meantime.
-- =====================================================================


-- =====================================================================
-- PART 1/5 — `refunds`: one row per money-back event
--
-- The split into products / delivery / commission is not decoration. A refund
-- has to be reconstructable months later: how much went back to the customer,
-- how much was clawed back from the farmer, and how much of our own commission
-- we gave up. One `amount_bani` column would lose all three.
-- =====================================================================

create table if not exists public.refunds (
  id uuid primary key default gen_random_uuid(),

  -- The farmer group being refunded. `checkout_id` is the payment it belongs
  -- to; both are kept because a refund is issued against the PaymentIntent
  -- (checkout) but is always *about* one farmer's group (order).
  order_id uuid not null,
  checkout_id uuid,

  kind text not null check (kind in ('full', 'partial')),

  -- What the customer gets back, itemised.
  products_bani integer not null default 0 check (products_bani >= 0),
  delivery_bani integer not null default 0 check (delivery_bani >= 0),
  commission_bani integer not null default 0 check (commission_bani >= 0),
  amount_bani integer not null check (amount_bani >= 0),

  -- What we take back off the farmer: products + delivery, never commission.
  -- The commission is ours to give up, so it is refunded from our own balance
  -- and never reversed out of the farmer's.
  reversal_amount_bani integer not null default 0 check (reversal_amount_bani >= 0),

  reason text not null default '',
  actor_type text not null default 'system'
    check (actor_type in ('customer', 'farmer', 'admin', 'system')),
  actor_id text not null default '',

  stripe_refund_id text,
  stripe_transfer_reversal_id text,

  -- `refund_pending_manual` is the one that needs a human: the reversal failed
  -- because the farmer had already withdrawn the money, so the customer was
  -- made whole out of the platform balance and the amount has to be recovered
  -- from the farmer by other means.
  state text not null default 'pending'
    check (state in ('pending', 'reversing', 'refunding', 'completed', 'failed', 'refund_pending_manual')),
  last_error text,

  completed_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

-- An order is fully refunded at most once, ever. The insert IS the claim,
-- exactly like `order_transfers.order_id`: whoever inserts first owns the
-- refund and everyone else sees 23505 and stops. A failed attempt is excluded
-- so it can be retried.
create unique index if not exists refunds_one_full_per_order
  on public.refunds (order_id)
  where kind = 'full' and state <> 'failed';

create index if not exists refunds_order_idx on public.refunds (order_id, created_at desc);
create index if not exists refunds_checkout_idx on public.refunds (checkout_id);
create index if not exists refunds_state_idx on public.refunds (state, created_at desc)
  where state in ('pending', 'reversing', 'refunding', 'failed', 'refund_pending_manual');

alter table public.refunds enable row level security;
-- RLS on with no policies: service role only. The browser never reads this.
drop policy if exists refunds_no_public_access on public.refunds;

create or replace function public.set_refunds_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

drop trigger if exists trg_refunds_updated_at on public.refunds;
create trigger trg_refunds_updated_at
before update on public.refunds
for each row
execute function public.set_refunds_updated_at();


-- =====================================================================
-- PART 2/5 — Refund state carried on the order itself
--
-- Duplicated from `refunds` on purpose: the orders list is read constantly and
-- must not need a join to say "refunded". `refunds` remains the ledger.
-- =====================================================================

alter table if exists public.orders
  add column if not exists refunded_bani integer not null default 0
    check (refunded_bani >= 0),
  add column if not exists refund_state text not null default 'none'
    check (refund_state in ('none', 'pending', 'partial', 'refunded', 'failed', 'refund_pending_manual'));

create index if not exists orders_refund_state_idx
  on public.orders (refund_state)
  where refund_state in ('pending', 'failed', 'refund_pending_manual');


-- =====================================================================
-- PART 3/5 — `cancel_order_with_stock`
--
-- Cancelling and restoring stock happen in ONE transaction. Doing them in two
-- statements from Node meant that a crash between them either lost the stock
-- (cancel succeeded, restore did not) or sold it twice (restore succeeded,
-- cancel did not). Neither is recoverable without counting jars by hand.
--
-- `rollback_checkout` only ever handled unpaid checkouts, which is why paid
-- cancellations silently lost stock until now.
-- =====================================================================

create or replace function public.cancel_order_with_stock(
  p_order_id uuid,
  p_cancelled_by text,
  p_reason text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order    public.orders%rowtype;
  v_item     record;
  v_restored integer := 0;
  v_now      timestamptz := timezone('utc', now());
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    return jsonb_build_object('success', false, 'error', 'Order not found.');
  end if;

  -- Idempotent: a second cancellation is a no-op, not a second stock restore.
  if v_order.order_state = 'cancelled' then
    return jsonb_build_object(
      'success', true,
      'already_cancelled', true,
      'order_id', v_order.id,
      'checkout_id', v_order.checkout_id,
      'products_subtotal_bani', v_order.products_subtotal_bani,
      'delivery_fee_bani', v_order.delivery_fee_bani,
      'commission_bani', v_order.commission_bani,
      'transfer_amount_bani', v_order.transfer_amount_bani,
      'transfer_state', v_order.transfer_state,
      'paid_at', v_order.paid_at
    );
  end if;

  -- Stock is only put back when it was actually taken. `placed_order` is a
  -- cart: `process_checkout` never ran, so nothing was reserved and adding
  -- quantity here would invent stock out of nothing.
  if v_order.order_state <> 'placed_order' then
    for v_item in
      select oi.product_id, oi.quantity
      from public.order_items oi
      where oi.order_id = v_order.id
      order by oi.product_id
    loop
      update public.products
      set quantity = quantity + v_item.quantity
      where id::text = v_item.product_id::text;
      v_restored := v_restored + 1;
    end loop;
  end if;

  update public.orders
  set
    order_state = 'cancelled',
    cancelled_at = coalesce(cancelled_at, v_now),
    cancelled_by = p_cancelled_by,
    cancel_reason = left(coalesce(p_reason, ''), 500)
  where id = p_order_id;

  return jsonb_build_object(
    'success', true,
    'already_cancelled', false,
    'restored_items', v_restored,
    'order_id', v_order.id,
    'checkout_id', v_order.checkout_id,
    'previous_state', v_order.order_state,
    'products_subtotal_bani', v_order.products_subtotal_bani,
    'delivery_fee_bani', v_order.delivery_fee_bani,
    'commission_bani', v_order.commission_bani,
    'transfer_amount_bani', v_order.transfer_amount_bani,
    'transfer_state', v_order.transfer_state,
    'paid_at', v_order.paid_at
  );
end;
$$;


-- =====================================================================
-- PART 4/5 — `apply_refund_result`
--
-- Writes the outcome of a refund onto the order in one statement, so the
-- ledger row and the denormalised order columns cannot end up disagreeing
-- about how much has gone back.
-- =====================================================================

create or replace function public.apply_refund_result(
  p_order_id uuid,
  p_refund_state text,
  p_refunded_delta_bani integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total integer;
begin
  update public.orders
  set
    refund_state = p_refund_state,
    refunded_bani = greatest(0, refunded_bani + coalesce(p_refunded_delta_bani, 0))
  where id = p_order_id
  returning refunded_bani into v_total;

  if not found then
    return jsonb_build_object('success', false, 'error', 'Order not found.');
  end if;

  return jsonb_build_object('success', true, 'refunded_bani', v_total);
end;
$$;


-- =====================================================================
-- PART 5/5 — Verification
-- Run separately, after the rest has gone through.
-- =====================================================================

-- select column_name, data_type from information_schema.columns
--   where table_name = 'refunds' order by ordinal_position;
--
-- select column_name from information_schema.columns
--   where table_name = 'orders' and column_name in ('refunded_bani', 'refund_state');
--
-- select proname, pg_get_function_identity_arguments(oid) from pg_proc
--   where proname in ('cancel_order_with_stock', 'apply_refund_result');
--
-- select relname, relrowsecurity from pg_class where relname = 'refunds';
--
-- -- Refunds that need a human (farmer already withdrew the money):
-- select id, order_id, amount_bani, reversal_amount_bani, last_error
--   from public.refunds where state = 'refund_pending_manual';


-- #####################################################################
-- ###  04_email_outbox.sql
-- #####################################################################

-- =====================================================================
-- OPS-02 — THE EMAIL OUTBOX
--
-- Solves: "no notifications at all". Realtime only works while a tab is open,
-- so a farmer could miss an order for days. For perishable goods that is
-- fatal, and it is the only reason a farmer would prefer a free Facebook
-- group over paying us 10%.
--
-- RUN ONCE, IN FULL, IN THE SUPABASE SQL EDITOR.
-- Idempotent. NON-DESTRUCTIVE.
--
-- Can be run before or after the backend deploy: until the table exists,
-- enqueueing logs a warning and the request it belongs to still succeeds.
-- =====================================================================


-- =====================================================================
-- PART 1/3 — `email_outbox`
--
-- Why a table and not just "call Resend":
--
--   * Sending inside the request makes the customer wait on a third party we
--     do not control, and makes a Resend outage look like a checkout outage.
--   * Sending inside a transaction is worse: the email goes out and then the
--     transaction rolls back, so we have told someone about an order that
--     does not exist.
--   * Without a record, a failed send is simply lost. Nobody finds out that
--     the farmer never heard about the order until the customer complains.
--
-- `event_key` is the idempotency claim, the same trick as `stripe_events` and
-- `order_transfers`: the caller derives a stable key from the thing that
-- happened ("order-paid:<order id>"), the unique index refuses the second
-- insert, and a webhook redelivery cannot email the same person twice.
-- =====================================================================

create table if not exists public.email_outbox (
  id uuid primary key default gen_random_uuid(),

  -- Stable, caller-derived. Two attempts to announce the same fact collapse
  -- into one row.
  event_key text not null unique,
  -- Which template rendered it. Kept so a template bug can be found by
  -- querying rather than by reading logs.
  template text not null,

  recipient text not null,
  -- Denormalised so a deleted account (GDPR Art. 17) does not orphan the
  -- queue, and so we can see who a message was for without a join.
  recipient_user_id text not null default '',
  subject text not null,
  body_text text not null,
  body_html text not null default '',

  -- Free-form context the template rendered from, kept for debugging and for
  -- re-rendering if a template is fixed before the message goes out.
  payload jsonb not null default '{}'::jsonb,

  state text not null default 'pending'
    check (state in ('pending', 'sending', 'sent', 'failed', 'cancelled')),

  attempts integer not null default 0 check (attempts >= 0),
  -- Five attempts over roughly a day and a half of backoff. After that a
  -- human has to look: either the address is wrong or the provider is down
  -- for longer than any retry policy can paper over.
  max_attempts integer not null default 5 check (max_attempts > 0),
  -- Nothing is picked up before this. Backoff is written here, not slept on.
  next_attempt_at timestamptz not null default timezone('utc', now()),
  last_error text,

  sent_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

-- The worker's only query: what is due, oldest first.
create index if not exists email_outbox_due_idx
  on public.email_outbox (next_attempt_at)
  where state = 'pending';

create index if not exists email_outbox_state_idx
  on public.email_outbox (state, created_at desc);
create index if not exists email_outbox_recipient_idx
  on public.email_outbox (recipient_user_id, created_at desc);

alter table public.email_outbox enable row level security;
-- RLS on with no policies: service role only.
drop policy if exists email_outbox_no_public_access on public.email_outbox;

create or replace function public.set_email_outbox_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

drop trigger if exists trg_email_outbox_updated_at on public.email_outbox;
create trigger trg_email_outbox_updated_at
before update on public.email_outbox
for each row
execute function public.set_email_outbox_updated_at();


-- =====================================================================
-- PART 2/3 — `claim_due_emails`
--
-- Hands the worker a batch and marks it `sending` in the same statement.
-- `for update skip locked` is what makes two workers safe: the second one
-- steps over the rows the first is holding instead of waiting for them, so a
-- second process (or a redeploy that overlaps) cannot send the same message
-- twice.
-- =====================================================================

create or replace function public.claim_due_emails(p_limit integer default 20)
returns setof public.email_outbox
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  update public.email_outbox o
  set
    state = 'sending',
    attempts = o.attempts + 1
  where o.id in (
    select c.id
    from public.email_outbox c
    where c.state = 'pending'
      and c.next_attempt_at <= timezone('utc', now())
    order by c.next_attempt_at
    limit greatest(1, coalesce(p_limit, 20))
    for update skip locked
  )
  returning o.*;
end;
$$;


-- =====================================================================
-- PART 3/3 — Verification
-- =====================================================================

-- select column_name, data_type from information_schema.columns
--   where table_name = 'email_outbox' order by ordinal_position;
--
-- select proname from pg_proc where proname = 'claim_due_emails';
--
-- -- What is stuck and why:
-- select template, recipient, attempts, last_error, next_attempt_at
--   from public.email_outbox where state = 'failed' order by updated_at desc;
--
-- -- Queue health at a glance:
-- select state, count(*) from public.email_outbox group by state;


-- #####################################################################
-- ###  05_order_maintenance.sql
-- #####################################################################

-- =====================================================================
-- OPS-04 — ORDERS THAT CLOSE THEMSELVES
--
-- Solves: orders stuck in `arrived` forever because the customer got their
-- vegetables and closed the tab. The dispute window never closes, the sale
-- never completes, and a forgotten order is indistinguishable from one with a
-- real problem.
--
-- RUN ONCE, IN FULL, IN THE SUPABASE SQL EDITOR. Idempotent, non-destructive.
-- Safe to run before or after the backend deploy: until it has run, the
-- maintenance job logs that it cannot read the column and does nothing.
-- =====================================================================

alter table if exists public.orders
  -- When the order actually reached the door. `updated_at` moves on every
  -- write — a message, a rating recalculation — so it cannot be the clock a
  -- deadline is measured against.
  add column if not exists arrived_at timestamptz,
  -- Stamped when the platform closed the order instead of the customer.
  -- Kept separate from `received` so a dispute can tell "they confirmed" from
  -- "nobody said anything for a week".
  add column if not exists auto_confirmed_at timestamptz;

-- The maintenance job's only query.
create index if not exists orders_arrived_at_idx
  on public.orders (arrived_at)
  where order_state = 'arrived';

-- Backfill: orders already sitting in `arrived` get their last write as the
-- arrival time. It is the best evidence we have, and it errs towards giving
-- the customer more time rather than less.
update public.orders
set arrived_at = coalesce(arrived_at, updated_at, created_at)
where order_state = 'arrived' and arrived_at is null;


-- =====================================================================
-- Verification
-- =====================================================================

-- select column_name from information_schema.columns
--   where table_name = 'orders' and column_name in ('arrived_at', 'auto_confirmed_at');
--
-- -- What is about to close itself:
-- select id, farmer_id, arrived_at, now() - arrived_at as waiting
--   from public.orders where order_state = 'arrived' order by arrived_at;
--
-- -- What closed on its own, for a monthly sanity check:
-- select count(*) from public.orders where auto_confirmed_at is not null;


-- #####################################################################
-- ###  06_privacy.sql
-- #####################################################################

-- =====================================================================
-- LEG-03 — GDPR: ERASURE AND PORTABILITY
--
-- RUN ONCE, IN FULL, IN THE SUPABASE SQL EDITOR. Idempotent, non-destructive.
--
-- The only schema this needs is a marker for anonymised accounts. The erasure
-- itself is anonymisation in place — see src/lib/privacy.js for why: invoices
-- (Law 82/1991, 10 years), food traceability (Reg. 178/2002) and consent
-- records all have to survive the person, so the identifiers are destroyed
-- and the rows are left pointing at a pseudonym that leads nowhere. Recital 26
-- puts properly anonymised data outside GDPR entirely, which is a stronger
-- outcome than a soft-delete flag anyone with database access can undo.
-- =====================================================================

alter table if exists public.users
  -- Set when the account was anonymised. Not a soft delete: by the time this
  -- is stamped, the username is already a pseudonym and the email is gone.
  add column if not exists deleted_at timestamptz;

create index if not exists users_deleted_idx
  on public.users (deleted_at)
  where deleted_at is not null;

-- A deleted account must never be able to sign in again. The application
-- writes a password value that no hash can produce, but the check belongs in
-- the database too: it is the one place that survives a bug in the route.
-- (Enforced as a comment rather than a constraint because `users.password`
--  legitimately holds legacy formats; see SEC-09b.)
comment on column public.users.deleted_at is
  'GDPR Art. 17 — set when the account was anonymised. username is a pseudonym, '
  'email is empty, password cannot match any input. Orders and traceability '
  'records survive pointing at the pseudonym.';


-- =====================================================================
-- Verification
-- =====================================================================

-- select column_name from information_schema.columns
--   where table_name = 'users' and column_name = 'deleted_at';
--
-- -- Anonymised accounts must have nothing identifying left on them.
-- -- This must return 0 rows:
-- select id from public.users
--   where deleted_at is not null
--     and (coalesce(email, '') <> '' or username not like 'deleted-%');


-- #####################################################################
-- ###  07_email_status.sql
-- #####################################################################

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


-- #####################################################################
-- ###  08_admin_users.sql
-- #####################################################################

-- =====================================================================
-- SEC-12 — ADMIN HARDENING
--
-- The problem: one shared credential from the environment. No 2FA, no
-- per-admin identity, and **the current password is in git history — treat it
-- as compromised.**
--
-- Consequences of a shared credential that are easy to miss:
--   * every audit entry says `actorType: 'admin'` with the same name, so
--     "who approved this farm" has no answer;
--   * revoking one person's access means changing the password for everyone;
--   * nobody notices a leak, because there is nothing to notice.
--
-- RUN ONCE, IN FULL, IN THE SUPABASE SQL EDITOR. Idempotent.
--
-- ⚠ RUN THIS BEFORE DEPLOYING. The login route reads `admin_users`.
--   Bootstrap is handled for you: the first sign-in with the existing
--   ADMIN_USERNAME/ADMIN_PASSWORD creates that row and immediately requires
--   TOTP enrolment. Once at least one admin has enrolled, set
--   ADMIN_BOOTSTRAP_DISABLED=1 and the environment credential stops working.
-- =====================================================================


-- =====================================================================
-- PART 1/4 — `admin_users`: one row per human
-- =====================================================================

create table if not exists public.admin_users (
  id uuid primary key default gen_random_uuid(),

  -- Lowercased at write time by the application; unique so two people cannot
  -- share a name and therefore share an audit trail.
  username text not null unique,
  -- scrypt, same format as `users.password`: `salt:derivedKey`.
  password_hash text not null,

  -- TOTP. The secret is base32, as the authenticator apps expect.
  -- `totp_enrolled_at` is the switch: until it is set, the account can sign in
  -- with a password alone *once*, to enrol. After that, never again.
  totp_secret text,
  totp_enrolled_at timestamptz,

  -- Every sign-in must move this forward. A replayed code is a used code, and
  -- TOTP without replay protection is a 30-second password.
  last_totp_step bigint,

  is_active boolean not null default true,
  -- Set when the account is locked out after too many failures. Cleared by
  -- another admin, never by waiting.
  locked_at timestamptz,
  failed_attempts integer not null default 0 check (failed_attempts >= 0),

  last_login_at timestamptz,
  last_login_ip text not null default '',

  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists admin_users_active_idx
  on public.admin_users (is_active) where is_active;

alter table public.admin_users enable row level security;
-- RLS on with no policies: service role only. This table must never be
-- reachable with the publishable key, under any circumstances.
drop policy if exists admin_users_no_public_access on public.admin_users;


-- =====================================================================
-- PART 2/4 — `admin_backup_codes`
--
-- Hashed, one row per code, consumed by being marked used rather than
-- deleted: "this code was used, at this time" is worth more in an incident
-- than a clean table.
--
-- Stored as a SHA-256 hash. Not scrypt: these are 40 bits of real randomness
-- rather than a human-chosen password, so there is no dictionary to attack and
-- nothing for a slow hash to buy.
-- =====================================================================

create table if not exists public.admin_backup_codes (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid not null references public.admin_users(id) on delete cascade,
  code_hash text not null unique,
  used_at timestamptz,
  used_ip text not null default '',
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists admin_backup_codes_admin_idx
  on public.admin_backup_codes (admin_id)
  where used_at is null;

alter table public.admin_backup_codes enable row level security;
drop policy if exists admin_backup_codes_no_public_access on public.admin_backup_codes;


-- =====================================================================
-- PART 3/4 — The audit log becomes append-only
--
-- SEC-11 asked for this and it belongs here: an audit log an attacker can
-- edit after the fact is theatre. Service role bypasses RLS, but our own code
-- has no path that updates or deletes an entry, and the grants make sure the
-- roles PostgREST exposes cannot either.
-- =====================================================================

revoke update, delete on public.audit_log from anon, authenticated;
revoke update, delete on public.legal_acceptances from anon, authenticated;

-- Belt and braces: a trigger that refuses the write regardless of who asks.
-- This one *does* bind the service role, which is the point — nothing in the
-- application should ever be rewriting history.
create or replace function public.audit_log_is_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception 'audit_log is append-only: % is not permitted', tg_op;
end;
$$;

drop trigger if exists trg_audit_log_append_only on public.audit_log;
create trigger trg_audit_log_append_only
before update or delete on public.audit_log
for each row
execute function public.audit_log_is_append_only();


-- =====================================================================
-- PART 4/4 — Verification
-- =====================================================================

-- select username, totp_enrolled_at is not null as has_2fa, is_active,
--        locked_at, last_login_at
--   from public.admin_users order by username;
--
-- -- Unused backup codes per admin:
-- select a.username, count(*) filter (where c.used_at is null) as unused
--   from public.admin_users a
--   left join public.admin_backup_codes c on c.admin_id = a.id
--   group by a.username;
--
-- -- Must fail with "audit_log is append-only":
-- -- update public.audit_log set action = 'tampered' where true;
--
-- -- Once at least one admin shows has_2fa = true, set
-- -- ADMIN_BOOTSTRAP_DISABLED=1 in the backend environment and redeploy.


-- #####################################################################
-- ###  10_moderation_disputes.sql
-- #####################################################################

-- =====================================================================
-- OPS-07 (chat moderation) + OPS-03 (disputes)
--
-- RUN ONCE, IN FULL, IN THE SUPABASE SQL EDITOR. Idempotent, non-destructive.
-- Run before deploying the backend: the routes read these tables.
--
-- ⚠ PART 5 creates a PRIVATE storage bucket for dispute evidence. Photographs
--   of someone's kitchen and their delivery address are exactly as sensitive
--   as the producer documents in SEC-03, and are served the same way: through
--   short-lived signed URLs, never a public address.
-- =====================================================================


-- =====================================================================
-- PART 1/6 — `message_reports`
--
-- Reporting is the only moderation signal that scales. We cannot read every
-- conversation — and should not — so the people in them have to be able to
-- raise a hand.
-- =====================================================================

create table if not exists public.message_reports (
  id uuid primary key default gen_random_uuid(),

  message_id uuid not null,
  conversation_id uuid not null,
  reporter_user_id text not null,
  -- Denormalised: who wrote the reported message. Kept so a pattern across
  -- conversations is visible without joining through every message.
  reported_user_id text not null default '',

  reason text not null
    check (reason in ('spam', 'abuse', 'off_platform_payment', 'scam', 'other')),
  detail text not null default '',
  -- A copy of the text as reported. The message may be edited or the account
  -- deleted; the report has to survive both.
  message_snapshot text not null default '',

  state text not null default 'open'
    check (state in ('open', 'reviewing', 'actioned', 'dismissed')),
  action_taken text not null default '',
  reviewed_by text not null default '',
  reviewed_at timestamptz,

  created_at timestamptz not null default timezone('utc', now())
);

-- One report per person per message. Reporting twice is a mis-click, not a
-- stronger signal.
create unique index if not exists message_reports_unique
  on public.message_reports (message_id, reporter_user_id);

create index if not exists message_reports_open_idx
  on public.message_reports (created_at desc) where state = 'open';
create index if not exists message_reports_reported_idx
  on public.message_reports (reported_user_id, created_at desc);

alter table public.message_reports enable row level security;
drop policy if exists message_reports_no_public_access on public.message_reports;


-- =====================================================================
-- PART 2/6 — `user_blocks`
--
-- One-directional and personal: blocking stops *them* reaching *you*. It is
-- not a platform-level ban, and it does not tell the blocked person anything —
-- a block that announces itself invites retaliation through another channel.
-- =====================================================================

create table if not exists public.user_blocks (
  id uuid primary key default gen_random_uuid(),
  blocker_user_id text not null,
  blocked_user_id text not null,
  reason text not null default '',
  created_at timestamptz not null default timezone('utc', now()),
  constraint user_blocks_not_self check (blocker_user_id <> blocked_user_id)
);

create unique index if not exists user_blocks_unique
  on public.user_blocks (blocker_user_id, blocked_user_id);
create index if not exists user_blocks_blocked_idx
  on public.user_blocks (blocked_user_id);

alter table public.user_blocks enable row level security;
drop policy if exists user_blocks_no_public_access on public.user_blocks;


-- =====================================================================
-- PART 3/6 — `disputes`
--
-- The window opens when the order reaches `arrived` and closes when it is
-- confirmed — which is also when OPS-04 auto-confirms it, so the two deadlines
-- are deliberately the same length. An order with an open dispute is never
-- auto-confirmed.
--
-- `respond_by` is the farmer's 48 hours. Past it, the case escalates to us
-- automatically: a farmer who stops replying must not be able to run out the
-- clock on a customer.
-- =====================================================================

create table if not exists public.disputes (
  id uuid primary key default gen_random_uuid(),

  order_id uuid not null,
  checkout_id uuid,
  customer_id text not null,
  farmer_id text not null,

  opened_by text not null check (opened_by in ('customer', 'farmer', 'admin')),
  category text not null
    check (category in ('not_delivered', 'missing_items', 'quality', 'wrong_items', 'other')),
  description text not null default '',
  -- What the customer says they are owed, in bani. Null means "you decide".
  claimed_bani integer check (claimed_bani is null or claimed_bani >= 0),

  state text not null default 'open'
    check (state in ('open', 'awaiting_farmer', 'farmer_responded', 'escalated', 'resolved', 'withdrawn')),

  farmer_response text not null default '',
  farmer_responded_at timestamptz,
  -- 48 hours from opening. Past this with no response, the case escalates.
  respond_by timestamptz not null,
  escalated_at timestamptz,

  resolution text not null default ''
    check (resolution in ('', 'refund_full', 'refund_partial', 'no_action', 'replaced')),
  resolution_note text not null default '',
  refund_id uuid,
  resolved_by text not null default '',
  resolved_at timestamptz,

  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

-- One open dispute per order. A second complaint about the same order belongs
-- in the first case, not beside it.
create unique index if not exists disputes_one_open_per_order
  on public.disputes (order_id)
  where state in ('open', 'awaiting_farmer', 'farmer_responded', 'escalated');

create index if not exists disputes_state_idx on public.disputes (state, created_at desc);
create index if not exists disputes_order_idx on public.disputes (order_id);
create index if not exists disputes_farmer_idx on public.disputes (farmer_id, created_at desc);
-- The escalation sweep's only query.
create index if not exists disputes_respond_by_idx
  on public.disputes (respond_by)
  where state in ('open', 'awaiting_farmer');

alter table public.disputes enable row level security;
drop policy if exists disputes_no_public_access on public.disputes;

create or replace function public.set_disputes_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

drop trigger if exists trg_disputes_updated_at on public.disputes;
create trigger trg_disputes_updated_at
before update on public.disputes
for each row execute function public.set_disputes_updated_at();


-- =====================================================================
-- PART 4/6 — `dispute_evidence` and farm suspension
-- =====================================================================

create table if not exists public.dispute_evidence (
  id uuid primary key default gen_random_uuid(),
  dispute_id uuid not null references public.disputes(id) on delete cascade,
  uploaded_by text not null,
  -- A path inside the private bucket, never a URL. Storing a URL is how a
  -- private file quietly becomes a public one.
  storage_path text not null,
  content_type text not null default '',
  size_bytes integer not null default 0,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists dispute_evidence_dispute_idx
  on public.dispute_evidence (dispute_id, created_at);

alter table public.dispute_evidence enable row level security;
drop policy if exists dispute_evidence_no_public_access on public.dispute_evidence;

-- Suspending a farm. `charges_enabled` already controls visibility, but it is
-- Stripe's field and Stripe overwrites it on every `account.updated`. A
-- suspension needs to survive that, and needs a reason attached.
alter table if exists public.farmers
  add column if not exists suspended_at timestamptz,
  add column if not exists suspended_reason text not null default '',
  add column if not exists suspended_by text not null default '',
  -- P2B art. 4: a producer gets a statement of reasons and, for a suspension
  -- that is not a legal obligation, notice before it takes effect.
  add column if not exists suspension_effective_at timestamptz;

create index if not exists farmers_suspended_idx
  on public.farmers (suspended_at) where suspended_at is not null;


-- =====================================================================
-- PART 5/6 — The private evidence bucket
--
-- Same reasoning as SEC-03: a photograph of a customer's kitchen, with their
-- address in the order beside it, is not something to serve from a public URL.
-- =====================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'dispute-evidence',
  'dispute-evidence',
  false,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
)
on conflict (id) do update
set
  public = false,
  file_size_limit = 5242880,
  allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];


-- =====================================================================
-- PART 6/6 — Verification
-- =====================================================================

-- select tablename, rowsecurity from pg_tables
--   where schemaname = 'public'
--     and tablename in ('message_reports','user_blocks','disputes','dispute_evidence');
--
-- -- Must show public = false:
-- select id, public, file_size_limit from storage.buckets where id = 'dispute-evidence';
--
-- -- Cases waiting on us:
-- select id, order_id, category, state, respond_by
--   from public.disputes where state = 'escalated' order by created_at;
--
-- -- Farms currently suspended, and why:
-- select id, "farm name", suspended_at, suspended_reason from public.farmers
--   where suspended_at is not null;


-- #####################################################################
-- ###  11_fulfilment.sql
-- #####################################################################

-- =====================================================================
-- OPS-06 (availability + partial fulfilment) and LOG-04 (weight tolerance)
--
-- Two findings that turn out to be the same problem: what actually got
-- delivered, versus what was ordered.
--
--   OPS-06: "a farmer with 3 of 5 kg can only decline the whole order."
--   LOG-04: "variable weight vs prepaid card" — customer terms §10.4 has a
--           ±[10]% placeholder that matches no implementation.
--
-- RUN ONCE, IN FULL, IN THE SUPABASE SQL EDITOR. Idempotent, non-destructive.
-- Run before deploying the backend.
-- =====================================================================


-- =====================================================================
-- PART 1/5 — What was actually put in the box
--
-- `quantity` stays what the customer ordered and paid for; it is the contract
-- and it must not be rewritten. `fulfilled_quantity` is what was delivered.
-- The difference is what the refund is computed from.
-- =====================================================================

alter table if exists public.order_items
  -- NULL means "not yet recorded", which is not the same as zero. A farm that
  -- has not weighed anything yet must not read as a farm that delivered
  -- nothing.
  add column if not exists fulfilled_quantity numeric(12, 2)
    check (fulfilled_quantity is null or fulfilled_quantity >= 0),
  add column if not exists fulfilled_at timestamptz;

alter table if exists public.orders
  add column if not exists fulfilment_recorded_at timestamptz,
  -- 'full' | 'partial' — denormalised so the orders list can show it without
  -- summing the items on every read.
  add column if not exists fulfilment_state text not null default 'pending'
    check (fulfilment_state in ('pending', 'full', 'partial'));


-- =====================================================================
-- PART 2/5 — LOG-04: the tolerance, as a number the code reads
--
-- Fresh produce cannot be portioned to the gram. A "1 kg" bag of tomatoes is
-- what the farm weighed out, and it will not be exactly 1000 g.
--
-- The rule, which is now the same in the terms and in the code:
--   within tolerance  → the price stands, either way
--   short beyond it   → the difference is refunded automatically
--   over              → never charged extra
--
-- **We never charge a card a second time.** Authorising extra "just in case"
-- and capturing at the real weight is the other legal route, and it is worse:
-- the customer sees a hold larger than the price they agreed to, and a
-- payment they did not authorise is not a payment we are willing to take.
-- =====================================================================

alter table if exists public.platform_settings
  add column if not exists weight_tolerance_bps integer not null default 1000
    check (weight_tolerance_bps >= 0 and weight_tolerance_bps <= 5000);

comment on column public.platform_settings.weight_tolerance_bps is
  'LOG-04 — allowed variance on items sold by weight, in basis points. '
  '1000 = 10%, which is what customer terms §10.4 states. Short beyond this '
  'is refunded automatically; over is never charged for. Changing this changes '
  'the terms — bump the document version too.';


-- =====================================================================
-- PART 3/5 — OPS-06: when a farm is actually open
--
-- A farm is a person. They sleep, they have Sundays, and they can only pack so
-- many boxes in a day. Taking an order they cannot fill is not a sale, it is a
-- refund with extra steps.
-- =====================================================================

alter table if exists public.farmers
  -- Per weekday, 0 = Sunday: {"1": {"open": "08:00", "close": "18:00"}, ...}
  -- A missing day means closed. Empty object = always open, which is the
  -- backwards-compatible default for every farm that exists today.
  add column if not exists working_hours jsonb not null default '{}'::jsonb,
  -- ["2026-12-25", "2026-12-26"] — holidays and anything else.
  add column if not exists closed_dates jsonb not null default '[]'::jsonb,
  -- 0 = no limit, which is again what every existing farm gets.
  add column if not exists daily_order_capacity integer not null default 0
    check (daily_order_capacity >= 0),
  -- How far ahead an order may be placed. Informational for now; LOG-06
  -- pre-orders will read it.
  add column if not exists lead_time_hours integer not null default 0
    check (lead_time_hours >= 0);


-- =====================================================================
-- PART 4/5 — `orders_accepted_today`
--
-- Counting in SQL rather than in Node: the capacity check runs inside
-- `process_checkout`'s transaction, so two simultaneous checkouts cannot both
-- see the last free slot.
-- =====================================================================

create or replace function public.orders_accepted_today(p_farmer_id text)
returns integer
language sql
stable
as $$
  select count(*)::integer
  from public.orders o
  where o.farmer_id::text = p_farmer_id
    and o.order_state not in ('placed_order', 'cancelled')
    and o.created_at >= date_trunc('day', timezone('utc', now()));
$$;

create index if not exists orders_farmer_created_idx
  on public.orders (farmer_id, created_at desc);


-- =====================================================================
-- PART 5/5 — Verification
-- =====================================================================

-- select column_name from information_schema.columns
--   where table_name = 'order_items' and column_name like 'fulfilled%';
--
-- select weight_tolerance_bps from public.platform_settings;
--
-- select id, "farm name", working_hours, closed_dates, daily_order_capacity
--   from public.farmers order by "farm name";
--
-- -- Orders delivered short of what was paid for:
-- select o.id, oi.product_name, oi.quantity, oi.fulfilled_quantity
--   from public.orders o
--   join public.order_items oi on oi.order_id = o.id
--   where oi.fulfilled_quantity is not null
--     and oi.fulfilled_quantity < oi.quantity;


-- #####################################################################
-- ###  12_food_labelling.sql
-- #####################################################################

-- =====================================================================
-- LEG-04 — FOOD INFORMATION
--
-- Regulation (EU) 1169/2011 requires the same particulars for food sold at
-- distance as for food on a shelf, available **before the purchase is
-- concluded**. A name and a price is not compliant, however good the produce.
--
-- Plus two category regimes: eggs (Reg. 589/2008) and honey (HG 1050/2003,
-- Directive 2001/110/EC).
--
-- RUN ONCE, IN FULL, IN THE SUPABASE SQL EDITOR. Idempotent.
--
-- ⚠ NON-DESTRUCTIVE, BUT IT CHANGES WHAT CAN BE PUBLISHED. Existing products
--   keep selling — PART 4 grandfathers them explicitly rather than pulling the
--   catalogue overnight. New and edited products need the full set.
-- =====================================================================


-- =====================================================================
-- PART 1/5 — The particulars, on the product
--
-- One jsonb column rather than fifteen: the required set differs per category
-- and will change again when the platform sells something new, and a schema
-- migration per field is how you end up with `spare_text_3`.
-- =====================================================================

alter table if exists public.products
  add column if not exists labelling jsonb not null default '{}'::jsonb,
  -- Stamped when the full mandatory set was last validated. NULL means it has
  -- never been checked — see the grandfathering in PART 4.
  add column if not exists labelling_validated_at timestamptz,
  -- Reg. 178/2002 art. 18: a batch has to be identifiable so a recall can find
  -- it. Free text because a farm's batch is a farm's batch.
  add column if not exists batch_code text not null default '';

create index if not exists products_labelling_idx
  on public.products (labelling_validated_at)
  where labelling_validated_at is null;


-- =====================================================================
-- PART 2/5 — Organic certificates
--
-- "Bio" is a claim, not an adjective. Regulation (EU) 2018/848 requires a
-- certificate from an approved control body, and calling something organic
-- without one is a misleading commercial practice under Law 363/2007.
--
-- The expiry is the point: the claim turns itself off when the certificate
-- lapses, without anyone having to remember.
-- =====================================================================

create table if not exists public.organic_certificates (
  id uuid primary key default gen_random_uuid(),
  farmer_id text not null,

  -- Who issued it (Ecoinspect, Bios, Ceres...) and their EU control body code.
  control_body text not null default '',
  control_body_code text not null default '',
  certificate_number text not null default '',

  -- In the PRIVATE docs bucket. A path, never a URL.
  document_path text not null default '',

  valid_from date,
  valid_until date,

  state text not null default 'pending'
    check (state in ('pending', 'approved', 'rejected')),
  review_note text not null default '',
  reviewed_by text not null default '',
  reviewed_at timestamptz,

  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

-- One live certificate per farm. A renewal replaces it rather than stacking.
create unique index if not exists organic_certificates_one_active
  on public.organic_certificates (farmer_id)
  where state in ('pending', 'approved');

create index if not exists organic_certificates_expiry_idx
  on public.organic_certificates (valid_until)
  where state = 'approved';

alter table public.organic_certificates enable row level security;
drop policy if exists organic_certificates_no_public_access on public.organic_certificates;


-- =====================================================================
-- PART 3/5 — Expire the claim automatically
--
-- Run from the same hourly job as OPS-04. A certificate that lapsed on Friday
-- must not still be selling "bio" on Monday.
-- =====================================================================

create or replace function public.expire_organic_claims()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cleared integer := 0;
begin
  -- Products whose farm no longer has a live, unexpired certificate lose the
  -- claim. The product stays on sale; only the word "bio" goes.
  update public.products p
  set "bio check" = 0
  where coalesce(p."bio check", 0) <> 0
    and not exists (
      select 1
      from public.organic_certificates c
      where c.farmer_id = p.farmer_id::text
        and c.state = 'approved'
        and c.valid_until is not null
        and c.valid_until >= current_date
    );

  get diagnostics v_cleared = row_count;
  return v_cleared;
end;
$$;


-- =====================================================================
-- PART 4/5 — ⚠ Grandfathering the existing catalogue
--
-- Products listed before this migration have no labelling. Refusing to show
-- them would empty the site overnight and punish farms for a rule that did not
-- exist when they listed.
--
-- So: existing products keep selling, and are marked as needing attention. The
-- backend refuses to *publish or edit* without the full set, which means the
-- catalogue fills in as farms touch their listings, and PART 5 tells you how
-- many are left.
--
-- Set a deadline and enforce it deliberately — do not leave this indefinitely.
-- =====================================================================

update public.products
set labelling = jsonb_build_object('needsAttention', true)
where labelling = '{}'::jsonb;

comment on column public.products.labelling is
  'LEG-04 — mandatory food information (Reg. 1169/2011, plus 589/2008 for eggs '
  'and HG 1050/2003 for honey). {"needsAttention": true} marks a product listed '
  'before the rule existed: still on sale, but the next edit must complete it.';


-- =====================================================================
-- PART 5/5 — Verification
-- =====================================================================

-- -- How much of the catalogue still needs its labelling:
-- select count(*) filter (where labelling ? 'needsAttention') as needs_attention,
--        count(*) filter (where labelling_validated_at is not null) as complete,
--        count(*) as total
--   from public.products;
--
-- -- Farms claiming organic without a live certificate — must return 0 rows:
-- select p.id, p."product name", p.farmer_id
--   from public.products p
--   where coalesce(p."bio check", 0) <> 0
--     and not exists (
--       select 1 from public.organic_certificates c
--       where c.farmer_id = p.farmer_id::text
--         and c.state = 'approved' and c.valid_until >= current_date
--     );
--
-- -- Certificates expiring in the next 30 days, to warn the farm:
-- select farmer_id, certificate_number, valid_until
--   from public.organic_certificates
--   where state = 'approved' and valid_until between current_date and current_date + 30;


-- #####################################################################
-- ###  13_trader_details.sql
-- #####################################################################

-- =====================================================================
-- LEG-07 (DSA art. 30) — WHO THE CUSTOMER IS CONTRACTING WITH
--
-- The Digital Services Act art. 30 requires a marketplace to publish enough
-- about each trader that a consumer knows who they are dealing with: name,
-- registered address, registration number, contact details, and whether they
-- trade as a business or as a private individual.
--
-- Customer terms §7.2 already promises this. Not showing it is both a breach
-- and a broken promise, which is the worse of the two.
--
-- RUN ONCE, IN FULL, IN THE SUPABASE SQL EDITOR. Idempotent, non-destructive.
-- =====================================================================

alter table if exists public.farmers
  -- The registered legal name, which is often not the trading name. "Gradina
  -- Verde" on the site may be "POPESCU ION PFA" in the register.
  add column if not exists legal_name text not null default '',
  -- J.../.../... for a company, or the producer certificate number for an
  -- individual.
  add column if not exists trade_register_number text not null default '',
  add column if not exists cui text not null default '',
  -- DSA art. 30(1)(e). It changes which consumer rights apply, so it is not
  -- decoration: a private individual selling occasionally is not a trader and
  -- consumer law works differently.
  add column if not exists trader_type text not null default 'unknown'
    check (trader_type in ('unknown', 'company', 'pfa', 'individual_producer', 'private_individual'));

create index if not exists farmers_trader_incomplete_idx
  on public.farmers (id)
  where coalesce(trade_register_number, '') = '' and coalesce(cui, '') = '';

comment on column public.farmers.trader_type is
  'DSA art. 30(1)(e) — company | pfa | individual_producer | private_individual. '
  'Determines which consumer-protection regime applies to the sale.';


-- =====================================================================
-- No automatic backfill, deliberately
--
-- The CUI was uploaded as a *document* at registration — a file in the `docs`
-- bucket, not a string in a column. There is nothing to copy across, and a
-- migration that pretended otherwise would be a no-op UPDATE over every farm.
--
-- So existing farms start blank, the public page says "not supplied yet"
-- rather than inventing a value, and you fill them in from the uploaded
-- documents. The query at the bottom lists who is missing.
--
-- `trader_type` stays `unknown` rather than being guessed. An incorrect trader
-- type is worse than a visibly missing one: it makes a claim about which
-- consumer-protection regime applies to the sale.
-- =====================================================================


-- =====================================================================
-- Verification
-- =====================================================================

-- -- Farms whose public identification is incomplete (DSA art. 30):
-- select id, "farm name", legal_name, trade_register_number, cui, trader_type
--   from public.farmers
--   where coalesce(trade_register_number, '') = '' and coalesce(cui, '') = ''
--   order by "farm name";
--
-- -- Trader types across the catalogue:
-- select trader_type, count(*) from public.farmers group by trader_type;


-- #####################################################################
-- ###  14_seasonality_subscriptions.sql
-- #####################################################################

-- =====================================================================
-- LOG-06 — SEASONALITY, PRE-ORDERS AND RECURRING BASKETS
--
-- "The subscription box is the model that actually produces predictable
-- revenue." It is also the model that fixes the farm's side of the problem:
-- a farmer who knows they are packing 40 boxes on Saturday plants for 40
-- boxes, instead of guessing and composting the difference.
--
-- Three related things:
--   * **Seasonality** — a product has a window. Outside it, it is not "out of
--     stock", it is out of season, and saying so is the difference between
--     "this shop is empty" and "come back in June".
--   * **Pre-orders** — inside the season but not yet harvested. The customer
--     commits, the farm plants against a real number.
--   * **Subscriptions** — a basket that repeats. Paid per delivery, never in
--     advance for the whole run.
--
-- RUN ONCE, IN FULL, IN THE SUPABASE SQL EDITOR. Idempotent, non-destructive.
--
-- ⚠ PAYMENT MODEL, ON PURPOSE: a subscription authorises **each delivery
--   separately**, at the price in force for that delivery. We do not take
--   money for food that does not exist yet. Taking three months up front for
--   vegetables nobody has grown makes us a deposit-taker rather than a
--   marketplace, and it makes a farm's bad season the customer's loss.
-- =====================================================================


-- =====================================================================
-- PART 1/4 — Seasonality and pre-orders, on the product
-- =====================================================================

alter table if exists public.products
  -- Month numbers, 1–12, inclusive, and they may wrap: 11 → 2 is
  -- November through February, which is exactly how a winter crop works.
  -- NULL on both means available all year, the default for everything today.
  add column if not exists season_start_month smallint
    check (season_start_month is null or (season_start_month between 1 and 12)),
  add column if not exists season_end_month smallint
    check (season_end_month is null or (season_end_month between 1 and 12)),

  -- LOG-06 — may this be ordered before it exists?
  add column if not exists preorder_enabled boolean not null default false,
  -- When the farm expects to hand it over. Required when pre-orders are on:
  -- "sometime" is not a commitment a customer can plan around, and OUG
  -- 34/2014 art. 19 requires a delivery date to be stated.
  add column if not exists preorder_available_from date,
  -- Cap on how much may be pre-ordered, separate from `quantity` (which is
  -- stock on hand). A pre-order does not consume stock, so it needs its own
  -- ceiling or a farm can promise a field it has not planted.
  add column if not exists preorder_capacity numeric(12, 2) not null default 0
    check (preorder_capacity >= 0),
  add column if not exists preorder_committed numeric(12, 2) not null default 0
    check (preorder_committed >= 0);

create index if not exists products_preorder_idx
  on public.products (preorder_available_from)
  where preorder_enabled;


-- =====================================================================
-- PART 2/4 — `subscriptions`
--
-- Deliberately NOT Stripe Subscriptions. Stripe's model bills a fixed amount
-- on a schedule; a vegetable box is a different amount every week (the season
-- decides), goes to a different farm's Connect account, and is skipped when
-- someone is away. Every one of those is a fight with the abstraction, so the
-- schedule lives here and each delivery becomes an ordinary checkout — which
-- also means refunds, disputes and transfers all work exactly as they already
-- do, with no second money path to keep correct.
-- =====================================================================

create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),

  customer_id text not null,
  farmer_id text not null,

  name text not null default 'Weekly basket',
  -- What repeats: [{"productId": "...", "quantity": 2}, ...]
  items jsonb not null default '[]'::jsonb,

  frequency text not null default 'weekly'
    check (frequency in ('weekly', 'fortnightly', 'monthly')),
  -- 0 = Sunday, matching Date.getDay() and the availability code.
  delivery_weekday smallint not null default 6
    check (delivery_weekday between 0 and 6),

  state text not null default 'active'
    check (state in ('active', 'paused', 'cancelled')),
  -- A customer going away for three weeks pauses rather than cancels.
  paused_until date,

  -- When the next basket should be generated. The sweep reads only this.
  next_delivery_date date not null,
  last_generated_date date,

  -- Belt and braces on a runaway generator: if something goes wrong, it stops
  -- at a number the customer agreed to rather than billing forever.
  max_deliveries integer check (max_deliveries is null or max_deliveries > 0),
  deliveries_generated integer not null default 0 check (deliveries_generated >= 0),

  cancelled_at timestamptz,
  cancel_reason text not null default '',

  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists subscriptions_due_idx
  on public.subscriptions (next_delivery_date)
  where state = 'active';
create index if not exists subscriptions_customer_idx
  on public.subscriptions (customer_id, state);
create index if not exists subscriptions_farmer_idx
  on public.subscriptions (farmer_id, state);

alter table public.subscriptions enable row level security;
drop policy if exists subscriptions_no_public_access on public.subscriptions;

create or replace function public.set_subscriptions_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

drop trigger if exists trg_subscriptions_updated_at on public.subscriptions;
create trigger trg_subscriptions_updated_at
before update on public.subscriptions
for each row execute function public.set_subscriptions_updated_at();

-- Which subscription produced which order, so a customer can see the run and
-- a farm can see the commitment behind a basket.
alter table if exists public.orders
  add column if not exists subscription_id uuid,
  -- A pre-order is paid now and delivered later. Marked so the auto-confirm
  -- sweep (OPS-04) does not start counting days from the payment.
  add column if not exists is_preorder boolean not null default false,
  add column if not exists expected_delivery_date date;

create index if not exists orders_subscription_idx
  on public.orders (subscription_id)
  where subscription_id is not null;


-- =====================================================================
-- PART 3/4 — `advance_subscription`
--
-- Moves the schedule forward atomically. In SQL so the sweep cannot generate
-- the same week twice if two instances run at once: the `where` clause is the
-- claim, exactly like every other idempotency point in this codebase.
-- =====================================================================

create or replace function public.advance_subscription(
  p_subscription_id uuid,
  p_from_date date
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sub    public.subscriptions%rowtype;
  v_days   integer;
  v_next   date;
begin
  select * into v_sub from public.subscriptions where id = p_subscription_id for update;
  if not found then
    return jsonb_build_object('success', false, 'error', 'Subscription not found.');
  end if;

  -- Someone else already advanced past this date. Not an error — the whole
  -- point of taking the date as an argument.
  if v_sub.next_delivery_date <> p_from_date then
    return jsonb_build_object('success', true, 'already_advanced', true);
  end if;

  v_days := case v_sub.frequency
    when 'weekly' then 7
    when 'fortnightly' then 14
    else 28
  end;

  v_next := p_from_date + v_days;

  update public.subscriptions
  set
    next_delivery_date = v_next,
    last_generated_date = p_from_date,
    deliveries_generated = deliveries_generated + 1,
    -- Stops itself at the agreed number rather than running forever.
    state = case
      when max_deliveries is not null and deliveries_generated + 1 >= max_deliveries
        then 'cancelled'
      else state
    end,
    cancelled_at = case
      when max_deliveries is not null and deliveries_generated + 1 >= max_deliveries
        then timezone('utc', now())
      else cancelled_at
    end,
    cancel_reason = case
      when max_deliveries is not null and deliveries_generated + 1 >= max_deliveries
        then 'completed_all_deliveries'
      else cancel_reason
    end
  where id = p_subscription_id;

  return jsonb_build_object('success', true, 'already_advanced', false, 'next_delivery_date', v_next);
end;
$$;


-- =====================================================================
-- PART 4/4 — Verification
-- =====================================================================

-- select id, "product name", season_start_month, season_end_month,
--        preorder_enabled, preorder_available_from,
--        preorder_capacity, preorder_committed
--   from public.products where preorder_enabled or season_start_month is not null;
--
-- -- Baskets due in the next week:
-- select id, customer_id, farmer_id, frequency, next_delivery_date
--   from public.subscriptions
--   where state = 'active' and next_delivery_date <= current_date + 7
--   order by next_delivery_date;
--
-- -- Predictable revenue, which is the whole reason this exists:
-- select frequency, count(*) from public.subscriptions
--   where state = 'active' group by frequency;

