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
