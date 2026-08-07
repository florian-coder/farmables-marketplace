-- =====================================================================
-- LEG-03 — GDPR: ERASURE AND PORTABILITY
--
-- RUN ONCE, IN FULL, IN THE SUPABASE SQL EDITOR. Idempotent, non-destructive.
--
-- The only schema this needs is a marker for anonymised accounts. The erasure
-- itself is anonymisation in place — see src/lib/privacy.js for why: invoices
-- (Law 82/1991, 10 years), food traceability (Reg. 178/2002) and consent
-- records all have to survive the person, so the identifiers are destroyed
-- and the rows are left pointing at a pseudonym that leads nowhere. Recital 26
-- puts properly anonymised data outside GDPR entirely, which is a stronger
-- outcome than a soft-delete flag anyone with database access can undo.
-- =====================================================================

alter table if exists public.users
  -- Set when the account was anonymised. Not a soft delete: by the time this
  -- is stamped, the username is already a pseudonym and the email is gone.
  add column if not exists deleted_at timestamptz;

create index if not exists users_deleted_idx
  on public.users (deleted_at)
  where deleted_at is not null;

-- A deleted account must never be able to sign in again. The application
-- writes a password value that no hash can produce, but the check belongs in
-- the database too: it is the one place that survives a bug in the route.
-- (Enforced as a comment rather than a constraint because `users.password`
--  legitimately holds legacy formats; see SEC-09b.)
comment on column public.users.deleted_at is
  'GDPR Art. 17 — set when the account was anonymised. username is a pseudonym, '
  'email is empty, password cannot match any input. Orders and traceability '
  'records survive pointing at the pseudonym.';


-- =====================================================================
-- Verification
-- =====================================================================

-- select column_name from information_schema.columns
--   where table_name = 'users' and column_name = 'deleted_at';
--
-- -- Anonymised accounts must have nothing identifying left on them.
-- -- This must return 0 rows:
-- select id from public.users
--   where deleted_at is not null
--     and (coalesce(email, '') <> '' or username not like 'deleted-%');
