-- 0016 — The vendor's home summary.
--
-- Spec section 5 asks the vendor Accueil for "monnaie en circulation (total
-- owed), nombre de clients concernés, activité du jour". The home screen only
-- had buttons, so a shopkeeper could not see what they owed without first
-- tapping into another screen. Knowing what you owe is the first thing, not the
-- second.
--
-- Computed server-side in one round trip rather than by fetching every customer
-- and adding them up on a phone: this is the screen that opens dozens of times a
-- day on a slow connection.

create or replace function public.vendor_home_summary(
  p_vendor_id     uuid,
  p_actor_user_id uuid
)
  returns table (
    circulation_cfa     integer,
    customers_owed      integer,
    today_credit_cfa    integer,
    today_credit_count  integer,
    today_debit_cfa     integer,
    today_debit_count   integer,
    last_activity_at    timestamptz
  )
  language plpgsql
  stable
  security definer
  set search_path = public, pg_temp
as $fn$
declare
  v_caller uuid;
begin
  if p_actor_user_id is null then
    raise exception 'SIKA_ACTOR_REQUIRED' using errcode = 'SW003';
  end if;

  v_caller := public.app_current_user_id();
  if v_caller is not null and v_caller <> p_actor_user_id then
    raise exception 'SIKA_ACTOR_MISMATCH' using errcode = 'SW002';
  end if;

  perform 1 from public.vendors v
   where v.id = p_vendor_id and v.auth_user_id = p_actor_user_id;
  if not found then
    raise exception 'SIKA_VENDOR_FORBIDDEN' using errcode = 'SW001';
  end if;

  return query
  with par_client as (
    select
      e.customer_id,
      sum(case when e.direction = 'credit' then e.amount_cfa else -e.amount_cfa end)::integer as solde
    from public.ledger_entries e
    where e.vendor_id = p_vendor_id
    group by e.customer_id
  ),
  -- "Today" in the vendor's own day, not UTC. Côte d'Ivoire has no daylight
  -- saving, so a fixed offset is correct and stays correct.
  aujourdhui as (
    select
      coalesce(sum(case when direction = 'credit' then amount_cfa else 0 end), 0)::integer as credit,
      count(*) filter (where direction = 'credit')::integer                                as n_credit,
      coalesce(sum(case when direction = 'debit'  then amount_cfa else 0 end), 0)::integer  as debit,
      count(*) filter (where direction = 'debit')::integer                                 as n_debit
    from public.ledger_entries
    where vendor_id = p_vendor_id
      and (created_at at time zone 'Africa/Abidjan')::date
          = (now() at time zone 'Africa/Abidjan')::date
  )
  select
    -- Clamped at zero per customer: rule 2 makes a negative impossible, and
    -- clamping means a bug could never understate what the vendor owes.
    coalesce((select sum(greatest(solde, 0)) from par_client), 0)::integer,
    coalesce((select count(*) from par_client where solde > 0), 0)::integer,
    a.credit, a.n_credit, a.debit, a.n_debit,
    (select max(created_at) from public.ledger_entries where vendor_id = p_vendor_id)
  from aujourdhui a;
end
$fn$;

revoke all on function public.vendor_home_summary(uuid, uuid) from public, anon;
grant execute on function public.vendor_home_summary(uuid, uuid) to authenticated;
