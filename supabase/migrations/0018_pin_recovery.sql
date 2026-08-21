-- 0018 — PIN recovery.
--
-- THE PROBLEM. A forgotten PIN currently locks someone out of their own ledger
-- permanently. For a vendor that means every customer holding change at that
-- shop can never spend it. There is no SMS, so there is no automated proof of
-- phone ownership to build a reset link on.
--
-- THE SHAPE. Somebody has to vouch, in person, and the two roles get different
-- answers because the exposure is different.
--
--   CUSTOMER — a vendor vouches. They recognise the person standing in front of
--   them and request a reset; the customer then sets a new PIN on their own
--   device. Acceptable because exposure is capped at max_balance_per_customer
--   (3 000 F by default) per vendor.
--
--   VENDOR — admin only, after a conversation. A compromised vendor account can
--   write off every balance the shop holds, so there is no safe automated path
--   without SMS. Deliberately not self-service.
--
-- WHAT THIS DOES NOT PROTECT AGAINST — stated here because it must not be
-- discovered later:
--
--   1. The vouching vendor can claim the reset themselves. They request it,
--      then enter the customer's number on their own phone and set a PIN they
--      know. They now control that customer's account and can confirm debits —
--      which is precisely what amendment H exists to prevent. Mitigated, not
--      eliminated: see the cooling-off period below, the log, and the
--      frequency signal. A patient attacker defeats the cooling-off by waiting.
--
--   2. Anyone who knows the customer's number and is faster than the customer
--      inside the claim window can take the account. The window is short and
--      single-use, and the customer is standing at the counter, but this is a
--      real race.
--
--   3. Nothing here proves phone ownership. That needs SMS, which is what
--      SIKA_REQUIRE_*_SMS_VERIFICATION is being built for.

create table if not exists public.pin_resets (
  id                uuid primary key default gen_random_uuid(),

  target_role       text not null check (target_role in ('vendor','customer')),
  -- Exactly one of these, matching target_role.
  target_customer_id uuid references public.customers(id),
  target_vendor_id   uuid references public.vendors(id),

  -- Who vouched. A customer reset names the vendor; a vendor reset names the
  -- admin auth user. Never both, never neither — an unattributed reset is not
  -- a reset, it is a hole.
  requested_by_vendor_id uuid references public.vendors(id),
  requested_by_admin_id  uuid,

  reason            text,
  created_at        timestamptz not null default now(),
  expires_at        timestamptz not null,
  consumed_at       timestamptz,
  -- Recorded when claimed, purely so an investigation has something to read.
  consumed_ip       inet,

  constraint pin_resets_target_matches_role check (
    (target_role = 'customer' and target_customer_id is not null and target_vendor_id is null)
    or
    (target_role = 'vendor'   and target_vendor_id is not null and target_customer_id is null)
  ),

  constraint pin_resets_attributed check (
    (requested_by_vendor_id is not null) <> (requested_by_admin_id is not null)
  ),

  -- A vendor reset may ONLY be authorised by an admin. Without this a vendor
  -- could vouch for another vendor, which is the whole thing being avoided.
  constraint pin_resets_vendor_needs_admin check (
    target_role <> 'vendor' or requested_by_admin_id is not null
  ),

  constraint pin_resets_expiry_after_creation check (expires_at > created_at)
);

create index if not exists pin_resets_open_customer_idx
  on public.pin_resets (target_customer_id, expires_at desc)
  where consumed_at is null;

create index if not exists pin_resets_open_vendor_idx
  on public.pin_resets (target_vendor_id, expires_at desc)
  where consumed_at is null;

-- The fraud signal: who is requesting these, and how often.
create index if not exists pin_resets_by_vendor_idx
  on public.pin_resets (requested_by_vendor_id, created_at desc)
  where requested_by_vendor_id is not null;

alter table public.pin_resets enable row level security;
revoke all on public.pin_resets from anon, authenticated;

-- A customer may see resets performed on their own account. That is the
-- surfacing requirement: someone else asked for their code to be reset, and
-- they must be able to see it happened.
grant select on public.pin_resets to authenticated;

drop policy if exists pin_resets_select_own on public.pin_resets;
create policy pin_resets_select_own on public.pin_resets
  for select to authenticated
  using (
    target_customer_id = public.app_current_customer_id()
    or target_vendor_id = public.app_current_vendor_id()
    -- The vouching vendor sees their own requests, so they can tell whether the
    -- customer has claimed it yet.
    or requested_by_vendor_id = public.app_current_vendor_id()
  );

-- ---------------------------------------------------------------------------
-- How long a claim stays open, and how long the vouching vendor is barred from
-- debiting the account afterwards.
-- ---------------------------------------------------------------------------
create or replace function public.pin_reset_window()
  returns interval language sql immutable as $$ select interval '15 minutes' $$;

/**
 * Cooling-off after a vendor-vouched reset.
 *
 * Breaks the immediate-drain path: a vendor who resets a customer's PIN and
 * claims it themselves cannot then spend that customer's change straight away.
 * It does NOT stop a patient attacker, and it is not presented as if it does.
 */
create or replace function public.pin_reset_cooloff()
  returns interval language sql immutable as $$ select interval '60 minutes' $$;

grant execute on function public.pin_reset_window() to authenticated;
grant execute on function public.pin_reset_cooloff() to authenticated;

-- ---------------------------------------------------------------------------
-- A vendor vouches for a customer.
-- ---------------------------------------------------------------------------
create or replace function public.request_customer_pin_reset(
  p_vendor_id     uuid,
  p_customer_id   uuid,
  p_actor_user_id uuid,
  p_reason        text default null
)
  returns public.pin_resets
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $fn$
declare
  v_caller uuid;
  v_ouvert public.pin_resets;
  v_row    public.pin_resets;
  v_recent integer;
begin
  if p_actor_user_id is null then
    raise exception 'SIKA_ACTOR_REQUIRED' using errcode = 'SW003';
  end if;

  v_caller := public.app_current_user_id();
  if v_caller is not null and v_caller <> p_actor_user_id then
    raise exception 'SIKA_ACTOR_MISMATCH' using errcode = 'SW002';
  end if;

  perform 1 from public.vendors v
   where v.id = p_vendor_id and v.auth_user_id = p_actor_user_id and v.is_active;
  if not found then
    raise exception 'SIKA_VENDOR_FORBIDDEN' using errcode = 'SW001';
  end if;

  -- Only for a customer this vendor actually deals with. A vendor vouching for
  -- a stranger is not vouching for anything.
  perform 1 from public.ledger_entries e
   where e.vendor_id = p_vendor_id and e.customer_id = p_customer_id;
  if not found then
    raise exception 'SIKA_NO_RELATIONSHIP' using errcode = 'SW001';
  end if;

  -- Rate limit per vendor. A vendor resetting customers all day is the abuse
  -- case, so it is capped rather than merely reported.
  select count(*)::integer into v_recent
  from public.pin_resets
  where requested_by_vendor_id = p_vendor_id
    and created_at > now() - interval '24 hours';

  if v_recent >= 5 then
    raise exception 'SIKA_RESET_RATE_LIMITED'
      using errcode = 'SW015',
            detail = format('%s resets in 24h', v_recent);
  end if;

  -- Re-requesting returns the open one rather than stacking claims.
  select * into v_ouvert
  from public.pin_resets
  where target_customer_id = p_customer_id
    and consumed_at is null
    and expires_at > now()
  order by created_at desc
  limit 1;

  if found then
    return v_ouvert;
  end if;

  insert into public.pin_resets (
    target_role, target_customer_id, requested_by_vendor_id, reason, expires_at
  ) values (
    'customer', p_customer_id, p_vendor_id, p_reason,
    now() + public.pin_reset_window()
  )
  returning * into v_row;

  return v_row;
end
$fn$;

revoke all on function public.request_customer_pin_reset(uuid, uuid, uuid, text)
  from public, anon;
grant execute on function public.request_customer_pin_reset(uuid, uuid, uuid, text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- Is there an open claim for this phone?
--
-- Called by the reset Edge Function from a LOGGED-OUT device: the whole point
-- is that the person cannot sign in. Withheld from every client role so the
-- only way to ask is through the function, which rate limits and logs.
-- ---------------------------------------------------------------------------
create or replace function public.open_pin_reset_for_phone(p_phone text)
  returns table (
    reset_id      uuid,
    target_role   text,
    auth_user_id  uuid,
    vouched_by    text,
    expires_at    timestamptz
  )
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select r.id, r.target_role, c.auth_user_id, v.business_name, r.expires_at
  from public.pin_resets r
  join public.customers c on c.id = r.target_customer_id
  left join public.vendors v on v.id = r.requested_by_vendor_id
  where r.target_role = 'customer'
    and c.phone = p_phone
    and r.consumed_at is null
    and r.expires_at > now()

  union all

  select r.id, r.target_role, v2.auth_user_id, null::text, r.expires_at
  from public.pin_resets r
  join public.vendors v2 on v2.id = r.target_vendor_id
  where r.target_role = 'vendor'
    and v2.phone = p_phone
    and r.consumed_at is null
    and r.expires_at > now()

  order by 5 desc
  limit 1
$$;

revoke all on function public.open_pin_reset_for_phone(text)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Mark a claim used. Called by the Edge Function AFTER the new PIN is written.
-- ---------------------------------------------------------------------------
create or replace function public.consume_pin_reset(
  p_reset_id uuid,
  p_ip       inet default null
)
  returns public.pin_resets
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $fn$
declare
  v_row public.pin_resets;
begin
  update public.pin_resets
     set consumed_at = now(), consumed_ip = p_ip
   where id = p_reset_id
     and consumed_at is null
     and expires_at > now()
  returning * into v_row;

  if not found then
    -- Expired or already used. Single-use is the point, so this is a refusal
    -- rather than something to smooth over.
    raise exception 'SIKA_RESET_NOT_CLAIMABLE' using errcode = 'SW016';
  end if;

  -- A reset means somebody else arranged access to this account, so the holder
  -- must choose their own code before the account is trusted again.
  if v_row.target_role = 'customer' then
    update public.customers set pin_change_required = true
     where id = v_row.target_customer_id;
  end if;

  return v_row;
end
$fn$;

revoke all on function public.consume_pin_reset(uuid, inet)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The cooling-off, enforced where it matters: proposing a debit.
--
-- Added to create_pending_debit rather than left as advice, because a rule that
-- lives only in a comment is not a rule.
-- ---------------------------------------------------------------------------
create or replace function public.vendor_barred_until(
  p_vendor_id   uuid,
  p_customer_id uuid
)
  returns timestamptz
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select max(r.consumed_at) + public.pin_reset_cooloff()
  from public.pin_resets r
  where r.target_customer_id = p_customer_id
    and r.requested_by_vendor_id = p_vendor_id
    and r.consumed_at is not null
    and r.consumed_at > now() - public.pin_reset_cooloff()
$$;

grant execute on function public.vendor_barred_until(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- The customer's own view: resets performed on their account.
-- ---------------------------------------------------------------------------
create or replace function public.my_pin_resets(p_actor_user_id uuid)
  returns table (
    id           uuid,
    vouched_by   text,
    created_at   timestamptz,
    consumed_at  timestamptz
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
  select r.id, v.business_name, r.created_at, r.consumed_at
  from public.pin_resets r
  left join public.vendors v on v.id = r.requested_by_vendor_id
  where r.target_customer_id = v_customer_id
  order by r.created_at desc
  limit 50;
end
$fn$;

revoke all on function public.my_pin_resets(uuid) from public, anon;
grant execute on function public.my_pin_resets(uuid) to authenticated;
