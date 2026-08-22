-- 0038 — The customers a vendor dealt with most recently.
--
-- WHY THIS EXISTS. Recording 500 F of change for an existing customer took 16
-- taps, and 10 of them were typing a phone number the vendor has typed before.
-- At a counter with people waiting, that is the difference between using this and
-- reaching for the paper carnet.
--
-- Most transactions are regulars. So the entry point offers the last few by name
-- and the ten-tap path stays for everyone else — a new customer has no entry
-- here, which is exactly the case where typing the number is the only option
-- anyway.
--
-- NO NEW DISCLOSURE. Everything returned is already visible to this vendor
-- through vendor_customers: their own label, their own balance, their own debt.
-- Amendment F holds — nothing about another vendor's relationship with this
-- person appears, and there is no way to enumerate customers a vendor has never
-- dealt with.

create or replace function public.vendor_recent_customers(
  p_vendor_id     uuid,
  p_actor_user_id uuid,
  p_limit         integer default 6
)
  returns table (
    customer_id      uuid,
    phone            text,
    your_label       text,
    is_registered    boolean,
    -- Both figures, separately. A shortlist row that showed one number would
    -- have to choose which, and either choice is wrong half the time.
    change_cfa       integer,
    debt_cfa         integer,
    last_activity_at timestamptz
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
  with vus as (
    -- Both registers: a customer this vendor last saw about a debt belongs on
    -- the shortlist as much as one they held change for.
    select e.customer_id, max(e.created_at) as quand
    from public.ledger_entries e
    where e.vendor_id = p_vendor_id
    group by e.customer_id
    union all
    select d.customer_id, max(d.created_at)
    from public.debt_entries d
    where d.vendor_id = p_vendor_id
    group by d.customer_id
  ),
  derniers as (
    select customer_id, max(quand) as quand
    from vus
    group by customer_id
    -- Bounded here as well as by p_limit, so the joins below never run over a
    -- vendor's whole history.
    order by max(quand) desc
    limit greatest(1, least(coalesce(p_limit, 6), 20))
  )
  select
    c.id, c.phone, l.display_name, c.auth_user_id is not null,
    coalesce(m.monnaie, 0), coalesce(dt.dette, 0), d.quand
  from derniers d
  join public.customers c on c.id = d.customer_id
  left join public.vendor_customer_labels l
    on l.vendor_id = p_vendor_id and l.customer_id = c.id
  left join lateral (
    select sum(case when e.direction = 'credit'
                    then e.amount_cfa else -e.amount_cfa end)::integer as monnaie
    from public.ledger_entries e
    where e.vendor_id = p_vendor_id and e.customer_id = c.id
  ) m on true
  left join lateral (
    select sum(case when x.direction = 'owed'
                    then x.amount_cfa else -x.amount_cfa end)::integer as dette
    from public.debt_entries x
    where x.vendor_id = p_vendor_id and x.customer_id = c.id
  ) dt on true
  order by d.quand desc;
end
$fn$;

revoke all on function public.vendor_recent_customers(uuid, uuid, integer)
  from public, anon;
grant execute on function public.vendor_recent_customers(uuid, uuid, integer)
  to authenticated;
