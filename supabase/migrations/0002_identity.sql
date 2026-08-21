-- 0002 — Portable caller identity.  (Amendment B)
--
-- RLS must not reference auth.uid() directly: acceptance test 11 forbids any
-- Supabase-specific dependency in the data layer. This wrapper is the single
-- seam between the two environments.
--
-- SECURITY — the branch is decided HERE, at migration time, on whether the
-- auth schema exists. It is NOT a runtime "did auth.uid() return null" check.
-- A runtime fallback would let anyone able to issue `SET app.current_user_id`
-- impersonate any user, since Postgres lets any role set an unreserved GUC.
-- On Supabase the current_setting branch is therefore not merely unused, it is
-- absent from the compiled function body and unreachable by construction.
-- Proven by tests/02-identity-wrapper.test.ts.

do $identity$
declare
  v_has_auth_uid boolean;
begin
  select exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'auth'
      and p.proname = 'uid'
  ) into v_has_auth_uid;

  if v_has_auth_uid then
    -- Supabase target. No current_setting path exists in this body.
    execute $decl$
      create or replace function public.app_current_user_id()
        returns uuid
        language sql
        stable
      as $impl$
        select auth.uid()
      $impl$;
    $decl$;

    execute $decl$
      create or replace function public.app_identity_backend()
        returns text
        language sql
        immutable
      as $impl$
        select 'auth'::text
      $impl$;
    $decl$;
  else
    -- Stock Postgres target, used by CI. Identity comes from a session GUC.
    execute $decl$
      create or replace function public.app_current_user_id()
        returns uuid
        language sql
        stable
      as $impl$
        select nullif(current_setting('app.current_user_id', true), '')::uuid
      $impl$;
    $decl$;

    execute $decl$
      create or replace function public.app_identity_backend()
        returns text
        language sql
        immutable
      as $impl$
        select 'setting'::text
      $impl$;
    $decl$;
  end if;
end
$identity$;

grant execute on function public.app_current_user_id() to anon, authenticated;
grant execute on function public.app_identity_backend() to anon, authenticated;
