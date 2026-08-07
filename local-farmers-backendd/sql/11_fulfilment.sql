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
