-- 0001 — Role bootstrap.
--
-- Supabase ships `anon` and `authenticated`. A bare Postgres 15 instance does
-- not. Acceptance test 11 requires these migrations to apply to stock Postgres,
-- so create them only when absent. Idempotent on both targets.

do $bootstrap$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;

  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
end
$bootstrap$;

grant usage on schema public to anon, authenticated;
