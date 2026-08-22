-- 0027 — The customer's informational total, aggregated in SQL.
--
-- Same bug as the vendor's "Monnaie en circulation", found by looking for the
-- same shape on the other side of the app. Ma monnaie rendered
--
--   "4 300 F — Répartie chez 3 commerçants"
--
-- by folding over the rows customer_shop_balances returned. That list is a page:
-- 100 by default since 0025, and before that whatever PostgREST felt like
-- giving. So past the page size the figure would understate what the customer
-- holds.
--
-- It is worse here than on the vendor side in one respect. The caption's COUNT
-- comes from the same list, so a truncated list misstates both halves of the
-- sentence: the amount AND the number of shops. "Répartie chez 100 commerçants"
-- when the answer is 137 is a specific false claim about who owes them money.
--
-- In practice a customer has a handful of shops and this would never have bitten.
-- That is exactly what was said about vendor_customers.
--
-- One row, so it cannot be truncated. The list stays a list.

create or replace function public.customer_summary(p_actor_user_id uuid)
  returns table (
    total_cfa        integer,
    shop_count       integer,
    last_activity_at timestamptz
  )
  language plpgsql
  stable
  security definer
  set search_path = public, pg_temp
as $fn$
declare
  v_caller      uuid;
  v_customer_id uuid;
begin
  if p_actor_user_id is null then
    raise exception 'SIKA_ACTOR_REQUIRED' using errcode = 'SW003';
  end if;

  v_caller := public.app_current_user_id();
  if v_caller is not null and v_caller <> p_actor_user_id then
    raise exception 'SIKA_ACTOR_MISMATCH' using errcode = 'SW002';
  end if;

  select c.id into v_customer_id
  from public.customers c where c.auth_user_id = p_actor_user_id;

  if not found then
    raise exception 'SIKA_CUSTOMER_NOT_FOUND' using errcode = 'SW008';
  end if;

  return query
  select
    -- Only positive balances, and clamped, so this matches perShop() in the app
    -- exactly. A vendor the customer owes nothing at contributes nothing rather
    -- than reducing the total, which would net one shop against another and
    -- imply the pooling rule 1 forbids.
    coalesce(sum(greatest(s.solde, 0)), 0)::integer,
    count(*) filter (where s.solde > 0)::integer,
    max(s.derniere)
  from (
    select
      sum(case when e.direction = 'credit' then e.amount_cfa else -e.amount_cfa end)::integer as solde,
      max(e.created_at) as derniere
    from public.ledger_entries e
    where e.customer_id = v_customer_id
    group by e.vendor_id
  ) s;
end
$fn$;

revoke all on function public.customer_summary(uuid) from public, anon;
grant execute on function public.customer_summary(uuid) to authenticated;
