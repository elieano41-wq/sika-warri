-- 0036 — Ageing. The number vendors actually care about.
--
-- ============================================================================
-- WHY AGE MATTERS HERE AND NOT IN THE LEDGER.
--
-- A 500 F change credit from three months ago is fine — it is money the vendor
-- is holding and the customer will collect eventually. A 500 F DEBT from three
-- months ago is probably never getting paid, and a vendor looking at a single
-- "on vous doit 47 000 F" figure has no way to tell which kind of 47 000 it is.
--
-- So the debt register ages and the change ledger does not. That asymmetry is
-- the point.
-- ============================================================================
--
-- FIFO ALLOCATION, and this is the design decision worth arguing about.
--
-- The outstanding debt is a net: owed minus repaid. To age it you have to decide
-- WHICH debts a repayment paid off, and the entries do not say. Two options:
--
--   * FIFO — a payment clears the oldest debt first. What a shopkeeper means
--     when they say "he paid off last month", and what a paper carnet does when
--     you cross entries off the top.
--   * LIFO — newest first. Would make every vendor's book look older than it is
--     and nobody thinks this way.
--
-- FIFO it is, computed at read time from the entries rather than stored, so it
-- stays consistent with rule 4: the balance is always derived.
--
-- The consequence to be aware of: a customer who pays regularly but never
-- clears their balance shows NO old debt, because each payment resets the front
-- of the queue. That is correct — their oldest unpaid franc really is recent —
-- but it means ageing measures the balance, not the relationship.

-- ---------------------------------------------------------------------------
-- The unpaid portion of every debt entry, oldest first
--
-- The workhorse. Everything else in this file is a bucket count over it.
-- ---------------------------------------------------------------------------
create or replace function public.debt_unpaid_slices(
  p_vendor_id   uuid,
  p_customer_id uuid
)
  returns table (
    entry_id    uuid,
    created_at  timestamptz,
    unpaid_cfa  integer,
    age_days    integer
  )
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $fn$
  with regle as (
    select coalesce(sum(amount_cfa), 0)::bigint as total
    from public.debt_entries
    where vendor_id = p_vendor_id and customer_id = p_customer_id
      and direction = 'repaid'
  ),
  dues as (
    select
      d.id,
      d.created_at,
      d.amount_cfa,
      -- Everything owed BEFORE this entry. A repayment fills these first.
      coalesce(sum(d.amount_cfa) over (
        order by d.created_at, d.id
        rows between unbounded preceding and 1 preceding
      ), 0)::bigint as avant
    from public.debt_entries d
    where d.vendor_id = p_vendor_id and d.customer_id = p_customer_id
      and d.direction = 'owed'
  )
  select
    dues.id,
    dues.created_at,
    -- How much of THIS entry the repayments reached, clamped to its own size,
    -- then subtracted. greatest/least rather than a CASE ladder because the
    -- three cases — fully paid, partly paid, untouched — are one expression.
    (dues.amount_cfa - least(
       greatest(regle.total - dues.avant, 0),
       dues.amount_cfa
     ))::integer,
    (extract(epoch from (now() - dues.created_at)) / 86400)::integer
  from dues cross join regle
  where dues.amount_cfa - least(greatest(regle.total - dues.avant, 0), dues.amount_cfa) > 0
  order by dues.created_at;
$fn$;

-- NOT granted to any client role. It returns one row per unpaid debt entry,
-- which is unbounded by construction, and no screen needs the slices — only the
-- buckets computed from them. The callers above are SECURITY DEFINER and run as
-- the owner, so they reach it without it being exposed over rpc.
revoke all on function public.debt_unpaid_slices(uuid, uuid)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Buckets for one pair: 0-7, 8-30, 31-90, 90+
-- ---------------------------------------------------------------------------
create or replace function public.debt_ageing(
  p_vendor_id   uuid,
  p_customer_id uuid
)
  returns table (
    bucket_0_7   integer,
    bucket_8_30  integer,
    bucket_31_90 integer,
    bucket_90    integer,
    oldest_days  integer,
    over_30_cfa  integer
  )
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $fn$
  select
    coalesce(sum(s.unpaid_cfa) filter (where s.age_days <= 7), 0)::integer,
    coalesce(sum(s.unpaid_cfa) filter (where s.age_days between 8 and 30), 0)::integer,
    coalesce(sum(s.unpaid_cfa) filter (where s.age_days between 31 and 90), 0)::integer,
    coalesce(sum(s.unpaid_cfa) filter (where s.age_days > 90), 0)::integer,
    coalesce(max(s.age_days), 0)::integer,
    -- The single figure the home screen shows beside the total. Over 30 days is
    -- where a shopkeeper starts chasing.
    coalesce(sum(s.unpaid_cfa) filter (where s.age_days > 30), 0)::integer
  from public.debt_unpaid_slices(p_vendor_id, p_customer_id) s;
$fn$;

revoke all on function public.debt_ageing(uuid, uuid) from public, anon;
grant execute on function public.debt_ageing(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- The debtor list, now with age
--
-- Sortable by amount OR by age, because those are two different jobs: "who owes
-- me most" when deciding who to chase, "what has gone stale" when deciding what
-- to write off.
-- ---------------------------------------------------------------------------
drop function if exists public.vendor_debtors(uuid, uuid, integer);
drop function if exists public.vendor_debtors(uuid, uuid, integer, text);

create function public.vendor_debtors(
  p_vendor_id     uuid,
  p_actor_user_id uuid,
  p_limit         integer default 200,
  p_sort          text default 'amount'
)
  returns table (
    customer_id       uuid,
    phone             text,
    your_label        text,
    is_registered     boolean,
    debt_cfa          integer,
    confirmed_cfa     integer,
    declared_cfa      integer,
    disputed_cfa      integer,
    bucket_0_7        integer,
    bucket_8_30       integer,
    bucket_31_90      integer,
    bucket_90         integer,
    oldest_days       integer,
    over_30_cfa       integer,
    last_settled_at   timestamptz,
    open_claim        boolean,
    last_activity_at  timestamptz,
    entry_count       integer,
    total_count       integer
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
  v_tri    text;
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

  v_limite := greatest(1, least(coalesce(p_limit, 200), 500));
  -- Whitelisted, not interpolated. A sort key taken from a client and pasted
  -- into SQL is an injection with extra steps.
  v_tri := case when p_sort = 'age' then 'age' else 'amount' end;

  select count(*)::integer into v_total from (
    select 1 from public.debt_entries d
     where d.vendor_id = p_vendor_id
     group by d.customer_id
     having sum(case when d.direction = 'owed' then d.amount_cfa else -d.amount_cfa end) > 0
  ) t;

  return query
  select
    c.id, c.phone, l.display_name, c.auth_user_id is not null,
    b.dette, b.confirmee, b.declaree, b.contestee,
    a.bucket_0_7, a.bucket_8_30, a.bucket_31_90, a.bucket_90,
    a.oldest_days, a.over_30_cfa,
    b.dernier_reglement,
    coalesce(pc.ouverte, false),
    b.derniere, b.nombre, v_total
  from public.customers c
  join lateral (
    select
      sum(case when d.direction = 'owed' then d.amount_cfa else -d.amount_cfa end)::integer as dette,
      coalesce(sum(case when d.direction = 'owed'
        and public.debt_entry_state(d.customer_confirmed_at, r.decision) = 'confirmed'
        then d.amount_cfa else 0 end), 0)::integer as confirmee,
      coalesce(sum(case when d.direction = 'owed'
        and public.debt_entry_state(d.customer_confirmed_at, r.decision) = 'declared'
        then d.amount_cfa else 0 end), 0)::integer as declaree,
      coalesce(sum(case when d.direction = 'owed'
        and public.debt_entry_state(d.customer_confirmed_at, r.decision) = 'disputed'
        then d.amount_cfa else 0 end), 0)::integer as contestee,
      max(case when d.direction = 'repaid' then d.created_at end) as dernier_reglement,
      max(d.created_at) as derniere,
      count(*)::integer as nombre
    from public.debt_entries d
    left join public.debt_reviews r on r.debt_entry_id = d.id
    where d.vendor_id = p_vendor_id and d.customer_id = c.id
  ) b on true
  join lateral public.debt_ageing(p_vendor_id, c.id) a on true
  left join lateral (
    select true as ouverte from public.payment_claims x
     where x.vendor_id = p_vendor_id and x.customer_id = c.id and x.resolved_at is null
     limit 1
  ) pc on true
  left join public.vendor_customer_labels l
    on l.vendor_id = p_vendor_id and l.customer_id = c.id
  where b.dette > 0
  order by
    case when v_tri = 'age'    then a.oldest_days end desc nulls last,
    case when v_tri = 'amount' then b.dette end desc nulls last,
    b.dette desc
  limit v_limite;
end
$fn$;

revoke all on function public.vendor_debtors(uuid, uuid, integer, text) from public, anon;
grant execute on function public.vendor_debtors(uuid, uuid, integer, text) to authenticated;

-- ---------------------------------------------------------------------------
-- The home-screen figures, with the over-30 share
-- ---------------------------------------------------------------------------
drop function if exists public.vendor_debt_summary(uuid, uuid);

create function public.vendor_debt_summary(
  p_vendor_id     uuid,
  p_actor_user_id uuid
)
  returns table (
    debt_cfa        integer,
    debtors         integer,
    confirmed_cfa   integer,
    declared_cfa    integer,
    disputed_cfa    integer,
    disputed_count  integer,
    -- The share a vendor should be worried about, beside the total rather than
    -- inside it.
    over_30_cfa     integer,
    oldest_days     integer,
    -- Is this vendor's book turning over, or just growing? Two counts rather
    -- than a ratio, because a ratio hides the scale.
    settled_count   integer,
    ageing_count    integer,
    open_claims     integer
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
  select
    coalesce(sum(greatest(s.dette, 0)), 0)::integer,
    count(*) filter (where s.dette > 0)::integer,
    coalesce(sum(s.confirmee), 0)::integer,
    coalesce(sum(s.declaree), 0)::integer,
    coalesce(sum(s.contestee), 0)::integer,
    coalesce(sum(s.nb_contestees), 0)::integer,
    coalesce(sum(s.over_30), 0)::integer,
    coalesce(max(s.oldest), 0)::integer,
    -- Customers whose debt has been reduced at least once versus those with an
    -- outstanding balance older than 30 days and no repayment at all. A vendor
    -- whose debts never close is either not recording payments or not
    -- collecting, and these two numbers say which.
    count(*) filter (where s.a_regle)::integer,
    count(*) filter (where s.dette > 0 and s.over_30 > 0 and not s.a_regle)::integer,
    (select count(*)::integer from public.payment_claims pc
      where pc.vendor_id = p_vendor_id and pc.resolved_at is null)
  from (
    select
      d.customer_id,
      sum(case when d.direction = 'owed' then d.amount_cfa else -d.amount_cfa end)::integer as dette,
      coalesce(sum(case when d.direction = 'owed'
        and public.debt_entry_state(d.customer_confirmed_at, r.decision) = 'confirmed'
        then d.amount_cfa else 0 end), 0)::integer as confirmee,
      coalesce(sum(case when d.direction = 'owed'
        and public.debt_entry_state(d.customer_confirmed_at, r.decision) = 'declared'
        then d.amount_cfa else 0 end), 0)::integer as declaree,
      coalesce(sum(case when d.direction = 'owed'
        and public.debt_entry_state(d.customer_confirmed_at, r.decision) = 'disputed'
        then d.amount_cfa else 0 end), 0)::integer as contestee,
      count(*) filter (where r.decision = 'disputed')::integer as nb_contestees,
      bool_or(d.direction = 'repaid') as a_regle,
      (select x.over_30_cfa from public.debt_ageing(p_vendor_id, d.customer_id) x) as over_30,
      (select x.oldest_days from public.debt_ageing(p_vendor_id, d.customer_id) x) as oldest
    from public.debt_entries d
    left join public.debt_reviews r on r.debt_entry_id = d.id
    where d.vendor_id = p_vendor_id
    group by d.customer_id
  ) s;
end
$fn$;

revoke all on function public.vendor_debt_summary(uuid, uuid) from public, anon;
grant execute on function public.vendor_debt_summary(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- The customer sees the age of what they owe
--
-- The nudge that actually gets debts paid, and the one figure in this feature a
-- customer benefits from seeing without being asked.
-- ---------------------------------------------------------------------------
drop function if exists public.customer_shop_positions(uuid, integer);

create function public.customer_shop_positions(
  p_actor_user_id uuid,
  p_limit         integer default 100
)
  returns table (
    vendor_id          uuid,
    business_name      text,
    quartier           text,
    change_cfa         integer,
    debt_cfa           integer,
    debt_confirmed_cfa integer,
    debt_declared_cfa  integer,
    debt_disputed_cfa  integer,
    compensable_cfa    integer,
    debt_oldest_days   integer,
    debt_over_30_cfa   integer,
    open_claim         boolean,
    last_activity_at   timestamptz,
    total_count        integer
  )
  language plpgsql
  stable
  security definer
  set search_path = public, pg_temp
as $fn$
declare
  v_caller      uuid;
  v_customer_id uuid;
  v_total       integer;
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

  select count(*)::integer into v_total from (
    select e.vendor_id from public.ledger_entries e where e.customer_id = v_customer_id
    union
    select d.vendor_id from public.debt_entries d where d.customer_id = v_customer_id
  ) t;

  return query
  with boutiques as (
    select e.vendor_id from public.ledger_entries e where e.customer_id = v_customer_id
    union
    select d.vendor_id from public.debt_entries d where d.customer_id = v_customer_id
  )
  select
    v.id, v.business_name, v.quartier,
    coalesce(m.monnaie, 0), coalesce(dt.dette, 0),
    coalesce(dt.confirmee, 0), coalesce(dt.declaree, 0), coalesce(dt.contestee, 0),
    -- min(), never a difference. Two registers stay two registers.
    greatest(0, least(coalesce(m.monnaie, 0), coalesce(dt.dette, 0))),
    coalesce(ag.oldest_days, 0), coalesce(ag.over_30_cfa, 0),
    coalesce(pc.ouverte, false),
    greatest(m.derniere, dt.derniere),
    v_total
  from boutiques b
  join public.vendors v on v.id = b.vendor_id
  left join lateral (
    select
      sum(case when e.direction = 'credit' then e.amount_cfa else -e.amount_cfa end)::integer as monnaie,
      max(e.created_at) as derniere
    from public.ledger_entries e
    where e.vendor_id = b.vendor_id and e.customer_id = v_customer_id
  ) m on true
  left join lateral (
    select
      sum(case when d.direction = 'owed' then d.amount_cfa else -d.amount_cfa end)::integer as dette,
      coalesce(sum(case when d.direction = 'owed'
        and public.debt_entry_state(d.customer_confirmed_at, r.decision) = 'confirmed'
        then d.amount_cfa else 0 end), 0)::integer as confirmee,
      coalesce(sum(case when d.direction = 'owed'
        and public.debt_entry_state(d.customer_confirmed_at, r.decision) = 'declared'
        then d.amount_cfa else 0 end), 0)::integer as declaree,
      coalesce(sum(case when d.direction = 'owed'
        and public.debt_entry_state(d.customer_confirmed_at, r.decision) = 'disputed'
        then d.amount_cfa else 0 end), 0)::integer as contestee,
      max(d.created_at) as derniere
    from public.debt_entries d
    left join public.debt_reviews r on r.debt_entry_id = d.id
    where d.vendor_id = b.vendor_id and d.customer_id = v_customer_id
  ) dt on true
  left join lateral public.debt_ageing(b.vendor_id, v_customer_id) ag on true
  left join lateral (
    select true as ouverte from public.payment_claims x
     where x.vendor_id = b.vendor_id and x.customer_id = v_customer_id
       and x.resolved_at is null
     limit 1
  ) pc on true
  where coalesce(m.monnaie, 0) > 0 or coalesce(dt.dette, 0) > 0
  order by coalesce(dt.dette, 0) desc, coalesce(m.monnaie, 0) desc
  limit greatest(1, least(coalesce(p_limit, 100), 200));
end
$fn$;

revoke all on function public.customer_shop_positions(uuid, integer) from public, anon;
grant execute on function public.customer_shop_positions(uuid, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- The admin signal, extended
--
-- Ageing and settlement behaviour alongside the déclarée share. A vendor whose
-- claims are never confirmed AND whose debts never close is a different problem from
-- one with a lot of unregistered customers.
-- ---------------------------------------------------------------------------
-- Dropped first: create or replace cannot rename or reorder a view's columns,
-- and this adds `settlements` in the middle of the list.
drop view if exists public.v_vendor_debt_mix;

create view public.v_vendor_debt_mix as
select
  v.id as vendor_id,
  v.business_name,
  v.phone,
  count(*) filter (where d.direction = 'owed')::integer as debts,
  count(*) filter (where d.direction = 'repaid')::integer as settlements,
  count(*) filter (where d.direction = 'owed'
    and public.debt_entry_state(d.customer_confirmed_at, r.decision) = 'confirmed')::integer
    as confirmed,
  count(*) filter (where d.direction = 'owed'
    and public.debt_entry_state(d.customer_confirmed_at, r.decision) = 'declared')::integer
    as declared,
  count(*) filter (where d.direction = 'owed'
    and public.debt_entry_state(d.customer_confirmed_at, r.decision) = 'disputed')::integer
    as disputed,
  round(100.0 * count(*) filter (where d.direction = 'owed'
      and public.debt_entry_state(d.customer_confirmed_at, r.decision) = 'declared')
    / nullif(count(*) filter (where d.direction = 'owed'), 0), 1) as declared_pct,
  round(100.0 * count(*) filter (where d.direction = 'owed'
      and public.debt_entry_state(d.customer_confirmed_at, r.decision) = 'disputed')
    / nullif(count(*) filter (where d.direction = 'owed'), 0), 1) as disputed_pct,
  -- A book that never turns over. Settlements per debt, as a percentage: a
  -- vendor at 0% is either not recording payments or not collecting, and the
  -- open claims column says which.
  round(100.0 * count(*) filter (where d.direction = 'repaid')
    / nullif(count(*) filter (where d.direction = 'owed'), 0), 1) as settled_pct,
  coalesce(sum(case when d.direction = 'owed' then d.amount_cfa else -d.amount_cfa end), 0)::integer
    as outstanding_cfa,
  count(distinct d.customer_id)::integer as debtors,
  (select count(*)::integer from public.payment_claims pc
    where pc.vendor_id = v.id and pc.resolved_at is null) as open_claims,
  (select count(*)::integer from public.payment_claims pc
    where pc.vendor_id = v.id and pc.resolution = 'rejected') as rejected_claims
from public.vendors v
left join public.debt_entries d on d.vendor_id = v.id
left join public.debt_reviews r on r.debt_entry_id = d.id
group by v.id, v.business_name, v.phone;

revoke all on public.v_vendor_debt_mix from public, anon, authenticated;
