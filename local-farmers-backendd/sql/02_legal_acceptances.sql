-- =====================================================================
-- FAZA 1 — LEGAL: evidența acceptării termenilor și condițiilor
--
-- Rezolvă: LEG-02, LEG-03 (partea de acceptare)
--
-- SE RULEAZĂ O SINGURĂ DATĂ, INTEGRAL, ÎN SUPABASE SQL EDITOR.
-- Idempotentă. NEDISTRUCTIVĂ — nu atinge și nu șterge nicio dată existentă.
--
-- Poate fi rulată înainte SAU după deployul backendului: până când tabela
-- există, înregistrarea acceptării eșuează cu un mesaj în log, dar contul se
-- creează. Rulează-o totuși înainte, ca să nu ai conturi fără dovadă de
-- acceptare.
-- =====================================================================


-- =====================================================================
-- PARTEA 1/3 — Tabela de acceptări
--
-- Ce trebuie să supraviețuiască: CE a acceptat utilizatorul, CE VERSIUNE,
-- CÂND și DE UNDE. Fără versiune, o dovadă de acceptare nu demonstrează
-- nimic în momentul în care textul se schimbă — adică exact atunci când e
-- nevoie de ea.
--
-- APPEND-ONLY. Acceptarea e un fapt istoric; nu se editează niciodată.
-- =====================================================================

create table if not exists public.legal_acceptances (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,

  -- Cheia documentului din registrul backendului (src/lib/legalDocuments.js).
  document_key text not null,
  -- Versiunea exactă pe care utilizatorul a văzut-o și a bifat-o.
  document_version text not null,

  -- Momentul acceptării: la înregistrare, la plasarea unei comenzi, sau la
  -- reacceptarea unei versiuni noi.
  context text not null default 'signup'
    check (context in ('signup', 'order', 'reacceptance')),
  -- Completat doar când context = 'order'.
  order_id uuid,

  -- Dovada tehnică. IP-ul e dată cu caracter personal: se păstrează pentru
  -- interesul legitim de a proba consimțământul, nu în alt scop.
  ip text not null default '',
  user_agent text not null default '',

  accepted_at timestamptz not null default timezone('utc', now())
);

create index if not exists legal_acceptances_user_idx
  on public.legal_acceptances (user_id, accepted_at desc);
create index if not exists legal_acceptances_document_idx
  on public.legal_acceptances (document_key, document_version, accepted_at desc);
create index if not exists legal_acceptances_order_idx
  on public.legal_acceptances (order_id)
  where order_id is not null;


-- =====================================================================
-- PARTEA 2/3 — RLS: acces exclusiv prin service role
--
-- RLS activat, fără nicio politică → nimeni în afară de service role (care
-- ocolește RLS) nu citește și nu scrie. Frontendul nu atinge niciodată
-- direct tabela; trece prin API.
-- =====================================================================

alter table public.legal_acceptances enable row level security;

drop policy if exists legal_acceptances_no_public_access on public.legal_acceptances;

-- Append-only, întărit la nivel de drepturi: revocăm explicit UPDATE și
-- DELETE de la rolurile pe care le expune PostgREST. Service role rămâne
-- neafectat, dar nici codul nostru nu are cod care să modifice rânduri.
revoke update, delete on public.legal_acceptances from anon, authenticated;


-- =====================================================================
-- PARTEA 3/3 — Verificare
-- Rulează separat, după ce restul a trecut.
-- =====================================================================

-- select column_name, data_type from information_schema.columns
--   where table_name = 'legal_acceptances' order by ordinal_position;
--
-- select relname, relrowsecurity from pg_class where relname = 'legal_acceptances';
--
-- -- După ce creezi un cont de test, trebuie să apară un rând:
-- select user_id, document_key, document_version, context, ip, accepted_at
--   from public.legal_acceptances order by accepted_at desc limit 5;
--
-- -- Conturi create fără dovadă de acceptare (ar trebui să fie doar cele
-- -- existente înainte de migrare):
-- select u.id, u.username, u.user_type
--   from public.users u
--   left join public.legal_acceptances la on la.user_id = u.id::text
--   where la.id is null;
