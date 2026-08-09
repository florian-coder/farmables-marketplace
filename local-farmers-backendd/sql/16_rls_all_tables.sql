-- =====================================================================
-- 16 — ROW-LEVEL SECURITY ON EVERY TABLE IN `public`
--
-- `09_rls_hardening.sql` / `RUN_2_AFTER_DEPLOY.sql` did this from a
-- hand-written list of 24 tables. A list is right exactly once: migrations
-- 10, 12 and 14 each added tables afterwards and enabled RLS on their own,
-- but none of them repeated the `revoke`, and `customer_farmer_distances` —
-- which predates every migration in this folder and is referenced by no code
-- — was never in anybody's list at all. It has been readable and writable
-- with the publishable key this whole time.
--
-- So this file does not carry a list. It asks the catalogue which tables
-- exist and covers all of them, which means the next table someone creates
-- is covered by re-running this rather than by remembering to edit it.
--
-- WHAT "RLS WITH NO POLICIES" MEANS: everything is denied to everyone except
-- the service role, which bypasses RLS entirely. That is the whole design —
-- the browser holds no database key, so there is no `auth.uid()` for a policy
-- to check and nothing that needs one.
--
-- ⚠ PRECONDITION: the backend must be running on SUPABASE_SERVICE_ROLE_KEY.
--   It refuses to boot without it, so if your API is up, you are fine. A
--   process on the publishable key would answer health checks and fail every
--   single query after this file runs.
--
-- ⚠ If you have NOT yet deployed the frontend that dropped @supabase/supabase-js,
--   read the deploy-order note in RUN_2_AFTER_DEPLOY.sql first. Enabling RLS
--   cuts the browser's old Realtime subscription, and the replacement is the
--   backend SSE channel.
--
-- Safe to run repeatedly. Enabling RLS on a table that already has it is a
-- no-op, and so is revoking a grant that is already gone.
-- =====================================================================


-- ---------------------------------------------------------------------
-- PART 1/3 — Look before you leap (run this alone first; it changes nothing)
-- ---------------------------------------------------------------------
--
-- Every row this returns is a table the publishable key can currently read
-- and write:
--
--   select tablename from pg_tables
--    where schemaname = 'public' and rowsecurity = false
--    order by tablename;


-- ---------------------------------------------------------------------
-- PART 2/3 — Enable it, everywhere
--
-- Ordinary and partitioned tables only: views and materialised views cannot
-- carry RLS, and take their access from the tables underneath them anyway.
--
-- Tables owned by an extension are skipped. They are not ours to alter, and
-- on a database with PostGIS installed a blanket loop would abort on
-- `spatial_ref_sys` before reaching anything that matters.
-- ---------------------------------------------------------------------

do $$
declare
  r            record;
  v_secured    text[] := '{}';
  v_already    text[] := '{}';
  v_skipped    text[] := '{}';
  v_has_roles  boolean;
begin
  -- `anon` and `authenticated` are Supabase's PostgREST roles. On a plain
  -- Postgres they do not exist, and the revoke would abort the whole block.
  select count(*) = 2 into v_has_roles
    from pg_roles where rolname in ('anon', 'authenticated');

  for r in
    select c.relname, c.relrowsecurity
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relkind in ('r', 'p')
       and not exists (
         select 1
           from pg_depend d
          where d.classid = 'pg_class'::regclass
            and d.objid = c.oid
            and d.deptype = 'e'
       )
     order by c.relname
  loop
    begin
      if r.relrowsecurity then
        v_already := v_already || r.relname;
      else
        execute format('alter table public.%I enable row level security', r.relname);
        v_secured := v_secured || r.relname;
      end if;

      -- Belt and braces, and the half the later migrations forgot: even if a
      -- policy is added by accident one day, the roles PostgREST exposes have
      -- no grants left to exercise it with.
      if v_has_roles then
        execute format('revoke all on public.%I from anon, authenticated', r.relname);
      end if;
    exception
      when insufficient_privilege then
        -- Someone else owns it. Worth reporting rather than swallowing: an
        -- unsecured table you know about beats a script that claims success.
        v_skipped := v_skipped || r.relname;
    end;
  end loop;

  raise notice 'RLS newly enabled on % table(s): %',
    coalesce(array_length(v_secured, 1), 0), v_secured;
  raise notice 'RLS already on for % table(s): %',
    coalesce(array_length(v_already, 1), 0), v_already;

  if coalesce(array_length(v_skipped, 1), 0) > 0 then
    raise warning 'NOT SECURED (not owned by this role): %', v_skipped;
  end if;

  if not v_has_roles then
    raise notice 'Roles anon/authenticated not found — grants left untouched. Expected outside Supabase.';
  end if;
end;
$$;


-- ---------------------------------------------------------------------
-- PART 3/3 — Verification. Run separately, after the block above.
-- ---------------------------------------------------------------------
--
-- Must return 0 rows:
--
--   select tablename from pg_tables
--    where schemaname = 'public' and rowsecurity = false
--    order by tablename;
--
-- What each table now allows the browser's roles to do — every count must
-- be 0:
--
--   select table_name, count(*) as grants_to_browser_roles
--     from information_schema.role_table_grants
--    where table_schema = 'public'
--      and grantee in ('anon', 'authenticated')
--    group by table_name
--    order by table_name;
--
-- A table with RLS on and no policies denies everyone but the service role.
-- If you ever add a policy, this is where to check who it could apply to:
--
--   select schemaname, tablename, policyname, roles, cmd
--     from pg_policies where schemaname = 'public'
--    order by tablename, policyname;
--
-- SEC-03 — the documents bucket must be private:
--
--   select id, public from storage.buckets order by id;
--
-- And from the app side: sign in, open /orders, confirm updates still arrive
-- live. They come over GET /api/events/stream now — look for an open
-- `event-stream` request in the Network tab, not a websocket to supabase.co.
