-- 0025 — Bound the reads that had no limit, and stop one of them being quietly
-- wrong about money.
--
-- THE AUDIT. PostgREST caps rows at db-max-rows (1000 by default) for table
-- reads AND for functions returning a table via rpc. Every Edge Function read
-- turned out safe — maybeSingle(), filtered to one pair, or count-only — and
-- client reads are single-row or bounded by RLS. Three rpc functions returned
-- tables with no limit at all:
--
--   vendor_customers        — one row per customer a vendor has ever dealt with
--   customer_shop_balances  — one row per shop holding a customer's change
--   admin_vendor_list       — one row per vendor
--
-- THE ONE THAT MATTERED. "Monnaie en circulation" on Mes clients was computed by
-- summing the rows vendor_customers returned. Past 1000 customers the cap would
-- silently drop the tail, so the figure would UNDERSTATE what the vendor owes —
-- and it would disagree with the home screen, which computes the same total
-- server-side in one row and is therefore correct. Two screens, two answers, no
-- error anywhere. That is the quiet kind of wrong: nobody notices, and the
-- vendor trusts the smaller number.
--
-- THE FIX, in two parts:
--   1. Explicit limits here, with a total count returned alongside, so a
--      truncated list is visible as truncated instead of passing for complete.
--   2. Mes clients now takes its headline figure from vendor_home_summary,
--      which aggregates in SQL and returns a single row. A list can be a page;
--      a total cannot.

-- ---------------------------------------------------------------------------
-- vendor_customers — explicit page, plus the true total
-- ---------------------------------------------------------------------------
drop function if exists public.vendor_customers(uuid, uuid);

create function public.vendor_customers(
  p_vendor_id     uuid,
  p_actor_user_id uuid,
  p_limit         integer default 200
)
  returns table (
    customer_id      uuid,
    phone            text,
    your_label       text,
    balance_cfa      integer,
    last_activity_at timestamptz,
    entry_count      integer,
    is_registered    boolean,
    -- The number of customers this vendor actually has, regardless of how many
    -- rows this call returns. Repeated on every row, which is redundant but
    -- means the caller cannot obtain the list without also having the count.
    total_count      integer
  )
  language plpgsql
  stable
  security definer
  set search_path = public, pg_temp
as $fn$
declare
  v_caller uuid;
  v_limite integer;
  v_total  integer;
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

  -- Kept well under any PostgREST cap, so the limit that applies is this one,
  -- chosen here, rather than a platform default that changes without notice.
  v_limite := greatest(1, least(coalesce(p_limit, 200), 500));

  select count(*)::integer into v_total
  from (
    select 1
    from public.ledger_entries e
    where e.vendor_id = p_vendor_id
    group by e.customer_id
  ) t;

  return query
  select
    c.id, c.phone, l.display_name,
    b.balance, b.derniere, b.nombre,
    c.auth_user_id is not null,
    v_total
  from public.customers c
  join lateral (
    select
      sum(case when e.direction = 'credit' then e.amount_cfa else -e.amount_cfa end)::integer as balance,
      max(e.created_at) as derniere,
      count(*)::integer as nombre
    from public.ledger_entries e
    where e.vendor_id = p_vendor_id and e.customer_id = c.id
  ) b on true
  left join public.vendor_customer_labels l
    on l.vendor_id = p_vendor_id and l.customer_id = c.id
  where b.nombre > 0
  order by b.balance desc nulls last, b.derniere desc
  limit v_limite;
end
$fn$;

revoke all on function public.vendor_customers(uuid, uuid, integer) from public, anon;
grant execute on function public.vendor_customers(uuid, uuid, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- customer_shop_balances — bounded too.
--
-- Realistically a handful of shops, so the cap was never going to bite. Bounded
-- anyway: "it is small in practice" is how the vendor_customers bug got written.
-- ---------------------------------------------------------------------------
drop function if exists public.customer_shop_balances(uuid);

create function public.customer_shop_balances(
  p_actor_user_id uuid,
  p_limit         integer default 100
)
  returns table (
    vendor_id        uuid,
    business_name    text,
    quartier         text,
    commune          text,
    balance_cfa      integer,
    last_activity_at timestamptz,
    entry_count      integer,
    vendor_verified  boolean
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
    e.vendor_id,
    v.business_name,
    v.quartier,
    v.commune,
    sum(case when e.direction = 'credit' then e.amount_cfa else -e.amount_cfa end)::integer,
    max(e.created_at),
    count(*)::integer,
    v.phone_verified_at is not null
  from public.ledger_entries e
  join public.vendors v on v.id = e.vendor_id
  where e.customer_id = v_customer_id
  group by e.vendor_id, v.business_name, v.quartier, v.commune, v.phone_verified_at
  order by 5 desc, 6 desc
  limit greatest(1, least(coalesce(p_limit, 100), 200));
end
$fn$;

revoke all on function public.customer_shop_balances(uuid, integer) from public, anon;
grant execute on function public.customer_shop_balances(uuid, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- admin_vendor_list — bounded, with the true total.
-- ---------------------------------------------------------------------------
drop function if exists public.admin_vendor_list(uuid);

create function public.admin_vendor_list(
  p_actor_user_id uuid,
  p_limit         integer default 200
)
  returns table (
    vendor_id           uuid,
    business_name       text,
    quartier            text,
    commune             text,
    phone               text,
    is_active           boolean,
    phone_verified_at   timestamptz,
    verification_method text,
    joined_at           timestamptz,
    circulation_cfa     integer,
    customers_owed      integer,
    entry_count         integer,
    last_activity_at    timestamptz,
    debits              integer,
    vendor_device_debits integer,
    vendor_device_pct   numeric,
    vendor_corrections  integer,
    total_count         integer
  )
  language plpgsql
  stable
  security definer
  set search_path = public, pg_temp
as $fn$
declare
  v_caller uuid;
  v_total  integer;
begin
  if p_actor_user_id is null then
    raise exception 'SIKA_ACTOR_REQUIRED' using errcode = 'SW003';
  end if;
  v_caller := public.app_current_user_id();
  if v_caller is not null and v_caller <> p_actor_user_id then
    raise exception 'SIKA_ACTOR_MISMATCH' using errcode = 'SW002';
  end if;
  if not public.is_admin(p_actor_user_id) then
    raise exception 'SIKA_ADMIN_ONLY' using errcode = 'SW001';
  end if;

  select count(*)::integer into v_total from public.vendors;

  return query
  select
    v.id, v.business_name, v.quartier, v.commune, v.phone, v.is_active,
    v.phone_verified_at, v.verification_method, v.created_at,
    coalesce(b.circulation, 0), coalesce(b.clients, 0),
    coalesce(b.nombre, 0), b.derniere,
    coalesce(m.debits, 0), coalesce(m.vd, 0), m.pct, coalesce(m.corrections, 0),
    v_total
  from public.vendors v
  left join lateral (
    select
      sum(greatest(s.solde, 0))::integer           as circulation,
      count(*) filter (where s.solde > 0)::integer as clients,
      sum(s.n)::integer                            as nombre,
      max(s.derniere)                              as derniere
    from (
      select
        sum(case when e.direction='credit' then e.amount_cfa else -e.amount_cfa end)::integer as solde,
        count(*)::integer as n,
        max(e.created_at) as derniere
      from public.ledger_entries e
      where e.vendor_id = v.id
      group by e.customer_id
    ) s
  ) b on true
  left join lateral (
    select
      count(*)::integer as debits,
      count(*) filter (where e.confirmation_method = 'vendor_device')::integer as vd,
      round(100.0 * count(*) filter (where e.confirmation_method = 'vendor_device')
            / nullif(count(*), 0), 1) as pct,
      count(*) filter (where e.confirmation_method = 'vendor_correction')::integer as corrections
    from public.ledger_entries e
    where e.vendor_id = v.id and e.direction = 'debit'
  ) m on true
  order by (v.phone_verified_at is null) desc, coalesce(b.circulation, 0) desc
  limit greatest(1, least(coalesce(p_limit, 200), 500));
end
$fn$;

revoke all on function public.admin_vendor_list(uuid, integer)
  from public, anon, authenticated;
