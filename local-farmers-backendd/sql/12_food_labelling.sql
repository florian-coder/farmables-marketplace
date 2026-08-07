-- =====================================================================
-- LEG-04 — FOOD INFORMATION
--
-- Regulation (EU) 1169/2011 requires the same particulars for food sold at
-- distance as for food on a shelf, available **before the purchase is
-- concluded**. A name and a price is not compliant, however good the produce.
--
-- Plus two category regimes: eggs (Reg. 589/2008) and honey (HG 1050/2003,
-- Directive 2001/110/EC).
--
-- RUN ONCE, IN FULL, IN THE SUPABASE SQL EDITOR. Idempotent.
--
-- ⚠ NON-DESTRUCTIVE, BUT IT CHANGES WHAT CAN BE PUBLISHED. Existing products
--   keep selling — PART 4 grandfathers them explicitly rather than pulling the
--   catalogue overnight. New and edited products need the full set.
-- =====================================================================


-- =====================================================================
-- PART 1/5 — The particulars, on the product
--
-- One jsonb column rather than fifteen: the required set differs per category
-- and will change again when the platform sells something new, and a schema
-- migration per field is how you end up with `spare_text_3`.
-- =====================================================================

alter table if exists public.products
  add column if not exists labelling jsonb not null default '{}'::jsonb,
  -- Stamped when the full mandatory set was last validated. NULL means it has
  -- never been checked — see the grandfathering in PART 4.
  add column if not exists labelling_validated_at timestamptz,
  -- Reg. 178/2002 art. 18: a batch has to be identifiable so a recall can find
  -- it. Free text because a farm's batch is a farm's batch.
  add column if not exists batch_code text not null default '';

create index if not exists products_labelling_idx
  on public.products (labelling_validated_at)
  where labelling_validated_at is null;


-- =====================================================================
-- PART 2/5 — Organic certificates
--
-- "Bio" is a claim, not an adjective. Regulation (EU) 2018/848 requires a
-- certificate from an approved control body, and calling something organic
-- without one is a misleading commercial practice under Law 363/2007.
--
-- The expiry is the point: the claim turns itself off when the certificate
-- lapses, without anyone having to remember.
-- =====================================================================

create table if not exists public.organic_certificates (
  id uuid primary key default gen_random_uuid(),
  farmer_id text not null,

  -- Who issued it (Ecoinspect, Bios, Ceres...) and their EU control body code.
  control_body text not null default '',
  control_body_code text not null default '',
  certificate_number text not null default '',

  -- In the PRIVATE docs bucket. A path, never a URL.
  document_path text not null default '',

  valid_from date,
  valid_until date,

  state text not null default 'pending'
    check (state in ('pending', 'approved', 'rejected')),
  review_note text not null default '',
  reviewed_by text not null default '',
  reviewed_at timestamptz,

  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

-- One live certificate per farm. A renewal replaces it rather than stacking.
create unique index if not exists organic_certificates_one_active
  on public.organic_certificates (farmer_id)
  where state in ('pending', 'approved');

create index if not exists organic_certificates_expiry_idx
  on public.organic_certificates (valid_until)
  where state = 'approved';

alter table public.organic_certificates enable row level security;
drop policy if exists organic_certificates_no_public_access on public.organic_certificates;


-- =====================================================================
-- PART 3/5 — Expire the claim automatically
--
-- Run from the same hourly job as OPS-04. A certificate that lapsed on Friday
-- must not still be selling "bio" on Monday.
-- =====================================================================

create or replace function public.expire_organic_claims()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cleared integer := 0;
begin
  -- Products whose farm no longer has a live, unexpired certificate lose the
  -- claim. The product stays on sale; only the word "bio" goes.
  update public.products p
  set "bio check" = 0
  where coalesce(p."bio check", 0) <> 0
    and not exists (
      select 1
      from public.organic_certificates c
      where c.farmer_id = p.farmer_id::text
        and c.state = 'approved'
        and c.valid_until is not null
        and c.valid_until >= current_date
    );

  get diagnostics v_cleared = row_count;
  return v_cleared;
end;
$$;


-- =====================================================================
-- PART 4/5 — ⚠ Grandfathering the existing catalogue
--
-- Products listed before this migration have no labelling. Refusing to show
-- them would empty the site overnight and punish farms for a rule that did not
-- exist when they listed.
--
-- So: existing products keep selling, and are marked as needing attention. The
-- backend refuses to *publish or edit* without the full set, which means the
-- catalogue fills in as farms touch their listings, and PART 5 tells you how
-- many are left.
--
-- Set a deadline and enforce it deliberately — do not leave this indefinitely.
-- =====================================================================

update public.products
set labelling = jsonb_build_object('needsAttention', true)
where labelling = '{}'::jsonb;

comment on column public.products.labelling is
  'LEG-04 — mandatory food information (Reg. 1169/2011, plus 589/2008 for eggs '
  'and HG 1050/2003 for honey). {"needsAttention": true} marks a product listed '
  'before the rule existed: still on sale, but the next edit must complete it.';


-- =====================================================================
-- PART 5/5 — Verification
-- =====================================================================

-- -- How much of the catalogue still needs its labelling:
-- select count(*) filter (where labelling ? 'needsAttention') as needs_attention,
--        count(*) filter (where labelling_validated_at is not null) as complete,
--        count(*) as total
--   from public.products;
--
-- -- Farms claiming organic without a live certificate — must return 0 rows:
-- select p.id, p."product name", p.farmer_id
--   from public.products p
--   where coalesce(p."bio check", 0) <> 0
--     and not exists (
--       select 1 from public.organic_certificates c
--       where c.farmer_id = p.farmer_id::text
--         and c.state = 'approved' and c.valid_until >= current_date
--     );
--
-- -- Certificates expiring in the next 30 days, to warn the farm:
-- select farmer_id, certificate_number, valid_until
--   from public.organic_certificates
--   where state = 'approved' and valid_until between current_date and current_date + 30;
