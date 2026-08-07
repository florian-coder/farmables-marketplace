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
