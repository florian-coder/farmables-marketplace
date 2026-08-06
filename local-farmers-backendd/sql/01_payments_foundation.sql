-- =====================================================================
-- FAZA 1 — SUBLIVRAREA 1: FUNDAȚIA DE PLĂȚI
-- Stripe Connect + comision + taxă de livrare + comandă minimă + grupuri
--
-- Rezolvă: LEG-01, BIZ-01, BIZ-02, LOG-02, LOG-03
--
-- SE RULEAZĂ O SINGURĂ DATĂ, INTEGRAL, ÎN SUPABASE SQL EDITOR.
-- Este idempotentă: o a doua rulare nu strică nimic.
--
-- ⚠ ORDINEA CONTEAZĂ LA DEPLOY:
--    1. rulezi ACEST fișier în Supabase
--    2. abia apoi deployezi backendul
--    Între cele două momente, butonul de plată dă eroare (funcția veche
--    `process_checkout(p_order_id)` e ștearsă mai jos). Durata: cât ține
--    deployul. Nicio comandă existentă nu se pierde.
--
-- ⚠ MIGRARE DISTRUCTIVĂ (una singură, la PARTEA 9): golirea coloanelor
--    IBAN. Este intenționată — nu mai avem voie să stocăm conturi bancare —
--    dar dacă vrei o copie înainte, rulează PARTEA 9 abia după ce ai
--    exportat tabelele `farmers` și `farmer_requests`.
-- =====================================================================


-- =====================================================================
-- PARTEA 1/10 — Configurarea platformei
-- Rata de comision NU se hardcodează în cod. Stă aici, iar fiecare comandă
-- îngheață rata sub care a fost plasată, ca o schimbare de rată să nu
-- rescrie niciodată istoricul.
-- =====================================================================

create table if not exists public.platform_settings (
  -- Un singur rând, garantat de check-ul pe cheia primară.
  id boolean primary key default true check (id),
  -- Puncte de bază: 1000 = 10,00%.
  commission_bps integer not null default 1000
    check (commission_bps >= 0 and commission_bps <= 5000),
  -- Minimul pe care Stripe îl acceptă pentru o plată în RON: 2,00 lei.
  min_charge_bani integer not null default 200 check (min_charge_bani >= 0),
  updated_at timestamptz not null default timezone('utc', now())
);

insert into public.platform_settings (id, commission_bps, min_charge_bani)
values (true, 1000, 200)
on conflict (id) do nothing;

alter table public.platform_settings enable row level security;

-- Acces doar prin service role (care ocolește RLS). Fără politici înseamnă
-- că nimeni altcineva nu citește și nu scrie — inclusiv anon.
drop policy if exists platform_settings_no_public_access on public.platform_settings;


-- =====================================================================
-- PARTEA 2/10 — Fermierul: cont Stripe Connect și termeni de livrare
-- =====================================================================

alter table if exists public.farmers
  -- Contul Express al fermierului. Stripe face KYC-ul și ține IBAN-ul.
  add column if not exists stripe_account_id text,
  -- Poate încasa? Singurul comutator care decide dacă produsele lui apar
  -- în catalog și dacă pot intra într-un coș.
  add column if not exists charges_enabled boolean not null default false,
  -- Poate retrage banii spre banca lui? Informativ pentru fermier.
  add column if not exists payouts_enabled boolean not null default false,
  -- A terminat formularul de onboarding?
  add column if not exists details_submitted boolean not null default false,
  -- Ce mai cere Stripe de la el (listă de câmpuri), pentru mesajul din panou.
  add column if not exists requirements_due jsonb not null default '[]'::jsonb,
  add column if not exists onboarding_completed_at timestamptz,
  -- LOG-02: termenii lui de livrare, în bani (integer), stabiliți manual.
  add column if not exists delivery_fee_bani integer not null default 0
    check (delivery_fee_bani >= 0),
  add column if not exists min_order_value_bani integer not null default 0
    check (min_order_value_bani >= 0),
  -- NULL = fermierul nu oferă livrare gratuită peste niciun prag.
  add column if not exists free_delivery_threshold_bani integer
    check (free_delivery_threshold_bani is null or free_delivery_threshold_bani >= 0),
  -- Când și-a setat explicit termenii. NULL → bannerul persistent din panou.
  add column if not exists payout_settings_set_at timestamptz;

-- Un cont Stripe aparține unui singur fermier.
create unique index if not exists farmers_stripe_account_unique
  on public.farmers (stripe_account_id)
  where stripe_account_id is not null;

create index if not exists farmers_charges_enabled_idx
  on public.farmers (charges_enabled)
  where charges_enabled is true;

-- Backfill: fermierii existenți pornesc de la zero pe ambele valori și cu
-- `payout_settings_set_at` NULL, ca panoul să le ceară explicit să le
-- completeze. Nu ghicim în locul lor.
update public.farmers
set
  delivery_fee_bani = coalesce(delivery_fee_bani, 0),
  min_order_value_bani = coalesce(min_order_value_bani, 0)
where delivery_fee_bani is null or min_order_value_bani is null;


-- =====================================================================
-- PARTEA 3/10 — `checkouts`: plata-părinte a unui coș cu mai mulți fermieri
--
-- LOG-03: un singur PaymentIntent pe contul platformei pentru tot coșul,
-- cu un `transfer_group` unic, apoi câte un Transfer către fiecare fermier.
--
-- MODELUL DE DATE — citește asta înainte de orice:
--   `checkouts`  = plata (un card, o sumă, un transfer_group)
--   `orders`     = grupul de fermier (un rând per fermier per plată)
--   `order_items`= produsele din grup
-- Adică `orders` ESTE `order_farmer_groups` din specificație. Tabela avea
-- deja exact forma cerută — un rând per fermier, cu stare proprie de
-- livrare, produse proprii și conversație proprie. Am adăugat deasupra
-- părintele care lipsea, în loc să rescriu o tabelă de care depind coșul,
-- chatul, comenzile, câștigurile și fluxul Realtime din browser.
-- =====================================================================

create table if not exists public.checkouts (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  -- Leagă în Stripe plata de toate transferurile care decurg din ea.
  transfer_group text not null unique,
  currency text not null default 'ron',

  stripe_session_id text,
  stripe_payment_intent_id text,

  -- Totalurile, în bani (integer). Suma grupurilor, niciodată recalculată.
  products_subtotal_bani integer not null default 0 check (products_subtotal_bani >= 0),
  delivery_fee_total_bani integer not null default 0 check (delivery_fee_total_bani >= 0),
  commission_total_bani integer not null default 0 check (commission_total_bani >= 0),
  total_bani integer not null default 0 check (total_bani >= 0),

  state text not null default 'open'
    check (state in ('open', 'awaiting_payment', 'paid', 'expired', 'cancelled')),
  cancel_reason text not null default '',

  -- CÂRLIGE PENTRU FACTURARE / e-Factura (nu se implementează acum).
  -- Aici se va conecta numerotarea de document când vine rândul ei:
  -- `invoice_series` + `invoice_number` formează numărul fiscal, iar
  -- `billing_*` sunt datele de facturare culese la checkout.
  invoice_series text,
  invoice_number integer,
  invoice_issued_at timestamptz,
  billing_name text,
  billing_cui text,
  billing_address text,

  paid_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists checkouts_client_state_idx
  on public.checkouts (client_id, state, created_at desc);
create index if not exists checkouts_session_idx
  on public.checkouts (stripe_session_id);
create index if not exists checkouts_payment_intent_idx
  on public.checkouts (stripe_payment_intent_id);

-- Numărul de factură e unic pe serie, când va exista.
create unique index if not exists checkouts_invoice_unique
  on public.checkouts (invoice_series, invoice_number)
  where invoice_number is not null;

alter table public.checkouts enable row level security;
-- Fără politici: numai service role. Frontendul nu citește niciodată direct
-- din tabela asta, ci prin API.
drop policy if exists checkouts_no_public_access on public.checkouts;

create or replace function public.set_checkouts_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

drop trigger if exists trg_checkouts_updated_at on public.checkouts;
create trigger trg_checkouts_updated_at
before update on public.checkouts
for each row
execute function public.set_checkouts_updated_at();


-- =====================================================================
-- PARTEA 4/10 — `orders` devine grupul de fermier
-- Banii se îngheață aici la plasare: fermierul poate schimba mâine taxa,
-- iar platforma poate schimba mâine comisionul — comanda de azi rămâne cu
-- valorile de azi.
-- =====================================================================

alter table if exists public.orders
  add column if not exists checkout_id uuid,
  -- Defalcarea înghețată, în bani (integer).
  add column if not exists products_subtotal_bani integer not null default 0
    check (products_subtotal_bani >= 0),
  add column if not exists delivery_fee_bani integer not null default 0
    check (delivery_fee_bani >= 0),
  add column if not exists commission_bps integer not null default 0
    check (commission_bps >= 0),
  add column if not exists commission_bani integer not null default 0
    check (commission_bani >= 0),
  -- Ce primește fermierul: produse + livrare. Comisionul rămâne la platformă.
  add column if not exists transfer_amount_bani integer not null default 0
    check (transfer_amount_bani >= 0),
  -- Contul de destinație, înghețat la plată: dacă fermierul își schimbă
  -- contul Stripe mâine, transferul comenzii de azi tot știe unde merge.
  add column if not exists stripe_account_id text,
  add column if not exists stripe_transfer_id text,
  add column if not exists transfer_state text not null default 'none'
    check (transfer_state in ('none', 'pending', 'sent', 'failed', 'reversed', 'manual_required')),
  add column if not exists transfer_error text,
  -- OPS-01: anularea e o stare, nu o ștergere.
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancelled_by text
    check (cancelled_by is null or cancelled_by in ('customer', 'farmer', 'admin', 'system')),
  add column if not exists cancel_reason text not null default '';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'orders_checkout_fk'
  ) then
    alter table public.orders
      add constraint orders_checkout_fk
      foreign key (checkout_id) references public.checkouts(id) on delete set null;
  end if;
end;
$$;

create index if not exists orders_checkout_idx on public.orders (checkout_id);
create index if not exists orders_transfer_state_idx
  on public.orders (transfer_state)
  where transfer_state in ('pending', 'failed', 'manual_required');

-- Backfill pentru comenzile existente: `total_price` (lei, numeric) devine
-- subtotalul de produse în bani. Comisionul istoric e 0 — comenzile de
-- dinaintea migrării nu au avut comision, și nu inventăm unul retroactiv.
update public.orders
set
  products_subtotal_bani = round(coalesce(total_price, 0) * 100)::integer,
  transfer_amount_bani = round(coalesce(total_price, 0) * 100)::integer
where products_subtotal_bani = 0
  and coalesce(total_price, 0) > 0;

-- Comenzile deja plătite înainte de migrare au fost decontate manual.
update public.orders
set transfer_state = 'manual_required'
where transfer_state = 'none'
  and paid_at is not null
  and order_state in ('received_by_farmer', 'preparing_order', 'in_transit', 'arrived', 'received');


-- =====================================================================
-- PARTEA 5/10 — `order_transfers`: registrul de idempotență al transferurilor
--
-- Cheia unică pe `order_id` ESTE mecanismul de rezervare: cine reușește
-- inserția deține transferul, restul văd 23505 și se opresc. Fără asta, o
-- reluare de webhook ar plăti fermierul de două ori, din banii noștri.
-- =====================================================================

create table if not exists public.order_transfers (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique,
  checkout_id uuid not null,
  destination_account_id text not null,
  amount_bani integer not null check (amount_bani >= 0),
  stripe_transfer_id text,
  stripe_event_id text not null default '',
  state text not null default 'pending'
    check (state in ('pending', 'sent', 'failed', 'reversed', 'manual_required')),
  last_error text,
  completed_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  constraint order_transfers_order_fk
    foreign key (order_id) references public.orders(id) on delete cascade
);

create index if not exists order_transfers_checkout_idx
  on public.order_transfers (checkout_id);
create index if not exists order_transfers_state_idx
  on public.order_transfers (state, created_at desc);

alter table public.order_transfers enable row level security;
drop policy if exists order_transfers_no_public_access on public.order_transfers;


-- =====================================================================
-- PARTEA 6/10 — Comisionul, calculat identic în SQL și în Node
-- Rotunjire half-up la ban: floor((subtotal * bps + 5000) / 10000).
-- Aceeași formulă e în src/lib/money.js. Dacă o schimbi, schimb-o în
-- ambele locuri — testul din tests/money.test.js păzește partea de Node.
-- =====================================================================

create or replace function public.commission_bani(
  p_subtotal_bani integer,
  p_commission_bps integer
)
returns integer
language sql
immutable
as $$
  select floor(
    (coalesce(p_subtotal_bani, 0)::numeric * coalesce(p_commission_bps, 0) + 5000) / 10000
  )::integer;
$$;


-- =====================================================================
-- PARTEA 7/10 — `process_checkout`: rezervă stocul și îngheață banii
--
-- Atomică și idempotentă. Un al doilea apel pe același checkout nu mai
-- scade stocul încă o dată — se întoarce cu totalurile deja înghețate.
--
-- Funcția e AUTORITATEA pe cifre: recitește ea însăși taxa fermierului,
-- comanda minimă și rata de comision, ca numerele scrise să nu poată
-- devia de la cele validate.
-- =====================================================================

-- Semnătura veche, pe o singură comandă, dispare. Vezi avertismentul de
-- ordine a deployului din capul fișierului.
drop function if exists public.process_checkout(uuid);
drop function if exists public.process_checkout(p_order_id uuid);
drop function if exists public.rollback_checkout(uuid);
drop function if exists public.rollback_checkout(p_order_id uuid);

create or replace function public.process_checkout(
  p_checkout_id uuid,
  p_order_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_checkout      public.checkouts%rowtype;
  v_commission_bps integer;
  v_order         record;
  v_item          record;
  v_available     numeric;
  v_farmer        record;
  v_subtotal      integer;
  v_delivery      integer;
  v_commission    integer;
  v_total_products   integer := 0;
  v_total_delivery   integer := 0;
  v_total_commission integer := 0;
begin
  -- Blochează plata-părinte: două tab-uri care apasă simultan pe „plătește"
  -- nu au voie să rezerve stocul de două ori.
  select * into v_checkout
  from public.checkouts
  where id = p_checkout_id
  for update;

  if not found then
    return jsonb_build_object('success', false, 'error', 'Plata nu a fost găsită.');
  end if;

  -- IDEMPOTENȚĂ: un checkout care nu mai e `open` și-a consumat rezervarea.
  if v_checkout.state <> 'open' then
    return jsonb_build_object(
      'success', true,
      'already_reserved', true,
      'state', v_checkout.state,
      'products_subtotal_bani', v_checkout.products_subtotal_bani,
      'delivery_fee_total_bani', v_checkout.delivery_fee_total_bani,
      'commission_total_bani', v_checkout.commission_total_bani,
      'total_bani', v_checkout.total_bani
    );
  end if;

  select commission_bps into v_commission_bps from public.platform_settings where id = true;
  v_commission_bps := coalesce(v_commission_bps, 1000);

  -- Grupurile, în ordine stabilă de id: două checkout-uri concurente care
  -- ating aceleași produse blochează rândurile în aceeași ordine, deci nu
  -- se pot bloca reciproc.
  for v_order in
    select o.id, o.farmer_id, o.client_id, o.order_state
    from public.orders o
    where o.id = any(p_order_ids)
      and o.client_id = v_checkout.client_id
    order by o.id
    for update
  loop
    if v_order.order_state <> 'placed_order' then
      return jsonb_build_object(
        'success', false,
        'error', 'O parte din coș a fost deja plătită sau modificată. Reîncarcă pagina.'
      );
    end if;

    -- Termenii fermierului, la momentul ăsta.
    select
      f.id,
      f."farm name" as farm_name,
      f.stripe_account_id,
      f.charges_enabled,
      f.delivery_fee_bani,
      f.min_order_value_bani,
      f.free_delivery_threshold_bani
    into v_farmer
    from public.farmers f
    where f.id::text = v_order.farmer_id::text;

    if not found then
      return jsonb_build_object('success', false, 'error', 'O fermă din coș nu mai există.');
    end if;

    if v_farmer.charges_enabled is not true or coalesce(v_farmer.stripe_account_id, '') = '' then
      return jsonb_build_object(
        'success', false,
        'error', coalesce(v_farmer.farm_name, 'O fermă') || ' nu poate încă primi plăți.'
      );
    end if;

    -- Stocul, produs cu produs, cu rândul blocat.
    v_subtotal := 0;
    for v_item in
      select oi.product_id, oi.quantity, oi.line_total, oi.product_name
      from public.order_items oi
      where oi.order_id = v_order.id
      order by oi.product_id
    loop
      select p.quantity into v_available
      from public.products p
      where p.id::text = v_item.product_id::text
      for update;

      if not found then
        return jsonb_build_object(
          'success', false,
          'error', 'Produsul „' || coalesce(v_item.product_name, '?') || '" nu mai există.'
        );
      end if;

      if coalesce(v_available, 0) < v_item.quantity then
        return jsonb_build_object(
          'success', false,
          'error', 'Stoc insuficient pentru „' || coalesce(v_item.product_name, '?') ||
                   '". Disponibil: ' || coalesce(v_available, 0) || '.'
        );
      end if;

      update public.products
      set quantity = quantity - v_item.quantity
      where id::text = v_item.product_id::text;

      v_subtotal := v_subtotal + round(coalesce(v_item.line_total, 0) * 100)::integer;
    end loop;

    if v_subtotal <= 0 then
      return jsonb_build_object('success', false, 'error', 'Un sub-coș este gol.');
    end if;

    -- LOG-02: comanda minimă, verificată pe sub-coșul fermierului.
    if coalesce(v_farmer.min_order_value_bani, 0) > 0
       and v_subtotal < v_farmer.min_order_value_bani then
      return jsonb_build_object(
        'success', false,
        'error', 'Comanda de la ' || coalesce(v_farmer.farm_name, 'fermă') ||
                 ' este sub minimul de ' ||
                 to_char(v_farmer.min_order_value_bani / 100.0, 'FM999999990.00') || ' lei.'
      );
    end if;

    -- Taxa de livrare: o singură dată per fermier, scutită peste prag.
    v_delivery := coalesce(v_farmer.delivery_fee_bani, 0);
    if v_farmer.free_delivery_threshold_bani is not null
       and v_farmer.free_delivery_threshold_bani > 0
       and v_subtotal >= v_farmer.free_delivery_threshold_bani then
      v_delivery := 0;
    end if;

    -- BIZ-01: comisionul se aplică DOAR subtotalului de produse.
    v_commission := public.commission_bani(v_subtotal, v_commission_bps);

    update public.orders
    set
      order_state = 'pending_order',
      checkout_id = p_checkout_id,
      products_subtotal_bani = v_subtotal,
      delivery_fee_bani = v_delivery,
      commission_bps = v_commission_bps,
      commission_bani = v_commission,
      transfer_amount_bani = v_subtotal + v_delivery,
      stripe_account_id = v_farmer.stripe_account_id,
      transfer_state = 'none'
    where id = v_order.id;

    v_total_products   := v_total_products + v_subtotal;
    v_total_delivery   := v_total_delivery + v_delivery;
    v_total_commission := v_total_commission + v_commission;
  end loop;

  if v_total_products <= 0 then
    return jsonb_build_object('success', false, 'error', 'Coșul este gol.');
  end if;

  update public.checkouts
  set
    state = 'awaiting_payment',
    products_subtotal_bani = v_total_products,
    delivery_fee_total_bani = v_total_delivery,
    commission_total_bani = v_total_commission,
    total_bani = v_total_products + v_total_delivery + v_total_commission
  where id = p_checkout_id;

  return jsonb_build_object(
    'success', true,
    'already_reserved', false,
    'products_subtotal_bani', v_total_products,
    'delivery_fee_total_bani', v_total_delivery,
    'commission_total_bani', v_total_commission,
    'total_bani', v_total_products + v_total_delivery + v_total_commission
  );
end;
$$;


-- =====================================================================
-- PARTEA 8/10 — `rollback_checkout` și `mark_checkout_paid`
-- =====================================================================

-- Eliberează stocul rezervat de un checkout neplătit. Se apelează la
-- expirarea sesiunii, la plata eșuată și la orice eroare de după rezervare.
-- Refacerea stocului se face în ACEEAȘI tranzacție cu anularea.
create or replace function public.rollback_checkout(p_checkout_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_checkout public.checkouts%rowtype;
  v_order    record;
  v_item     record;
  v_restored integer := 0;
begin
  select * into v_checkout from public.checkouts where id = p_checkout_id for update;
  if not found then
    return jsonb_build_object('success', false, 'error', 'Plata nu a fost găsită.');
  end if;

  -- Un checkout plătit nu se derulează înapoi de aici. Banii înapoi trec
  -- prin fluxul de rambursare (sublivrarea 2), nu prin refacere de stoc.
  if v_checkout.state = 'paid' then
    return jsonb_build_object('success', false, 'error', 'Plata e deja confirmată.');
  end if;
  if v_checkout.state <> 'awaiting_payment' then
    return jsonb_build_object('success', true, 'already_released', true);
  end if;

  for v_order in
    select o.id from public.orders o
    where o.checkout_id = p_checkout_id and o.order_state = 'pending_order'
    order by o.id
    for update
  loop
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

    -- Înapoi în coș, ca să poată fi plătit din nou. Nu se șterge nimic.
    update public.orders
    set
      order_state = 'placed_order',
      checkout_id = null,
      products_subtotal_bani = 0,
      delivery_fee_bani = 0,
      commission_bani = 0,
      commission_bps = 0,
      transfer_amount_bani = 0,
      stripe_account_id = null
    where id = v_order.id;
  end loop;

  update public.checkouts
  set state = 'expired'
  where id = p_checkout_id;

  return jsonb_build_object('success', true, 'restored_items', v_restored);
end;
$$;


-- Confirmă plata. Idempotentă: raportează prin `newly_paid` dacă apelul
-- ăsta a fost cel care a schimbat starea, ca webhook-ul și redirectul de
-- succes să facă munca exact o dată între ele.
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

  -- Fiecare grup de fermier trece în „primită de fermier". Comenzile deja
  -- anulate rămân anulate.
  update public.orders
  set
    order_state = 'received_by_farmer',
    paid_at = coalesce(paid_at, v_now)
  where checkout_id = p_checkout_id
    and order_state = 'pending_order';

  return jsonb_build_object(
    'success', true, 'newly_paid', true, 'total_bani', v_checkout.total_bani
  );
end;
$$;


-- =====================================================================
-- PARTEA 9/10 — ⚠ DISTRUCTIV: golirea IBAN-urilor
--
-- LEG-01: platforma nu mai are voie să stocheze conturi bancare. Stripe le
-- colectează la onboarding, sub obligațiile lui de KYC.
--
-- Coloanele NU se șterg (ar rupe orice interogare rămasă); se golesc și se
-- marchează depreciat. Poți șterge coloanele complet peste o lună, după ce
-- confirmi că nimic nu le mai citește.
-- =====================================================================

comment on column public.farmers."IBAN" is
  'DEPRECAT 2026-08 — colectarea IBAN a fost eliminată (LEG-01). Datele bancare sunt la Stripe Connect. Coloana se golește și se va șterge.';

update public.farmers set "IBAN" = null where "IBAN" is not null;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'farmer_requests' and column_name = 'iban'
  ) then
    execute $sql$
      comment on column public.farmer_requests.iban is
        'DEPRECAT 2026-08 — vezi farmers.IBAN. Nu se mai populează.'
    $sql$;
    execute 'update public.farmer_requests set iban = '''' where coalesce(iban, '''') <> ''''';
    -- Scoatem NOT NULL/DEFAULT ca inserările fără IBAN să treacă.
    execute 'alter table public.farmer_requests alter column iban drop not null';
    execute 'alter table public.farmer_requests alter column iban set default ''''';
  end if;
end;
$$;

-- Intrările istorice din jurnal rămân: sunt deja mascate („RO49 •••• 0000")
-- și sunt dovada că schimbările de cont au fost urmărite cât timp le-am ținut.


-- =====================================================================
-- PARTEA 10/10 — Verificare
-- Rulează blocul de mai jos separat, după ce restul a trecut.
-- =====================================================================

-- select commission_bps, min_charge_bani from public.platform_settings;
--
-- select column_name, data_type from information_schema.columns
--   where table_name = 'farmers'
--     and column_name in ('stripe_account_id','charges_enabled','delivery_fee_bani',
--                         'min_order_value_bani','free_delivery_threshold_bani')
--   order by column_name;
--
-- select column_name from information_schema.columns
--   where table_name = 'orders'
--     and column_name in ('checkout_id','products_subtotal_bani','delivery_fee_bani',
--                         'commission_bani','commission_bps','transfer_amount_bani',
--                         'stripe_transfer_id','transfer_state','cancelled_at')
--   order by column_name;
--
-- select proname, pg_get_function_identity_arguments(oid) from pg_proc
--   where proname in ('process_checkout','rollback_checkout','mark_checkout_paid','commission_bani');
--
-- select relname, relrowsecurity from pg_class
--   where relname in ('checkouts','order_transfers','platform_settings');
--
-- -- Trebuie să întoarcă 0 rânduri:
-- select count(*) as ibans_ramase from public.farmers where "IBAN" is not null;
--
-- -- Verificarea formulei de comision (10%): 1000, 6, 5, 123
-- select public.commission_bani(10000, 1000), public.commission_bani(55, 1000),
--        public.commission_bani(45, 1000),    public.commission_bani(1234, 1000);
