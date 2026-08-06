-- Migrare de securitate: SEC-03, SEC-06, SEC-08, SEC-09, SEC-11.
-- Idempotentă, se poate rula de mai multe ori fără efecte secundare.

-- ============================================================
-- 1. SEC-03 — Storage: actele fermierilor nu mai sunt publice
-- ============================================================

-- Închide accesul anonim la TOATE documentele deja încărcate, instantaneu.
-- Confidențialitatea e o proprietate a bucket-ului, nu a fișierului: nu e
-- nevoie de nicio migrare de fișiere, căile rămân aceleași.
update storage.buckets
set public = false
where id = 'docs';

-- Pozele de produs și de fermă rămân publice — sunt menite să fie văzute de
-- oricine intră pe site. Le limităm însă dimensiunea și tipurile acceptate,
-- ca bucket-ul să nu poată fi folosit ca găzduire de fișiere arbitrare.
update storage.buckets
set
  file_size_limit = 5242880,                                   -- 5 MB
  allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp']
where id in ('product photos', 'farmer photos');

-- Documentele acceptă în plus PDF (vezi SEC-10), tot cu limită de 5 MB.
update storage.buckets
set
  file_size_limit = 5242880,
  allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
where id = 'docs';

-- Plasă de siguranță: dacă cineva a lăsat vreodată o politică permisivă pe
-- obiectele din storage, o eliminăm. Backendul folosește service role, care
-- ocolește RLS, deci nu are nevoie de nicio politică.
do $$
declare
  policy_record record;
begin
  for policy_record in
    select policyname
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and (qual ilike '%docs%' or with_check ilike '%docs%')
  loop
    execute format('drop policy if exists %I on storage.objects', policy_record.policyname);
  end loop;
end;
$$;

alter table storage.objects enable row level security;

-- ============================================================
-- 2. SEC-08 — Sesiunile devin revocabile
-- ============================================================

-- Fiecare sesiune emisă poartă versiunea curentă. Incrementarea coloanei
-- invalidează instantaneu toate sesiunile utilizatorului, oriunde ar fi.
alter table if exists public.users
  add column if not exists token_version integer not null default 0;

-- ============================================================
-- 3. SEC-09 — Recuperarea parolei și verificarea emailului
-- ============================================================

alter table if exists public.users
  add column if not exists email_verified boolean not null default false;

create table if not exists public.auth_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  purpose text not null check (purpose in ('password_reset', 'email_verification')),
  -- Stocăm doar hash-ul: o scurgere a tabelului nu permite folosirea tokenului.
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists auth_tokens_user_purpose_idx
  on public.auth_tokens (user_id, purpose, created_at desc);
create index if not exists auth_tokens_expiry_idx
  on public.auth_tokens (expires_at);

alter table public.auth_tokens enable row level security;

-- ============================================================
-- 4. SEC-06 — Idempotență pe evenimentele Stripe
-- ============================================================

-- Stripe reia livrarea unui eveniment până primește 2xx. Fără tabelul ăsta,
-- o reluare ar procesa a doua oară aceeași plată.
create table if not exists public.stripe_events (
  id text primary key,
  type text not null default '',
  processed_at timestamptz not null default timezone('utc', now())
);

alter table public.stripe_events enable row level security;

-- ============================================================
-- 5. SEC-11 — Jurnal de audit
-- ============================================================

create table if not exists public.audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_type text not null default 'user',      -- user | admin | system
  actor_id text not null default '',
  action text not null,                          -- iban.changed, order.state_changed, ...
  entity_type text not null default '',
  entity_id text not null default '',
  -- Valorile sensibile se scriu mascate, niciodată în clar.
  old_value text,
  new_value text,
  ip text not null default '',
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists audit_log_created_idx on public.audit_log (created_at desc);
create index if not exists audit_log_actor_idx on public.audit_log (actor_type, actor_id, created_at desc);
create index if not exists audit_log_entity_idx on public.audit_log (entity_type, entity_id, created_at desc);

alter table public.audit_log enable row level security;

-- ============================================================
-- Verificare
-- ============================================================
-- select id, public, file_size_limit, allowed_mime_types from storage.buckets order by id;
-- select column_name from information_schema.columns
--   where table_name = 'users' and column_name in ('token_version', 'email_verified');
