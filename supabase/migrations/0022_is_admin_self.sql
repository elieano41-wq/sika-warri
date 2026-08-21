-- 0022 — "Am I an admin?", for the login response.
--
-- Split out of 0021 rather than appended to it: 0021 was already applied, and
-- the migration tracker never re-runs a file it has recorded. Appending would
-- have looked like a change and done nothing at all.

-- ---------------------------------------------------------------------------
-- "Am I an admin?", for the login response.
--
-- Separate from is_admin() so the login function can ask without being able to
-- ask about anybody else. The answer only decides whether a button is drawn;
-- every admin action is gated again in SQL, so a forged flag buys nothing.
-- ---------------------------------------------------------------------------
create or replace function public.is_admin_self(p_auth_user_id uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.app_admins a where a.auth_user_id = p_auth_user_id
  )
$$;

revoke all on function public.is_admin_self(uuid) from public, anon, authenticated;
