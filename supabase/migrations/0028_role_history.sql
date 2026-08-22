-- 0028 — Historique for both roles: every movement, not one pair at a time.
--
-- What existed was per-pair: customer_shop_history (this customer at that shop)
-- and vendor_customer_history (this vendor with that customer). Both are the
-- right thing when you have opened a card. Neither answers "what happened
-- today", which is the question a vendor closing up actually has.
--
-- NO RUNNING BALANCE HERE, deliberately, and this is the whole design decision.
-- A running balance across vendors would be a cross-vendor total computed one
-- row at a time — standing rule 1 broken quietly, in a column, where it would
-- look like arithmetic rather than a claim. The per-pair views keep their
-- running balance because there the figure is real: one customer, one vendor,
-- one debt. Here each row names its counterparty and its own amount, and there
-- is no column that adds up.
--
-- Both are bounded and both return the true total, so a truncated page is
-- visible as truncated (see 0025).

-- ---------------------------------------------------------------------------
-- Vendor: every movement, across all their customers.
-- ---------------------------------------------------------------------------
create or replace function public.vendor_history(
  p_vendor_id     uuid,
  p_actor_user_id uuid,
  p_limit         integer default 100
)
  returns table (
    id                  uuid,
    customer_id         uuid,
    customer_phone      text,
    customer_label      text,
    direction           text,
    kind                text,
    amount_cfa          integer,
    confirmation_method text,
    note                text,
    created_at          timestamptz,
    receipt_code        text,
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

  perform 1 from public.vendors v
   where v.id = p_vendor_id and v.auth_user_id = p_actor_user_id;
  if not found then
    raise exception 'SIKA_VENDOR_FORBIDDEN' using errcode = 'SW001';
  end if;

  select count(*)::integer into v_total
  from public.ledger_entries e where e.vendor_id = p_vendor_id;

  return query
  select
    e.id, e.customer_id, c.phone, l.display_name,
    e.direction, e.kind, e.amount_cfa, e.confirmation_method, e.note,
    e.created_at, public.entry_receipt_code(e.id), v_total
  from public.ledger_entries e
  join public.customers c on c.id = e.customer_id
  left join public.vendor_customer_labels l
    on l.vendor_id = p_vendor_id and l.customer_id = e.customer_id
  where e.vendor_id = p_vendor_id
  order by e.created_at desc, e.id desc
  limit greatest(1, least(coalesce(p_limit, 100), 500));
end
$fn$;

revoke all on function public.vendor_history(uuid, uuid, integer) from public, anon;
grant execute on function public.vendor_history(uuid, uuid, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- Customer: every movement, across all the shops holding their change.
--
-- Names the shop on each row. That is the same minimal disclosure
-- pending_debits_for_customer already makes: you cannot show someone a movement
-- without saying who it was with.
-- ---------------------------------------------------------------------------
create or replace function public.customer_history(
  p_actor_user_id uuid,
  p_limit         integer default 100
)
  returns table (
    id                  uuid,
    vendor_id           uuid,
    business_name       text,
    direction           text,
    kind                text,
    amount_cfa          integer,
    confirmation_method text,
    note                text,
    created_at          timestamptz,
    receipt_code        text,
    total_count         integer
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

  select c.id into v_customer_id
  from public.customers c where c.auth_user_id = p_actor_user_id;
  if not found then
    raise exception 'SIKA_CUSTOMER_NOT_FOUND' using errcode = 'SW008';
  end if;

  select count(*)::integer into v_total
  from public.ledger_entries e where e.customer_id = v_customer_id;

  return query
  select
    e.id, e.vendor_id, v.business_name,
    e.direction, e.kind, e.amount_cfa, e.confirmation_method, e.note,
    e.created_at, public.entry_receipt_code(e.id), v_total
  from public.ledger_entries e
  join public.vendors v on v.id = e.vendor_id
  where e.customer_id = v_customer_id
  order by e.created_at desc, e.id desc
  limit greatest(1, least(coalesce(p_limit, 100), 500));
end
$fn$;

revoke all on function public.customer_history(uuid, integer) from public, anon;
grant execute on function public.customer_history(uuid, integer) to authenticated;
