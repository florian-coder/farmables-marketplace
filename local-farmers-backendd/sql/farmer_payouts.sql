-- Plata lunară către fermier: IBAN pe profil + momentul încasării comenzii.

-- IBAN-ul aprobat, cel pe care intră banii la final de lună.
alter table if exists public.farmers
  add column if not exists "IBAN" varchar(34);

-- IBAN-ul trimis prin formularul de profil, până când adminul aprobă cererea.
alter table if exists public.farmer_requests
  add column if not exists iban text not null default '';

-- Momentul confirmării plății. created_at rămâne data coșului, iar updated_at
-- se mută la fiecare schimbare de stare, deci niciunul nu poate spune singur
-- în ce lună a intrat banul.
alter table if exists public.orders
  add column if not exists paid_at timestamptz;

create index if not exists orders_farmer_paid_idx
  on public.orders (farmer_id, paid_at desc);

-- Comenzile plătite înainte de migrare: cel mai bun reper e data creării.
update public.orders
set paid_at = created_at
where paid_at is null
  and order_state in (
    'received_by_farmer',
    'preparing_order',
    'in_transit',
    'arrived',
    'received'
  );
