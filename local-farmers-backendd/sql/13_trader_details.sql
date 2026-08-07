-- =====================================================================
-- LEG-07 (DSA art. 30) — WHO THE CUSTOMER IS CONTRACTING WITH
--
-- The Digital Services Act art. 30 requires a marketplace to publish enough
-- about each trader that a consumer knows who they are dealing with: name,
-- registered address, registration number, contact details, and whether they
-- trade as a business or as a private individual.
--
-- Customer terms §7.2 already promises this. Not showing it is both a breach
-- and a broken promise, which is the worse of the two.
--
-- RUN ONCE, IN FULL, IN THE SUPABASE SQL EDITOR. Idempotent, non-destructive.
-- =====================================================================

alter table if exists public.farmers
  -- The registered legal name, which is often not the trading name. "Gradina
  -- Verde" on the site may be "POPESCU ION PFA" in the register.
  add column if not exists legal_name text not null default '',
  -- J.../.../... for a company, or the producer certificate number for an
  -- individual.
  add column if not exists trade_register_number text not null default '',
  add column if not exists cui text not null default '',
  -- DSA art. 30(1)(e). It changes which consumer rights apply, so it is not
  -- decoration: a private individual selling occasionally is not a trader and
  -- consumer law works differently.
  add column if not exists trader_type text not null default 'unknown'
    check (trader_type in ('unknown', 'company', 'pfa', 'individual_producer', 'private_individual'));

create index if not exists farmers_trader_incomplete_idx
  on public.farmers (id)
  where coalesce(trade_register_number, '') = '' and coalesce(cui, '') = '';

comment on column public.farmers.trader_type is
  'DSA art. 30(1)(e) — company | pfa | individual_producer | private_individual. '
  'Determines which consumer-protection regime applies to the sale.';


-- =====================================================================
-- Backfill from what the approval already collected
--
-- The CUI was uploaded as a document at registration; where the request row
-- still carries it, copy it across rather than asking every farm again.
-- =====================================================================

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'farmer_requests' and column_name = 'documents'
  ) then
    update public.farmers f
    set cui = coalesce(nullif(f.cui, ''), '')
    where true;
  end if;
end;
$$;

-- Farms default to `unknown` rather than being guessed. An incorrect trader
-- type is worse than a visibly missing one: it makes a claim about which
-- consumer rights apply.


-- =====================================================================
-- Verification
-- =====================================================================

-- -- Farms whose public identification is incomplete (DSA art. 30):
-- select id, "farm name", legal_name, trade_register_number, cui, trader_type
--   from public.farmers
--   where coalesce(trade_register_number, '') = '' and coalesce(cui, '') = ''
--   order by "farm name";
--
-- -- Trader types across the catalogue:
-- select trader_type, count(*) from public.farmers group by trader_type;
