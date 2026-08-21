-- 0021 — The admin panel's data layer, and phone verification.  (Item E)
--
-- Every function here checks is_admin() server-side. None is granted to any
-- client role: the Edge Function calls them as service role after proving the
-- caller is an admin. There is no hidden URL and no client-side flag anywhere in
-- this path — an admin screen that merely hides itself is not access control.

-- ---------------------------------------------------------------------------
-- Verification state.
--
-- IN-PERSON FIRST, because it needs no SMS and is stronger: the operator calls
-- the number, watches it ring in front of them, and marks it. An OTP proves
-- somebody controls the handset; a face-to-face call proves who is holding it.
-- ---------------------------------------------------------------------------
alter table public.vendors
  add column if not exists phone_verified_at timestamptz,
  add column if not exists verification_method text;

alter table public.customers
  add column if not exists phone_verified_at timestamptz,
  add column if not exists verification_method text;

do $g$
begin
  if not exists (select 1 from pg_constraint where conname = 'vendors_verification_method_valid') then
    alter table public.vendors add constraint vendors_verification_method_valid
      check (verification_method in ('sms','in_person'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'customers_verification_method_valid') then
    alter table public.customers add constraint customers_verification_method_valid
      check (verification_method in ('sms','in_person'));
  end if;
  -- A method without a timestamp, or vice versa, is a half-written record.
  if not exists (select 1 from pg_constraint where conname = 'vendors_verification_consistent') then
    alter table public.vendors add constraint vendors_verification_consistent
      check ((phone_verified_at is null) = (verification_method is null));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'customers_verification_consistent') then
    alter table public.customers add constraint customers_verification_consistent
      check ((phone_verified_at is null) = (verification_method is null));
  end if;
end
$g$;

-- ---------------------------------------------------------------------------
-- Every vendor, with the numbers needed to judge them.
-- ---------------------------------------------------------------------------
create or replace function public.admin_vendor_list(p_actor_user_id uuid)
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
    -- The fraud signal, inline. A separate screen would not get looked at.
    debits              integer,
    vendor_device_debits integer,
    vendor_device_pct   numeric,
    vendor_corrections  integer
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
  if not public.is_admin(p_actor_user_id) then
    raise exception 'SIKA_ADMIN_ONLY' using errcode = 'SW001';
  end if;

  return query
  select
    v.id, v.business_name, v.quartier, v.commune, v.phone, v.is_active,
    v.phone_verified_at, v.verification_method, v.created_at,
    coalesce(b.circulation, 0), coalesce(b.clients, 0),
    coalesce(b.nombre, 0), b.derniere,
    coalesce(m.debits, 0), coalesce(m.vd, 0), m.pct, coalesce(m.corrections, 0)
  from public.vendors v
  left join lateral (
    select
      sum(greatest(s.solde, 0))::integer      as circulation,
      count(*) filter (where s.solde > 0)::integer as clients,
      sum(s.n)::integer                       as nombre,
      max(s.derniere)                         as derniere
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
  -- Unverified first, then biggest exposure: the two things that need looking at.
  order by (v.phone_verified_at is null) desc, coalesce(b.circulation, 0) desc;
end
$fn$;

revoke all on function public.admin_vendor_list(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Mark a phone verified in person.
-- ---------------------------------------------------------------------------
create or replace function public.admin_verify_phone(
  p_role          text,
  p_target_id     uuid,
  p_method        text,
  p_actor_user_id uuid
)
  returns timestamptz
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $fn$
declare
  v_caller uuid;
  v_when   timestamptz;
begin
  v_caller := public.app_current_user_id();
  if v_caller is not null and v_caller <> p_actor_user_id then
    raise exception 'SIKA_ACTOR_MISMATCH' using errcode = 'SW002';
  end if;
  if not public.is_admin(p_actor_user_id) then
    raise exception 'SIKA_ADMIN_ONLY' using errcode = 'SW001';
  end if;
  if p_method not in ('sms','in_person') then
    raise exception 'SIKA_INVALID_METHOD' using errcode = 'SW007';
  end if;
  if p_role not in ('vendor','customer') then
    raise exception 'SIKA_INVALID_ROLE' using errcode = 'SW007';
  end if;

  v_when := now();

  if p_role = 'vendor' then
    update public.vendors
       set phone_verified_at = v_when, verification_method = p_method
     where id = p_target_id;
  else
    update public.customers
       set phone_verified_at = v_when, verification_method = p_method
     where id = p_target_id;
  end if;

  if not found then
    raise exception 'SIKA_TARGET_NOT_FOUND' using errcode = 'SW008';
  end if;

  return v_when;
end
$fn$;

revoke all on function public.admin_verify_phone(text, uuid, text, uuid)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Deactivate or reinstate a vendor.
--
-- is_active = false stops them posting anything (checked in post_ledger_entry
-- and create_pending_debit). It does NOT erase history: customers keep their
-- balances and can still be repaid, because the debt is the vendor's and does
-- not stop existing because their account was switched off.
-- ---------------------------------------------------------------------------
create or replace function public.admin_set_vendor_active(
  p_vendor_id     uuid,
  p_active        boolean,
  p_actor_user_id uuid
)
  returns boolean
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $fn$
declare
  v_caller uuid;
begin
  v_caller := public.app_current_user_id();
  if v_caller is not null and v_caller <> p_actor_user_id then
    raise exception 'SIKA_ACTOR_MISMATCH' using errcode = 'SW002';
  end if;
  if not public.is_admin(p_actor_user_id) then
    raise exception 'SIKA_ADMIN_ONLY' using errcode = 'SW001';
  end if;

  update public.vendors set is_active = p_active where id = p_vendor_id;
  if not found then
    raise exception 'SIKA_VENDOR_NOT_FOUND' using errcode = 'SW008';
  end if;

  return p_active;
end
$fn$;

revoke all on function public.admin_set_vendor_active(uuid, boolean, uuid)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- A customer's view of whether the shop holding their change is verified.
--
-- Appended to the existing balance function rather than added as a second call:
-- a screen that needs two round trips to say "unverified" will end up shipping
-- without the second one.
-- ---------------------------------------------------------------------------
-- DROP first: adding a column changes the return type, which create-or-replace
-- cannot do. Nothing depends on this function except the app, which is deployed
-- together with the migration.
drop function if exists public.customer_shop_balances(uuid);

create function public.customer_shop_balances(p_actor_user_id uuid)
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
  order by 5 desc, 6 desc;
end
$fn$;

revoke all on function public.customer_shop_balances(uuid) from public, anon;
grant execute on function public.customer_shop_balances(uuid) to authenticated;
