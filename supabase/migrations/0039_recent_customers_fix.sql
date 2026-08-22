-- 0039 — Fix the ambiguous reference in vendor_recent_customers.
--
-- `customer_id` is both an OUT parameter of the function and a column of the
-- CTE, so inside the RETURN QUERY plpgsql cannot tell which is meant:
--
--   ERROR: 42702: column reference "customer_id" is ambiguous
--   DETAIL: It could refer to either a PL/pgSQL variable or a table column.
--
-- The migration applied cleanly, because a plpgsql body is not planned until it
-- runs — so this failed only when the app called it, as a 400 the screen
-- swallowed. The shortlist simply never appeared and nothing said why.
--
-- Fixed by naming the CTE column something no parameter shares. The other
-- read functions in this schema avoid it by accident: they reference columns
-- through a table alias everywhere, which is the habit worth keeping.

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
    -- `qui` rather than customer_id: the OUT parameter of this function is named
    -- customer_id, and plpgsql resolves a bare reference to the variable.
    select e.customer_id as qui, max(e.created_at) as quand
    from public.ledger_entries e
    where e.vendor_id = p_vendor_id
    group by e.customer_id
    union all
    select d.customer_id as qui, max(d.created_at) as quand
    from public.debt_entries d
    where d.vendor_id = p_vendor_id
    group by d.customer_id
  ),
  derniers as (
    select v.qui, max(v.quand) as quand
    from vus v
    group by v.qui
    order by max(v.quand) desc
    limit greatest(1, least(coalesce(p_limit, 6), 20))
  )
  select
    c.id, c.phone, l.display_name, c.auth_user_id is not null,
    coalesce(m.monnaie, 0), coalesce(dt.dette, 0), d.quand
  from derniers d
  join public.customers c on c.id = d.qui
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
