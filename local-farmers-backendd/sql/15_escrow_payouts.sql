-- =====================================================================
-- 15 — ESCROW PAYOUTS
--
-- The farmer is paid when the customer confirms they received the order,
-- not when the card clears.
--
-- Until this migration the platform ran "separate charges and transfers"
-- with the transfer fired from the payment webhook: the money reached the
-- farmer seconds after the charge, and a customer who never received their
-- vegetables had to be made whole out of a balance the farmer had already
-- withdrawn. `refunds.js` has a whole manual-recovery path for exactly that
-- failure, and that path is a confession that the timing was wrong.
--
-- The new order of operations:
--
--   card clears        -> orders.transfer_state = 'held'   (platform holds it)
--   customer confirms  -> transfer to the farmer            ('sent')
--   nobody confirms    -> the order expires, refund to the customer
--
-- The platform is the intermediary for the length of the hold. It is not a
-- deposit taker: the money sits on the platform's own Stripe balance against
-- a specific, identified order, and every ban of it is owed either to the
-- farmer or back to the customer.
--
-- RUN THIS BEFORE DEPLOYING THE BACKEND. The new code writes 'held', which
-- the old check constraint rejects.
-- Idempotent: a second run changes nothing.
-- =====================================================================


-- ---------------------------------------------------------------------
-- PART 1/5 — `held` becomes a legal transfer state
--
-- Dropping and re-adding is the only way to widen a check constraint. The
-- `not valid` / `validate` pair keeps the table readable throughout: the
-- add takes no full-table lock, the validate takes only a share lock.
-- ---------------------------------------------------------------------

alter table public.orders
  drop constraint if exists orders_transfer_state_check;

alter table public.orders
  add constraint orders_transfer_state_check
  check (transfer_state in ('none', 'held', 'pending', 'sent', 'failed', 'reversed', 'manual_required'))
  not valid;

alter table public.orders
  validate constraint orders_transfer_state_check;

alter table public.order_transfers
  drop constraint if exists order_transfers_state_check;

alter table public.order_transfers
  add constraint order_transfers_state_check
  check (state in ('pending', 'sent', 'failed', 'reversed', 'manual_required'))
  not valid;

alter table public.order_transfers
  validate constraint order_transfers_state_check;

comment on column public.orders.transfer_state is
  'none = nothing owed yet (cart/unpaid). held = the customer has paid and the platform holds the farmer''s share until receipt is confirmed. pending/sent/failed = the release to the farmer. reversed = the share went back to the customer instead.';


-- ---------------------------------------------------------------------
-- PART 2/5 — new columns on `orders`
--
-- `refunded_transfer_bani` is the one that makes partial refunds correct
-- under escrow. Before, a partial refund clawed its share back off the
-- farmer with a transfer reversal. Now there is nothing to claw back — the
-- farmer has not been paid — so the amount has to be remembered and netted
-- out of the release, or the platform would refund the customer and then
-- pay the farmer the same money a second time.
-- ---------------------------------------------------------------------

alter table public.orders
  add column if not exists refunded_transfer_bani integer not null default 0
    check (refunded_transfer_bani >= 0),
  add column if not exists payout_released_at timestamptz,
  add column if not exists payout_hold_started_at timestamptz;

comment on column public.orders.refunded_transfer_bani is
  'Of transfer_amount_bani, how much has already gone back to the customer while the payout was still held. The release pays transfer_amount_bani - refunded_transfer_bani.';
comment on column public.orders.payout_released_at is
  'When the held share was actually sent to the farmer. Null while the platform still holds it.';
comment on column public.orders.payout_hold_started_at is
  'When the hold began — the moment the card cleared. The expiry sweep measures the undelivered-order deadline from here.';

-- Finding the orders whose money is still on the platform is the single most
-- frequent query in the new model: the release sweep, the expiry sweep and
-- the operator diagnostics all ask it.
create index if not exists orders_payout_held_idx
  on public.orders (transfer_state, order_state)
  where transfer_state in ('held', 'pending', 'failed');


-- ---------------------------------------------------------------------
-- PART 3/5 — backfill
--
-- Orders paid under the old model already have their money with the farmer
-- ('sent') and are left exactly as they are. What needs a state is the
-- middle ground: paid, not yet transferred, not yet given back.
-- ---------------------------------------------------------------------

update public.orders
set
  transfer_state = 'held',
  payout_hold_started_at = coalesce(payout_hold_started_at, paid_at)
where transfer_state = 'none'
  and paid_at is not null
  and order_state in ('received_by_farmer', 'preparing_order', 'in_transit', 'arrived')
  and refund_state in ('none', 'pending');

-- An order already delivered and confirmed under the old model has been paid
-- out; one that was never transferred is the operator's to settle by hand,
-- and `manual_required` is where the diagnostics endpoint already looks.
update public.orders
set payout_released_at = coalesce(payout_released_at, updated_at)
where transfer_state = 'sent'
  and payout_released_at is null;


-- ---------------------------------------------------------------------
-- PART 4/5 — `mark_checkout_paid` starts the hold
--
-- The state is written by the same statement that marks the group paid, so
-- there is no window in which an order is paid with its money unaccounted
-- for. The webhook re-asserts it, harmlessly, on every redelivery.
-- ---------------------------------------------------------------------

create or replace function public.mark_checkout_paid(
  p_checkout_id uuid,
  p_payment_intent_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_checkout public.checkouts%rowtype;
  v_now      timestamptz := timezone('utc', now());
begin
  select * into v_checkout from public.checkouts where id = p_checkout_id for update;
  if not found then
    return jsonb_build_object('success', false, 'error', 'Plata nu a fost găsită.');
  end if;

  if v_checkout.state = 'paid' then
    return jsonb_build_object(
      'success', true, 'newly_paid', false, 'total_bani', v_checkout.total_bani
    );
  end if;

  update public.checkouts
  set
    state = 'paid',
    paid_at = coalesce(paid_at, v_now),
    stripe_payment_intent_id = coalesce(p_payment_intent_id, stripe_payment_intent_id)
  where id = p_checkout_id;

  -- Each farmer group moves to "received by farmer" and its share goes into
  -- escrow in the same statement. Groups already cancelled stay cancelled and
  -- owe nothing.
  update public.orders
  set
    order_state = 'received_by_farmer',
    paid_at = coalesce(paid_at, v_now),
    transfer_state = case when transfer_state = 'none' then 'held' else transfer_state end,
    payout_hold_started_at = coalesce(payout_hold_started_at, v_now)
  where checkout_id = p_checkout_id
    and order_state = 'pending_order';

  return jsonb_build_object(
    'success', true, 'newly_paid', true, 'total_bani', v_checkout.total_bani
  );
end;
$$;


-- ---------------------------------------------------------------------
-- PART 5/5 — `withhold_farmer_share`
--
-- Called by the refund path when the money is still held: instead of a
-- Stripe transfer reversal, the amount is simply recorded as never to be
-- paid. `least(...)` is the guard that matters — two concurrent partial
-- refunds must not be able to push the withheld total past the farmer's
-- whole share and turn the release into a negative amount.
-- ---------------------------------------------------------------------

create or replace function public.withhold_farmer_share(
  p_order_id uuid,
  p_amount_bani integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders%rowtype;
  v_withheld integer;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    return jsonb_build_object('success', false, 'error', 'Order not found.');
  end if;

  v_withheld := least(
    v_order.transfer_amount_bani,
    v_order.refunded_transfer_bani + greatest(coalesce(p_amount_bani, 0), 0)
  );

  update public.orders
  set
    refunded_transfer_bani = v_withheld,
    -- Nothing left for the farmer: the whole share went back to the customer.
    transfer_state = case
      when v_withheld >= v_order.transfer_amount_bani and v_order.transfer_state = 'held'
        then 'reversed'
      else v_order.transfer_state
    end
  where id = p_order_id;

  return jsonb_build_object(
    'success', true,
    'refunded_transfer_bani', v_withheld,
    'releasable_bani', greatest(v_order.transfer_amount_bani - v_withheld, 0)
  );
end;
$$;


-- =====================================================================
-- VERIFICATION — run separately, after the rest has gone through
-- =====================================================================
--
-- Money the platform is currently holding, and who it is owed to:
--
--   select order_state,
--          count(*) as orders,
--          sum(transfer_amount_bani - refunded_transfer_bani) as held_bani
--     from public.orders
--    where transfer_state = 'held'
--    group by order_state
--    order by order_state;
--
-- Nothing should ever be held on a terminal order for long:
--
--   select id, order_state, transfer_state, payout_hold_started_at
--     from public.orders
--    where transfer_state in ('held', 'pending', 'failed')
--      and order_state in ('received', 'cancelled')
--    order by payout_hold_started_at;
