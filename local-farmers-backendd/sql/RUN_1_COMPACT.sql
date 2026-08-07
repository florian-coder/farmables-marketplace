create table if not exists public.refunds (
  id uuid primary key default gen_random_uuid(),

  order_id uuid not null,
  checkout_id uuid,

  kind text not null check (kind in ('full', 'partial')),

  -- What the customer gets back, itemised.
  products_bani integer not null default 0 check (products_bani >= 0),
  delivery_bani integer not null default 0 check (delivery_bani >= 0),
  commission_bani integer not null default 0 check (commission_bani >= 0),
  amount_bani integer not null check (amount_bani >= 0),

  reversal_amount_bani integer not null default 0 check (reversal_amount_bani >= 0),

  reason text not null default '',
  actor_type text not null default 'system'
    check (actor_type in ('customer', 'farmer', 'admin', 'system')),
  actor_id text not null default '',

  stripe_refund_id text,
  stripe_transfer_reversal_id text,

  state text not null default 'pending'
    check (state in ('pending', 'reversing', 'refunding', 'completed', 'failed', 'refund_pending_manual')),
  last_error text,

  completed_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

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

alter table if exists public.orders
  add column if not exists refunded_bani integer not null default 0
    check (refunded_bani >= 0),
  add column if not exists refund_state text not null default 'none'
    check (refund_state in ('none', 'pending', 'partial', 'refunded', 'failed', 'refund_pending_manual'));

create index if not exists orders_refund_state_idx
  on public.orders (refund_state)
  where refund_state in ('pending', 'failed', 'refund_pending_manual');

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

alter table if exists public.orders
  add column if not exists arrived_at timestamptz,
  add column if not exists auto_confirmed_at timestamptz;

-- The maintenance job's only query.
create index if not exists orders_arrived_at_idx
  on public.orders (arrived_at)
  where order_state = 'arrived';

update public.orders
set arrived_at = coalesce(arrived_at, updated_at, created_at)
where order_state = 'arrived' and arrived_at is null;

alter table if exists public.users
  -- Set when the account was anonymised. Not a soft delete: by the time this
  -- is stamped, the username is already a pseudonym and the email is gone.
  add column if not exists deleted_at timestamptz;

create index if not exists users_deleted_idx
  on public.users (deleted_at)
  where deleted_at is not null;

comment on column public.users.deleted_at is
  'GDPR Art. 17 — set when the account was anonymised. username is a pseudonym, '
  'email is empty, password cannot match any input. Orders and traceability '
  'records survive pointing at the pseudonym.';

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

create table if not exists public.admin_users (
  id uuid primary key default gen_random_uuid(),

  -- Lowercased at write time by the application; unique so two people cannot
  -- share a name and therefore share an audit trail.
  username text not null unique,
  -- scrypt, same format as `users.password`: `salt:derivedKey`.
  password_hash text not null,

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

revoke update, delete on public.audit_log from anon, authenticated;
revoke update, delete on public.legal_acceptances from anon, authenticated;

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

alter table if exists public.farmers
  add column if not exists suspended_at timestamptz,
  add column if not exists suspended_reason text not null default '',
  add column if not exists suspended_by text not null default '',
  -- P2B art. 4: a producer gets a statement of reasons and, for a suspension
  -- that is not a legal obligation, notice before it takes effect.
  add column if not exists suspension_effective_at timestamptz;

create index if not exists farmers_suspended_idx
  on public.farmers (suspended_at) where suspended_at is not null;

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

alter table if exists public.order_items
  add column if not exists fulfilled_quantity numeric(12, 2)
    check (fulfilled_quantity is null or fulfilled_quantity >= 0),
  add column if not exists fulfilled_at timestamptz;

alter table if exists public.orders
  add column if not exists fulfilment_recorded_at timestamptz,
  -- 'full' | 'partial' — denormalised so the orders list can show it without
  -- summing the items on every read.
  add column if not exists fulfilment_state text not null default 'pending'
    check (fulfilment_state in ('pending', 'full', 'partial'));

alter table if exists public.platform_settings
  add column if not exists weight_tolerance_bps integer not null default 1000
    check (weight_tolerance_bps >= 0 and weight_tolerance_bps <= 5000);

comment on column public.platform_settings.weight_tolerance_bps is
  'LOG-04 — allowed variance on items sold by weight, in basis points. '
  '1000 = 10%, which is what customer terms §10.4 states. Short beyond this '
  'is refunded automatically; over is never charged for. Changing this changes '
  'the terms — bump the document version too.';

alter table if exists public.farmers
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

update public.products
set labelling = jsonb_build_object('needsAttention', true)
where labelling = '{}'::jsonb;

comment on column public.products.labelling is
  'LEG-04 — mandatory food information (Reg. 1169/2011, plus 589/2008 for eggs '
  'and HG 1050/2003 for honey). {"needsAttention": true} marks a product listed '
  'before the rule existed: still on sale, but the next edit must complete it.';

alter table if exists public.farmers
  -- The registered legal name, which is often not the trading name. "Gradina
  -- Verde" on the site may be "POPESCU ION PFA" in the register.
  add column if not exists legal_name text not null default '',
  -- J.../.../... for a company, or the producer certificate number for an
  -- individual.
  add column if not exists trade_register_number text not null default '',
  add column if not exists cui text not null default '',
  add column if not exists trader_type text not null default 'unknown'
    check (trader_type in ('unknown', 'company', 'pfa', 'individual_producer', 'private_individual'));

create index if not exists farmers_trader_incomplete_idx
  on public.farmers (id)
  where coalesce(trade_register_number, '') = '' and coalesce(cui, '') = '';

comment on column public.farmers.trader_type is
  'DSA art. 30(1)(e) — company | pfa | individual_producer | private_individual. '
  'Determines which consumer-protection regime applies to the sale.';

alter table if exists public.products
  add column if not exists season_start_month smallint
    check (season_start_month is null or (season_start_month between 1 and 12)),
  add column if not exists season_end_month smallint
    check (season_end_month is null or (season_end_month between 1 and 12)),

  -- LOG-06 — may this be ordered before it exists?
  add column if not exists preorder_enabled boolean not null default false,
  add column if not exists preorder_available_from date,
  add column if not exists preorder_capacity numeric(12, 2) not null default 0
    check (preorder_capacity >= 0),
  add column if not exists preorder_committed numeric(12, 2) not null default 0
    check (preorder_committed >= 0);

create index if not exists products_preorder_idx
  on public.products (preorder_available_from)
  where preorder_enabled;

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
