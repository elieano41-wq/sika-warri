-- 0019 — Admins, vendor resets, and enforcing the cooling-off.

-- ---------------------------------------------------------------------------
-- Admins.
--
-- A table, not a column on vendors: an admin is not a kind of vendor, and an
-- admin may not have a shop at all. Checked server-side wherever it matters —
-- never a hidden URL, never a client-side flag.
-- ---------------------------------------------------------------------------
create table if not exists public.app_admins (
  auth_user_id uuid primary key,
  note         text,
  created_at   timestamptz not null default now()
);

alter table public.app_admins enable row level security;
-- No client role may read or write this. An authenticated caller that could
-- read it learns who to attack; one that could write it grants itself the keys.
revoke all on public.app_admins from anon, authenticated;

create or replace function public.is_admin(p_auth_user_id uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.app_admins a where a.auth_user_id = p_auth_user_id
  )
$$;

-- Withheld from clients. Admin checks belong in definer functions that the
-- Edge Function calls, so a client cannot ask "am I an admin" and branch on it.
revoke all on function public.is_admin(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- An admin resets a vendor's PIN.
--
-- Deliberately not self-service. A compromised vendor account can write off
-- every balance the shop holds, so this happens after a conversation.
-- ---------------------------------------------------------------------------
create or replace function public.admin_request_vendor_pin_reset(
  p_vendor_id     uuid,
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
begin
  if p_actor_user_id is null then
    raise exception 'SIKA_ACTOR_REQUIRED' using errcode = 'SW003';
  end if;

  v_caller := public.app_current_user_id();
  if v_caller is not null and v_caller <> p_actor_user_id then
    raise exception 'SIKA_ACTOR_MISMATCH' using errcode = 'SW002';
  end if;

  if not public.is_admin(p_actor_user_id) then
    -- Same code as any other forbidden operation: an attacker learns nothing
    -- about whether the admin path exists.
    raise exception 'SIKA_ADMIN_ONLY' using errcode = 'SW001';
  end if;

  perform 1 from public.vendors v where v.id = p_vendor_id;
  if not found then
    raise exception 'SIKA_VENDOR_NOT_FOUND' using errcode = 'SW008';
  end if;

  select * into v_ouvert
  from public.pin_resets
  where target_vendor_id = p_vendor_id
    and consumed_at is null
    and expires_at > now()
  order by created_at desc
  limit 1;

  if found then
    return v_ouvert;
  end if;

  insert into public.pin_resets (
    target_role, target_vendor_id, requested_by_admin_id, reason, expires_at
  ) values (
    'vendor', p_vendor_id, p_actor_user_id, p_reason,
    now() + public.pin_reset_window()
  )
  returning * into v_row;

  return v_row;
end
$fn$;

revoke all on function public.admin_request_vendor_pin_reset(uuid, uuid, text)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Enforce the cooling-off at the point a debit is proposed.
--
-- A rule that lives only in a comment is not a rule. This is the one place a
-- vendor-initiated debit begins, so it is where the bar belongs.
-- ---------------------------------------------------------------------------
create or replace function public.create_pending_debit(
  p_vendor_id         uuid,
  p_customer_id       uuid,
  p_kind              text,
  p_amount_cfa        integer,
  p_idempotency_key   text,
  p_actor_user_id     uuid,
  p_reverses_entry_id uuid default null
)
  returns public.pending_debits
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $fn$
declare
  v_caller   uuid;
  v_balance  integer;
  v_existing public.pending_debits;
  v_target   public.ledger_entries;
  v_row      public.pending_debits;
  v_barre    timestamptz;
begin
  if p_actor_user_id is null then
    raise exception 'SIKA_ACTOR_REQUIRED' using errcode = 'SW003';
  end if;

  v_caller := public.app_current_user_id();
  if v_caller is not null and v_caller <> p_actor_user_id then
    raise exception 'SIKA_ACTOR_MISMATCH' using errcode = 'SW002';
  end if;

  perform 1 from public.vendors v
   where v.id = p_vendor_id
     and v.auth_user_id = p_actor_user_id
     and v.is_active;
  if not found then
    raise exception 'SIKA_VENDOR_FORBIDDEN' using errcode = 'SW001';
  end if;

  -----------------------------------------------------------------------------
  -- The cooling-off. A vendor who vouched for a PIN reset on this customer
  -- cannot spend that customer's change immediately afterwards.
  --
  -- This closes the fast version of the attack: request a reset, claim it on
  -- your own phone, drain the balance before anyone notices. It does NOT stop a
  -- patient attacker who waits an hour, and is not presented as if it does.
  -----------------------------------------------------------------------------
  v_barre := public.vendor_barred_until(p_vendor_id, p_customer_id);
  if v_barre is not null and v_barre > now() then
    raise exception 'SIKA_RESET_COOLOFF'
      using errcode = 'SW017',
            detail = format('barred_until=%s', v_barre);
  end if;

  if p_kind not in ('purchase','refund','reversal') then
    raise exception 'SIKA_INVALID_KIND' using errcode = 'SW007';
  end if;

  if p_amount_cfa is null or p_amount_cfa <= 0 then
    raise exception 'SIKA_INVALID_AMOUNT' using errcode = 'SW007';
  end if;

  if p_idempotency_key is null or length(btrim(p_idempotency_key)) = 0 then
    raise exception 'SIKA_IDEMPOTENCY_KEY_REQUIRED' using errcode = 'SW007';
  end if;

  if p_kind = 'reversal' then
    if p_reverses_entry_id is null then
      raise exception 'SIKA_REVERSAL_TARGET_REQUIRED' using errcode = 'SW007';
    end if;

    select * into v_target
    from public.ledger_entries
    where id = p_reverses_entry_id
      and vendor_id = p_vendor_id
      and customer_id = p_customer_id;

    if not found then
      raise exception 'SIKA_REVERSAL_TARGET_INVALID' using errcode = 'SW008';
    end if;

    if v_target.kind = 'reversal' then
      raise exception 'SIKA_CANNOT_REVERSE_A_REVERSAL' using errcode = 'SW008';
    end if;

    if v_target.direction <> 'credit' then
      raise exception 'SIKA_ONLY_CREDIT_REVERSAL_NEEDS_CONSENT' using errcode = 'SW007';
    end if;

    if v_target.amount_cfa <> p_amount_cfa then
      raise exception 'SIKA_REVERSAL_AMOUNT_MISMATCH' using errcode = 'SW008';
    end if;
  elsif p_reverses_entry_id is not null then
    raise exception 'SIKA_ONLY_REVERSAL_MAY_REFERENCE' using errcode = 'SW007';
  end if;

  select * into v_existing
  from public.pending_debits
  where vendor_id = p_vendor_id and idempotency_key = p_idempotency_key;
  if found then
    return v_existing;
  end if;

  perform 1 from public.customers c where c.id = p_customer_id;
  if not found then
    raise exception 'SIKA_CUSTOMER_NOT_FOUND' using errcode = 'SW008';
  end if;

  select coalesce(
           sum(case when direction = 'credit' then amount_cfa else -amount_cfa end), 0
         )::integer
    into v_balance
  from public.ledger_entries
  where vendor_id = p_vendor_id and customer_id = p_customer_id;

  if p_amount_cfa > v_balance then
    raise exception 'SIKA_INSUFFICIENT_BALANCE'
      using errcode = 'SW006',
            detail = format('balance=%s amount=%s', v_balance, p_amount_cfa);
  end if;

  insert into public.pending_debits (
    vendor_id, customer_id, kind, amount_cfa, idempotency_key,
    created_by, expires_at, reverses_entry_id
  ) values (
    p_vendor_id, p_customer_id, p_kind, p_amount_cfa, p_idempotency_key,
    p_actor_user_id, now() + interval '180 seconds', p_reverses_entry_id
  )
  returning * into v_row;

  return v_row;
end
$fn$;

revoke all on function public.create_pending_debit(uuid, uuid, text, integer, text, uuid, uuid)
  from public, anon;
grant execute on function public.create_pending_debit(uuid, uuid, text, integer, text, uuid, uuid)
  to authenticated;
