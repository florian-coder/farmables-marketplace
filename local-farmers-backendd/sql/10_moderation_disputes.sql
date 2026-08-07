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
