-- 0034 — What is waiting for the customer to answer.
--
-- Mirrors pending_debits_for_customer, including its bound: 20 rows, internal,
-- with no p_limit parameter. Nobody pages through "what is waiting for your
-- confirmation right now", and a screen offering the twenty-first is describing a
-- situation that needs a different response than scrolling.
--
-- Both functions disclose the vendor's business_name, which the customer cannot
-- read from the vendors table. Deliberate and minimal: you cannot ask someone to
-- agree that they owe a shop money without naming the shop.

-- ---------------------------------------------------------------------------
-- Debt proposals
-- ---------------------------------------------------------------------------
create or replace function public.pending_debts_for_customer(p_actor_user_id uuid)
  returns table (
    id                uuid,
    vendor_id         uuid,
    business_name     text,
    quartier          text,
    amount_cfa        integer,
    note              text,
    -- What they would owe this shop if they agree. Shown so the decision is
    -- about a total, not just an increment.
    current_debt      integer,
    resulting_debt    integer,
    expires_at        timestamptz,
    seconds_left      integer
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

  select c.id into v_customer_id from public.customers c
   where c.auth_user_id = p_actor_user_id;
  if not found then
    raise exception 'SIKA_CUSTOMER_NOT_FOUND' using errcode = 'SW008';
  end if;

  return query
  select
    p.id, p.vendor_id, v.business_name, v.quartier, p.amount_cfa, p.note,
    d.dette, d.dette + p.amount_cfa,
    p.expires_at,
    greatest(0, ceil(extract(epoch from (p.expires_at - now())))::integer)
  from public.pending_debts p
  join public.vendors v on v.id = p.vendor_id
  cross join lateral (
    select coalesce(sum(case when e.direction = 'owed'
                             then e.amount_cfa else -e.amount_cfa end), 0)::integer as dette
    from public.debt_entries e
    where e.vendor_id = p.vendor_id and e.customer_id = p.customer_id
  ) d
  where p.customer_id = v_customer_id
    and p.consumed_at is null
    and p.cancelled_at is null
    and p.expires_at > now()
  -- Oldest first, so the request closest to expiring cannot be pushed off the
  -- end by a newer one.
  order by p.created_at
  limit 20;
end
$fn$;

revoke all on function public.pending_debts_for_customer(uuid) from public, anon;
grant execute on function public.pending_debts_for_customer(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Compensation proposals
--
-- Returns BOTH figures and the amount, never a combined one. A customer being
-- asked to offset needs to see what they hold, what they owe, and what would
-- move — three numbers, because that is what the decision is made of.
-- ---------------------------------------------------------------------------
create or replace function public.pending_compensations_for_customer(p_actor_user_id uuid)
  returns table (
    id                   uuid,
    vendor_id            uuid,
    business_name        text,
    amount_cfa           integer,
    current_change       integer,
    current_debt         integer,
    resulting_change     integer,
    resulting_debt       integer,
    expires_at           timestamptz,
    seconds_left         integer
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

  select c.id into v_customer_id from public.customers c
   where c.auth_user_id = p_actor_user_id;
  if not found then
    raise exception 'SIKA_CUSTOMER_NOT_FOUND' using errcode = 'SW008';
  end if;

  return query
  select
    p.id, p.vendor_id, v.business_name, p.amount_cfa,
    m.monnaie, d.dette,
    m.monnaie - p.amount_cfa, d.dette - p.amount_cfa,
    p.expires_at,
    greatest(0, ceil(extract(epoch from (p.expires_at - now())))::integer)
  from public.pending_compensations p
  join public.vendors v on v.id = p.vendor_id
  cross join lateral (
    select coalesce(sum(case when e.direction = 'credit'
                             then e.amount_cfa else -e.amount_cfa end), 0)::integer as monnaie
    from public.ledger_entries e
    where e.vendor_id = p.vendor_id and e.customer_id = p.customer_id
  ) m
  cross join lateral (
    select coalesce(sum(case when e.direction = 'owed'
                             then e.amount_cfa else -e.amount_cfa end), 0)::integer as dette
    from public.debt_entries e
    where e.vendor_id = p.vendor_id and e.customer_id = p.customer_id
  ) d
  where p.customer_id = v_customer_id
    and p.consumed_at is null
    and p.cancelled_at is null
    and p.expires_at > now()
  order by p.created_at
  limit 20;
end
$fn$;

revoke all on function public.pending_compensations_for_customer(uuid) from public, anon;
grant execute on function public.pending_compensations_for_customer(uuid) to authenticated;
