-- 0015 — Read paths for the balance and client screens.
--
-- Why these are functions rather than plain selects:
--
--   * A customer has NO select privilege on vendors (amendment F), because a
--     vendors row carries names entered by other people. But you cannot show
--     someone "your change at Chez Awa" without the words "Chez Awa". So a
--     definer function discloses exactly the shop identity needed for a
--     relationship that already exists, and nothing else.
--
--   * A vendor has no select on customers for the same reason. "Mes clients"
--     needs the phone number and this vendor's own private label — never a
--     name another vendor gave the same person.
--
-- None of these sum across vendors. Each returns one row per relationship, and
-- the caller decides what to render (acceptance test 8).

-- ---------------------------------------------------------------------------
-- Customer: one row per shop holding their change.
-- ---------------------------------------------------------------------------
create or replace function public.customer_shop_balances(p_actor_user_id uuid)
  returns table (
    vendor_id        uuid,
    business_name    text,
    quartier         text,
    commune          text,
    balance_cfa      integer,
    last_activity_at timestamptz,
    entry_count      integer
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
    count(*)::integer
  from public.ledger_entries e
  join public.vendors v on v.id = e.vendor_id
  where e.customer_id = v_customer_id
  group by e.vendor_id, v.business_name, v.quartier, v.commune
  -- Ordered per shop. Deliberately NOT aggregated further: there is no row here
  -- representing a total, and none can be produced by reading more rows.
  order by 5 desc, 6 desc;
end
$fn$;

revoke all on function public.customer_shop_balances(uuid) from public, anon;
grant execute on function public.customer_shop_balances(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Customer: their history with ONE shop.
-- ---------------------------------------------------------------------------
create or replace function public.customer_shop_history(
  p_actor_user_id uuid,
  p_vendor_id     uuid,
  p_limit         integer default 100
)
  returns table (
    id                  uuid,
    direction           text,
    kind                text,
    amount_cfa          integer,
    confirmation_method text,
    note                text,
    created_at          timestamptz,
    receipt_code        text,
    running_balance     integer
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
    e.id, e.direction, e.kind, e.amount_cfa, e.confirmation_method, e.note,
    e.created_at,
    public.entry_receipt_code(e.id),
    -- Balance after each entry, so a customer can see how a figure was
    -- arrived at rather than being asked to trust a single number.
    sum(case when e.direction = 'credit' then e.amount_cfa else -e.amount_cfa end)
      over (order by e.created_at, e.id)::integer
  from public.ledger_entries e
  where e.customer_id = v_customer_id
    and e.vendor_id = p_vendor_id
  order by e.created_at desc, e.id desc
  limit greatest(1, least(coalesce(p_limit, 100), 500));
end
$fn$;

revoke all on function public.customer_shop_history(uuid, uuid, integer) from public, anon;
grant execute on function public.customer_shop_history(uuid, uuid, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- Vendor: who they owe.
-- ---------------------------------------------------------------------------
create or replace function public.vendor_customers(
  p_vendor_id     uuid,
  p_actor_user_id uuid
)
  returns table (
    customer_id      uuid,
    phone            text,
    your_label       text,
    balance_cfa      integer,
    last_activity_at timestamptz,
    entry_count      integer,
    is_registered    boolean
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
    c.id,
    c.phone,
    -- This vendor's own label only. customers.display_name is the name the
    -- customer chose for themselves and is not this vendor's to read, and a
    -- label written by a different vendor is never disclosed (amendment F).
    l.display_name,
    b.balance,
    b.derniere,
    b.nombre,
    c.auth_user_id is not null
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
  -- Sorted by what is owed, largest first: the spec asks for it and it is the
  -- order a vendor actually cares about.
  order by b.balance desc nulls last, b.derniere desc;
end
$fn$;

revoke all on function public.vendor_customers(uuid, uuid) from public, anon;
grant execute on function public.vendor_customers(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Vendor: their history with ONE customer.
-- ---------------------------------------------------------------------------
create or replace function public.vendor_customer_history(
  p_vendor_id     uuid,
  p_customer_id   uuid,
  p_actor_user_id uuid,
  p_limit         integer default 100
)
  returns table (
    id                  uuid,
    direction           text,
    kind                text,
    amount_cfa          integer,
    confirmation_method text,
    note                text,
    created_at          timestamptz,
    receipt_code        text,
    running_balance     integer
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
    e.id, e.direction, e.kind, e.amount_cfa, e.confirmation_method, e.note,
    e.created_at,
    public.entry_receipt_code(e.id),
    sum(case when e.direction = 'credit' then e.amount_cfa else -e.amount_cfa end)
      over (order by e.created_at, e.id)::integer
  from public.ledger_entries e
  where e.vendor_id = p_vendor_id
    and e.customer_id = p_customer_id
  order by e.created_at desc, e.id desc
  limit greatest(1, least(coalesce(p_limit, 100), 500));
end
$fn$;

revoke all on function public.vendor_customer_history(uuid, uuid, uuid, integer)
  from public, anon;
grant execute on function public.vendor_customer_history(uuid, uuid, uuid, integer)
  to authenticated;
