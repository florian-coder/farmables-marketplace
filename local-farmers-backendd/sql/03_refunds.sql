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
