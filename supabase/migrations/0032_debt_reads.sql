-- 0032 — Reading the debt register.
--
-- Every function here is BOUNDED and returns total_count, per the audit in 0025.
--
-- WHAT NO FUNCTION IN THIS FILE DOES: return a figure spanning both registers.
-- There is no signed net, no "position", no single number combining change and
-- debt. A caller wanting both gets two fields and has to render them as two
-- figures, because that is what they are.
--
-- The state of a debt is DERIVED here, in one place:
--
--   CONFIRMÉE  — customer_confirmed_at is set (own device, at creation), OR a
--                debt_reviews row says 'accepted' (own device, at review)
--   CONTESTÉE  — a debt_reviews row says 'disputed'
--   DÉCLARÉE   — neither. A claim the customer has not answered.
--
-- Derived rather than stored so the append-only rule holds: accepting a claim
-- writes a review row, it does not flip a column on the entry.

-- ---------------------------------------------------------------------------
-- The state of one entry, so every caller agrees on the words
-- ---------------------------------------------------------------------------
create or replace function public.debt_entry_state(
  p_confirmed_at timestamptz,
  p_decision     text
)
  returns text
  language sql
  immutable
as $fn$
  select case
    when p_confirmed_at is not null then 'confirmed'
    when p_decision = 'accepted'    then 'confirmed'
    when p_decision = 'disputed'    then 'disputed'
    else 'declared'
  end
$fn$;

-- ---------------------------------------------------------------------------
-- Vendor: who owes me, most and oldest first
-- ---------------------------------------------------------------------------
drop function if exists public.vendor_debtors(uuid, uuid, integer);

create function public.vendor_debtors(
  p_vendor_id     uuid,
  p_actor_user_id uuid,
  p_limit         integer default 200
)
  returns table (
    customer_id       uuid,
    phone             text,
    your_label        text,
    is_registered     boolean,
    debt_cfa          integer,
    -- Split out so a vendor can see how much of what they are owed rests on a
    -- claim nobody has agreed to. It is their own exposure, not a judgement.
    confirmed_cfa     integer,
    declared_cfa      integer,
    disputed_cfa      integer,
    oldest_debt_at    timestamptz,
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
    b.plus_ancienne, b.derniere, b.nombre, v_total
  from public.customers c
  join lateral (
    select
      sum(case when d.direction = 'owed' then d.amount_cfa else -d.amount_cfa end)::integer as dette,
      -- Only the 'owed' side is attributed to a state: a repayment has no state,
      -- it simply happened. So these three sum to what was ever claimed, not to
      -- the outstanding figure, and the screens say so.
      coalesce(sum(case when d.direction = 'owed'
        and public.debt_entry_state(d.customer_confirmed_at, r.decision) = 'confirmed'
        then d.amount_cfa else 0 end), 0)::integer as confirmee,
      coalesce(sum(case when d.direction = 'owed'
        and public.debt_entry_state(d.customer_confirmed_at, r.decision) = 'declared'
        then d.amount_cfa else 0 end), 0)::integer as declaree,
      coalesce(sum(case when d.direction = 'owed'
        and public.debt_entry_state(d.customer_confirmed_at, r.decision) = 'disputed'
        then d.amount_cfa else 0 end), 0)::integer as contestee,
      min(case when d.direction = 'owed' then d.created_at end) as plus_ancienne,
      max(d.created_at) as derniere,
      count(*)::integer as nombre
    from public.debt_entries d
    left join public.debt_reviews r on r.debt_entry_id = d.id
    where d.vendor_id = p_vendor_id and d.customer_id = c.id
  ) b on true
  left join public.vendor_customer_labels l
    on l.vendor_id = p_vendor_id and l.customer_id = c.id
  where b.dette > 0
  -- Largest first, then oldest: the two things a vendor chasing debts sorts by.
  order by b.dette desc, b.plus_ancienne asc nulls last
  limit v_limite;
end
$fn$;

revoke all on function public.vendor_debtors(uuid, uuid, integer) from public, anon;
grant execute on function public.vendor_debtors(uuid, uuid, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- Vendor: the two figures for the home screen, side by side, never merged
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
    oldest_debt_at  timestamptz
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

  -- Aggregated in SQL and returned as ONE row, for the same reason the
  -- circulation figure is: a headline figure that could disagree with a bounded
  -- list must not be computed from that list.
  return query
  select
    coalesce(sum(greatest(s.dette, 0)), 0)::integer,
    count(*) filter (where s.dette > 0)::integer,
    coalesce(sum(s.confirmee), 0)::integer,
    coalesce(sum(s.declaree), 0)::integer,
    coalesce(sum(s.contestee), 0)::integer,
    coalesce(sum(s.nb_contestees), 0)::integer,
    min(s.plus_ancienne)
  from (
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
      count(*) filter (where r.decision = 'disputed')::integer as nb_contestees,
      min(case when d.direction = 'owed' then d.created_at end) as plus_ancienne
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
-- Vendor: the entries for one debtor
-- ---------------------------------------------------------------------------
drop function if exists public.vendor_debt_history(uuid, uuid, uuid, integer);

create function public.vendor_debt_history(
  p_vendor_id     uuid,
  p_customer_id   uuid,
  p_actor_user_id uuid,
  p_limit         integer default 100
)
  returns table (
    id             uuid,
    direction      text,
    kind           text,
    amount_cfa     integer,
    state          text,
    dispute_reason text,
    note           text,
    created_at     timestamptz,
    running_debt   integer,
    total_count    integer
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
  perform 1 from public.vendors v
   where v.id = p_vendor_id and v.auth_user_id = p_actor_user_id;
  if not found then
    raise exception 'SIKA_VENDOR_FORBIDDEN' using errcode = 'SW001';
  end if;

  select count(*)::integer into v_total from public.debt_entries d
   where d.vendor_id = p_vendor_id and d.customer_id = p_customer_id;

  -- A running debt IS legitimate here, unlike the cross-vendor histories: one
  -- vendor, one customer, one debt. The figure is real and shows how it was
  -- arrived at.
  return query
  select
    d.id, d.direction, d.kind, d.amount_cfa,
    public.debt_entry_state(d.customer_confirmed_at, r.decision),
    case when r.decision = 'disputed' then r.reason end,
    d.note, d.created_at,
    sum(case when d.direction = 'owed' then d.amount_cfa else -d.amount_cfa end)
      over (order by d.created_at, d.id)::integer,
    v_total
  from public.debt_entries d
  left join public.debt_reviews r on r.debt_entry_id = d.id
  where d.vendor_id = p_vendor_id and d.customer_id = p_customer_id
  order by d.created_at desc, d.id desc
  limit greatest(1, least(coalesce(p_limit, 100), 500));
end
$fn$;

revoke all on function public.vendor_debt_history(uuid, uuid, uuid, integer) from public, anon;
grant execute on function public.vendor_debt_history(uuid, uuid, uuid, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- Customer: what I hold and what I owe, per shop, as TWO figures
-- ---------------------------------------------------------------------------
drop function if exists public.customer_shop_positions(uuid, integer);

create function public.customer_shop_positions(
  p_actor_user_id uuid,
  p_limit         integer default 100
)
  returns table (
    vendor_id        uuid,
    business_name    text,
    quartier         text,
    -- Change the customer HOLDS at this shop. Never combined with the next
    -- column. There is deliberately no third column that nets them.
    change_cfa       integer,
    -- Debt the customer OWES this shop.
    debt_cfa         integer,
    debt_confirmed_cfa integer,
    debt_declared_cfa  integer,
    debt_disputed_cfa  integer,
    -- How much could be offset if they asked: the smaller of the two. Offered as
    -- a bound on an ACTION, not as a net position — it is never negative and
    -- never displayed as a balance.
    compensable_cfa  integer,
    last_activity_at timestamptz,
    total_count      integer
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
    greatest(0, least(coalesce(m.monnaie, 0), coalesce(dt.dette, 0))),
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
  -- A shop where the customer holds nothing and owes nothing is not a
  -- relationship worth a card.
  where coalesce(m.monnaie, 0) > 0 or coalesce(dt.dette, 0) > 0
  order by coalesce(dt.dette, 0) desc, coalesce(m.monnaie, 0) desc
  limit greatest(1, least(coalesce(p_limit, 100), 200));
end
$fn$;

revoke all on function public.customer_shop_positions(uuid, integer) from public, anon;
grant execute on function public.customer_shop_positions(uuid, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- Customer: my debt entries at one shop, with their state
-- ---------------------------------------------------------------------------
drop function if exists public.customer_debt_history(uuid, uuid, integer);

create function public.customer_debt_history(
  p_actor_user_id uuid,
  p_vendor_id     uuid,
  p_limit         integer default 100
)
  returns table (
    id             uuid,
    direction      text,
    kind           text,
    amount_cfa     integer,
    state          text,
    dispute_reason text,
    note           text,
    created_at     timestamptz,
    -- Whether THIS customer can still answer this entry. False once reviewed or
    -- confirmed, so a screen never offers a button that will be refused.
    reviewable     boolean,
    running_debt   integer,
    total_count    integer
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

  select count(*)::integer into v_total from public.debt_entries d
   where d.customer_id = v_customer_id and d.vendor_id = p_vendor_id;

  return query
  select
    d.id, d.direction, d.kind, d.amount_cfa,
    public.debt_entry_state(d.customer_confirmed_at, r.decision),
    case when r.decision = 'disputed' then r.reason end,
    d.note, d.created_at,
    (d.customer_confirmed_at is null and r.id is null and d.direction = 'owed'),
    sum(case when d.direction = 'owed' then d.amount_cfa else -d.amount_cfa end)
      over (order by d.created_at, d.id)::integer,
    v_total
  from public.debt_entries d
  left join public.debt_reviews r on r.debt_entry_id = d.id
  where d.customer_id = v_customer_id and d.vendor_id = p_vendor_id
  order by d.created_at desc, d.id desc
  limit greatest(1, least(coalesce(p_limit, 100), 500));
end
$fn$;

revoke all on function public.customer_debt_history(uuid, uuid, integer) from public, anon;
grant execute on function public.customer_debt_history(uuid, uuid, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- THE REVIEW QUEUE
--
-- Everything recorded against this customer that they have never answered, both
-- registers, newest first. Surfaced at first login and available afterwards.
--
-- WHY THIS IS THE MOST IMPORTANT FUNCTION IN THE FILE. A vendor can record a
-- déclarée debt against any phone number, including numbers belonging to people
-- who have never heard of Sika Warri. If registering silently turned those
-- claims into established fact, pre-loading debts against a list of numbers would
-- be a working attack, and the register would be worse than the paper carnet it
-- replaces. So nothing is ever accepted by default, by signup, or by the passage
-- of time. A claim stays a claim until the person it is against says otherwise on
-- their own device.
-- ---------------------------------------------------------------------------
drop function if exists public.my_review_queue(uuid, integer);

create function public.my_review_queue(
  p_actor_user_id uuid,
  p_limit         integer default 100
)
  returns table (
    register       text,       -- 'debt' or 'change'
    entry_id       uuid,
    vendor_id      uuid,
    business_name  text,
    quartier       text,
    kind           text,
    amount_cfa     integer,
    note           text,
    created_at     timestamptz,
    total_count    integer
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
    select d.id from public.debt_entries d
     left join public.debt_reviews r on r.debt_entry_id = d.id
     where d.customer_id = v_customer_id
       and d.direction = 'owed'
       and d.customer_confirmed_at is null
       and r.id is null
    union all
    select e.id from public.ledger_entries e
     left join public.ledger_reviews lr on lr.ledger_entry_id = e.id
     where e.customer_id = v_customer_id
       and e.direction = 'credit'
       and e.customer_confirmed_at is null
       and lr.id is null
  ) t;

  return query
  select * from (
    -- The debt side. This is the half that matters: a claim that the customer
    -- owes money.
    select
      'debt'::text, d.id, d.vendor_id, v.business_name, v.quartier,
      d.kind, d.amount_cfa, d.note, d.created_at, v_total
    from public.debt_entries d
    join public.vendors v on v.id = d.vendor_id
    left join public.debt_reviews r on r.debt_entry_id = d.id
    where d.customer_id = v_customer_id
      and d.direction = 'owed'
      and d.customer_confirmed_at is null
      and r.id is null

    union all

    -- The change side. Included for consistency, as asked: a customer reviewing
    -- what was recorded in their name before they had an account should see all
    -- of it. Disputing one of these says "you owe me LESS than you claim", which
    -- is against the customer's own interest, so the risk here is nil — but the
    -- two ledgers behaving alike is worth more than the saved rows.
    select
      'change'::text, e.id, e.vendor_id, v.business_name, v.quartier,
      e.kind, e.amount_cfa, e.note, e.created_at, v_total
    from public.ledger_entries e
    join public.vendors v on v.id = e.vendor_id
    left join public.ledger_reviews lr on lr.ledger_entry_id = e.id
    where e.customer_id = v_customer_id
      and e.direction = 'credit'
      and e.customer_confirmed_at is null
      and lr.id is null
  ) q
  -- Debts first within a day, because they are the ones that cost the reader
  -- money if wrong.
  order by q.created_at desc, (q.register = 'change')
  limit greatest(1, least(coalesce(p_limit, 100), 500));
end
$fn$;

revoke all on function public.my_review_queue(uuid, integer) from public, anon;
grant execute on function public.my_review_queue(uuid, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- Admin: the déclarée share, as a fraud signal
--
-- Sits alongside the vendor_device confirmation mix already in the panel. A high
-- déclarée share is not proof of anything — a vendor whose customers are mostly
-- unregistered has no other option — but a vendor whose claims are almost never
-- confirmed, or are frequently disputed, is worth a phone call.
-- ---------------------------------------------------------------------------
create or replace view public.v_vendor_debt_mix as
select
  v.id as vendor_id,
  v.business_name,
  v.phone,
  count(*) filter (where d.direction = 'owed')::integer as debts,
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
  coalesce(sum(case when d.direction = 'owed' then d.amount_cfa else -d.amount_cfa end), 0)::integer
    as outstanding_cfa,
  count(distinct d.customer_id)::integer as debtors
from public.vendors v
left join public.debt_entries d on d.vendor_id = v.id
left join public.debt_reviews r on r.debt_entry_id = d.id
group by v.id, v.business_name, v.phone;

revoke all on public.v_vendor_debt_mix from public, anon, authenticated;
