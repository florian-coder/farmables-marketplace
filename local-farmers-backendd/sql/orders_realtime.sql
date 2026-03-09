create extension if not exists pgcrypto;

alter table if exists public.products
  add column if not exists instant_buy boolean not null default false;

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  farmer_id text not null,
  client_id text not null,
  order_state text not null default 'placed_order'
    check (
      order_state in (
        'placed_order',
        'pending_order',
        'received_by_farmer',
        'preparing_order',
        'in_transit',
        'arrived',
        'received',
        'cancelled'
      )
    ),
  total_price numeric(12, 2) not null default 0 check (total_price >= 0),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null,
  product_id text not null,
  product_name text not null default '',
  product_unit text not null default '',
  quantity numeric(12, 2) not null check (quantity > 0),
  unit_price numeric(12, 2) not null check (unit_price >= 0),
  line_total numeric(12, 2) not null default 0 check (line_total >= 0),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint order_items_order_fk
    foreign key (order_id)
    references public.orders(id)
    on delete cascade,
  constraint order_items_order_product_unique
    unique (order_id, product_id)
);

create table if not exists public.order_replies (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null,
  sender_user_id text not null,
  message text not null
    check (char_length(trim(message)) > 0 and char_length(message) <= 1200),
  created_at timestamptz not null default timezone('utc', now()),
  constraint order_replies_order_fk
    foreign key (order_id)
    references public.orders(id)
    on delete cascade
);

create index if not exists orders_farmer_state_updated_idx
  on public.orders (farmer_id, order_state, updated_at desc);
create index if not exists orders_client_state_updated_idx
  on public.orders (client_id, order_state, updated_at desc);
create index if not exists orders_farmer_client_created_idx
  on public.orders (farmer_id, client_id, created_at desc);
create index if not exists order_items_order_idx
  on public.order_items (order_id, created_at asc);
create index if not exists order_replies_order_created_idx
  on public.order_replies (order_id, created_at asc);
create index if not exists products_instant_buy_idx
  on public.products (instant_buy)
  where instant_buy is true;

create or replace function public.set_orders_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

create or replace function public.set_order_items_line_total()
returns trigger
language plpgsql
as $$
begin
  new.quantity = round(coalesce(new.quantity, 0)::numeric, 2);
  new.unit_price = round(coalesce(new.unit_price, 0)::numeric, 2);
  new.line_total = round(new.quantity * new.unit_price, 2);
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

create or replace function public.recalculate_order_total(target_order_id uuid)
returns void
language plpgsql
as $$
begin
  update public.orders
  set
    total_price = coalesce((
      select round(sum(line_total), 2)
      from public.order_items
      where order_id = target_order_id
    ), 0),
    updated_at = timezone('utc', now())
  where id = target_order_id;
end;
$$;

create or replace function public.sync_order_total_from_items()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    perform public.recalculate_order_total(old.order_id);
    return old;
  end if;

  perform public.recalculate_order_total(new.order_id);
  return new;
end;
$$;

drop trigger if exists trg_orders_set_updated_at on public.orders;
create trigger trg_orders_set_updated_at
before update on public.orders
for each row
execute function public.set_orders_updated_at();

drop trigger if exists trg_order_items_set_line_total on public.order_items;
create trigger trg_order_items_set_line_total
before insert or update on public.order_items
for each row
execute function public.set_order_items_line_total();

drop trigger if exists trg_order_items_sync_total on public.order_items;
create trigger trg_order_items_sync_total
after insert or update or delete on public.order_items
for each row
execute function public.sync_order_total_from_items();

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'orders'
  ) then
    alter publication supabase_realtime add table public.orders;
  end if;

  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'order_items'
  ) then
    alter publication supabase_realtime add table public.order_items;
  end if;

  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'order_replies'
  ) then
    alter publication supabase_realtime add table public.order_replies;
  end if;
end;
$$;
