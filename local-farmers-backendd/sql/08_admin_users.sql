-- =====================================================================
-- SEC-12 — ADMIN HARDENING
--
-- The problem: one shared credential from the environment. No 2FA, no
-- per-admin identity, and **the current password is in git history — treat it
-- as compromised.**
--
-- Consequences of a shared credential that are easy to miss:
--   * every audit entry says `actorType: 'admin'` with the same name, so
--     "who approved this farm" has no answer;
--   * revoking one person's access means changing the password for everyone;
--   * nobody notices a leak, because there is nothing to notice.
--
-- RUN ONCE, IN FULL, IN THE SUPABASE SQL EDITOR. Idempotent.
--
-- ⚠ RUN THIS BEFORE DEPLOYING. The login route reads `admin_users`.
--   Bootstrap is handled for you: the first sign-in with the existing
--   ADMIN_USERNAME/ADMIN_PASSWORD creates that row and immediately requires
--   TOTP enrolment. Once at least one admin has enrolled, set
--   ADMIN_BOOTSTRAP_DISABLED=1 and the environment credential stops working.
-- =====================================================================


-- =====================================================================
-- PART 1/4 — `admin_users`: one row per human
-- =====================================================================

create table if not exists public.admin_users (
  id uuid primary key default gen_random_uuid(),

  -- Lowercased at write time by the application; unique so two people cannot
  -- share a name and therefore share an audit trail.
  username text not null unique,
  -- scrypt, same format as `users.password`: `salt:derivedKey`.
  password_hash text not null,

  -- TOTP. The secret is base32, as the authenticator apps expect.
  -- `totp_enrolled_at` is the switch: until it is set, the account can sign in
  -- with a password alone *once*, to enrol. After that, never again.
  totp_secret text,
  totp_enrolled_at timestamptz,

  -- Every sign-in must move this forward. A replayed code is a used code, and
  -- TOTP without replay protection is a 30-second password.
  last_totp_step bigint,

  is_active boolean not null default true,
  -- Set when the account is locked out after too many failures. Cleared by
  -- another admin, never by waiting.
  locked_at timestamptz,
  failed_attempts integer not null default 0 check (failed_attempts >= 0),

  last_login_at timestamptz,
  last_login_ip text not null default '',

  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists admin_users_active_idx
  on public.admin_users (is_active) where is_active;

alter table public.admin_users enable row level security;
-- RLS on with no policies: service role only. This table must never be
-- reachable with the publishable key, under any circumstances.
drop policy if exists admin_users_no_public_access on public.admin_users;


-- =====================================================================
-- PART 2/4 — `admin_backup_codes`
--
-- Hashed, one row per code, consumed by being marked used rather than
-- deleted: "this code was used, at this time" is worth more in an incident
-- than a clean table.
--
-- Stored as a SHA-256 hash. Not scrypt: these are 40 bits of real randomness
-- rather than a human-chosen password, so there is no dictionary to attack and
-- nothing for a slow hash to buy.
-- =====================================================================

create table if not exists public.admin_backup_codes (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid not null references public.admin_users(id) on delete cascade,
  code_hash text not null unique,
  used_at timestamptz,
  used_ip text not null default '',
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists admin_backup_codes_admin_idx
  on public.admin_backup_codes (admin_id)
  where used_at is null;

alter table public.admin_backup_codes enable row level security;
drop policy if exists admin_backup_codes_no_public_access on public.admin_backup_codes;


-- =====================================================================
-- PART 3/4 — The audit log becomes append-only
--
-- SEC-11 asked for this and it belongs here: an audit log an attacker can
-- edit after the fact is theatre. Service role bypasses RLS, but our own code
-- has no path that updates or deletes an entry, and the grants make sure the
-- roles PostgREST exposes cannot either.
-- =====================================================================

revoke update, delete on public.audit_log from anon, authenticated;
revoke update, delete on public.legal_acceptances from anon, authenticated;

-- Belt and braces: a trigger that refuses the write regardless of who asks.
-- This one *does* bind the service role, which is the point — nothing in the
-- application should ever be rewriting history.
create or replace function public.audit_log_is_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception 'audit_log is append-only: % is not permitted', tg_op;
end;
$$;

drop trigger if exists trg_audit_log_append_only on public.audit_log;
create trigger trg_audit_log_append_only
before update or delete on public.audit_log
for each row
execute function public.audit_log_is_append_only();


-- =====================================================================
-- PART 4/4 — Verification
-- =====================================================================

-- select username, totp_enrolled_at is not null as has_2fa, is_active,
--        locked_at, last_login_at
--   from public.admin_users order by username;
--
-- -- Unused backup codes per admin:
-- select a.username, count(*) filter (where c.used_at is null) as unused
--   from public.admin_users a
--   left join public.admin_backup_codes c on c.admin_id = a.id
--   group by a.username;
--
-- -- Must fail with "audit_log is append-only":
-- -- update public.audit_log set action = 'tampered' where true;
--
-- -- Once at least one admin shows has_2fa = true, set
-- -- ADMIN_BOOTSTRAP_DISABLED=1 in the backend environment and redeploy.
