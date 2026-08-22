-- 0024 — "Is this caller an admin?", for actions the Edge Function guards itself.
--
-- Most admin actions call a definer function that checks is_admin() as part of
-- doing its work, so the gate and the work are inseparable. purge_orphan_auth
-- has no such function: it talks to the Auth admin API, not to Postgres. So it
-- needs a way to ask the question on its own — otherwise the only thing standing
-- in front of it would be the client not calling it.
--
-- Deliberately answers ONLY about the caller. It cannot be used to enumerate
-- admins, which is why it does not simply expose is_admin().

create or replace function public.admin_is_caller(p_actor_user_id uuid)
  returns boolean
  language plpgsql
  stable
  security definer
  set search_path = public, pg_temp
as $fn$
declare
  v_caller uuid;
begin
  if p_actor_user_id is null then
    return false;
  end if;

  -- Same actor guard as everywhere else: a session-bound caller may not assert
  -- an identity other than its own.
  v_caller := public.app_current_user_id();
  if v_caller is not null and v_caller <> p_actor_user_id then
    raise exception 'SIKA_ACTOR_MISMATCH' using errcode = 'SW002';
  end if;

  return public.is_admin(p_actor_user_id);
end
$fn$;

revoke all on function public.admin_is_caller(uuid) from public, anon, authenticated;
