-- 0023 — An admin account may never be a customer account.
--
-- WHY. The support-desk model rests on separation: the operator issues reset
-- codes, and the people whose accounts get reset are on the other side of that
-- desk. An account holding both roles collapses the separation — a customer with
-- support powers can issue themselves a code, and every argument for why
-- vendor-vouched resets were removed applies to that with more force.
--
-- Enforced by trigger in BOTH directions, because either order of operations
-- produces the same forbidden state:
--
--   * granting admin to an auth user that already has a customer record;
--   * creating a customer record for an auth user that is already an admin.
--
-- A plain CHECK cannot do this — it would have to read another table — and a
-- unique constraint cannot either. A trigger is the portable way, and this is
-- exactly the kind of rule that must not live only in a code review.
--
-- Vendors are deliberately still allowed: the operator runs a shop, and their
-- vendor account is the one they hold admin on.

create or replace function public.assert_admin_not_customer()
  returns trigger
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $fn$
declare
  v_auth uuid;
begin
  -- The trigger serves two tables, so which column carries the auth user
  -- depends on which one fired it.
  if tg_table_name = 'app_admins' then
    v_auth := new.auth_user_id;
    if v_auth is not null and exists (
      select 1 from public.customers c where c.auth_user_id = v_auth
    ) then
      raise exception 'SIKA_ADMIN_CANNOT_BE_CUSTOMER'
        using errcode = 'SW018',
              detail = 'this auth user already has a customer account';
    end if;
  else
    v_auth := new.auth_user_id;
    if v_auth is not null and exists (
      select 1 from public.app_admins a where a.auth_user_id = v_auth
    ) then
      raise exception 'SIKA_ADMIN_CANNOT_BE_CUSTOMER'
        using errcode = 'SW018',
              detail = 'this auth user is an admin';
    end if;
  end if;

  return new;
end
$fn$;

drop trigger if exists app_admins_not_customer on public.app_admins;
create trigger app_admins_not_customer
  before insert or update of auth_user_id on public.app_admins
  for each row execute function public.assert_admin_not_customer();

-- The other direction. Registration links an auth user to a customer row by
-- UPDATE (a vendor-created stub being claimed) as well as by INSERT, so both
-- are covered.
drop trigger if exists customers_not_admin on public.customers;
create trigger customers_not_admin
  before insert or update of auth_user_id on public.customers
  for each row execute function public.assert_admin_not_customer();
