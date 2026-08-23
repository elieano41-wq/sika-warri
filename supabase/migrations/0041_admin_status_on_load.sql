-- 0041 — Let a session ask whether IT is an admin.
--
-- ============================================================================
-- THE BUG. The admin flag was set once, from the login response, and held in
-- React state. So:
--
--   * a grant made while someone is logged in is invisible until they happen to
--     log out and back in;
--   * a page reload restores the session from localStorage and NEVER re-fetches
--     the flag, so it silently reverts to false;
--   * a revoked grant leaves the button on screen until the same thing happens.
--
-- The last one is not a security hole — every admin action is gated again in
-- SQL by is_admin(), so a stale flag shows a button that then fails. But the
-- first two mean the one screen you need when something is wrong is the screen
-- most likely to be missing, and the workaround is "log out", which is exactly
-- what nobody thinks of.
--
-- The app could not fix this on its own: is_admin, is_admin_self and
-- admin_is_caller were all revoked from `authenticated`, so a client session had
-- no way to ask the question at all. The only path was the login Edge Function,
-- which runs as service role.
-- ============================================================================
--
-- admin_is_caller is already the right shape for this and needs no change:
--
--   * SECURITY DEFINER, so it can read app_admins, which clients cannot;
--   * it raises SW002 if a session-bound caller asks about anyone but itself,
--     so it cannot enumerate admins;
--   * it returns a bare boolean about you, which is strictly less than the login
--     response already told you.
--
-- It was revoked only because its original caller was an Edge Function. Granting
-- it to `authenticated` discloses nothing new and removes the reason the flag
-- had to be carried in session state.

grant execute on function public.admin_is_caller(uuid) to authenticated;

comment on function public.admin_is_caller(uuid) is
  'Answers "is this caller an admin?" and nothing else. Callable by a client '
  'session so the app can check on load rather than trusting a flag captured at '
  'login, which went stale on every reload. Refuses to answer about another '
  'user (SW002), so it cannot enumerate admins.';
