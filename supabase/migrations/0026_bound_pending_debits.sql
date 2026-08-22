-- 0026 — The last unbounded read.
--
-- The audit in 0025 found three rpc functions returning tables with no limit.
-- This is the fourth, missed because it looked obviously small:
-- pending_debits_for_customer returns only proposals that are unconsumed,
-- uncancelled and inside their 180-second window, so in practice it is one or
-- two rows.
--
-- "Small in practice" is exactly the reasoning that produced the bug 0025
-- fixed. It is also not quite true here: nothing stops a vendor — or several —
-- from calling initiate-debit repeatedly, and each call creates a row. The
-- window expires them, it does not cap them.
--
-- The bound is internal rather than a p_limit parameter, and deliberately so.
-- This is not a list anyone pages through; it is "what is waiting for your
-- confirmation right now", and a screen offering the twenty-first is already
-- describing a situation that needs a different response than scrolling. No
-- caller has a reason to choose the number, so no caller is given the choice.
--
-- Signature unchanged, so the API layer needs no edit.

create or replace function public.pending_debits_for_customer(p_actor_user_id uuid)
  returns table (
    id                uuid,
    vendor_id         uuid,
    business_name     text,
    kind              text,
    amount_cfa        integer,
    current_balance   integer,
    resulting_balance integer,
    expires_at        timestamptz,
    seconds_left      integer
  )
  language plpgsql
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
    p.id,
    p.vendor_id,
    v.business_name,
    p.kind,
    p.amount_cfa,
    b.balance,
    b.balance - p.amount_cfa,
    p.expires_at,
    greatest(0, ceil(extract(epoch from (p.expires_at - now())))::integer)
  from public.pending_debits p
  join public.vendors v on v.id = p.vendor_id
  cross join lateral (
    select coalesce(
             sum(case when e.direction = 'credit' then e.amount_cfa else -e.amount_cfa end), 0
           )::integer as balance
    from public.ledger_entries e
    where e.vendor_id = p.vendor_id and e.customer_id = p.customer_id
  ) b
  where p.customer_id = v_customer_id
    and p.consumed_at is null
    and p.cancelled_at is null
    and p.expires_at > now()
  -- Oldest first, so the request closest to expiring is the one that cannot be
  -- pushed off the end by a newer one.
  order by p.created_at
  limit 20;
end
$fn$;

revoke all on function public.pending_debits_for_customer(uuid) from public, anon;
grant execute on function public.pending_debits_for_customer(uuid) to authenticated;
