-- 0014 — Two fixes.
--
-- FIX 1: a vendor could fabricate a customer confirmation.
--
-- post_ledger_entry is granted to `authenticated` so the vendor app can record
-- credits directly. But it takes p_customer_confirmed as an argument and
-- believes it. A vendor with an ordinary session could therefore call it and
-- write a debit marked own_device with no customer anywhere near it — exactly
-- the fraud amendment D exists to prevent, and exactly the observation
-- amendment H moved to the customer's phone to make trustworthy.
--
-- The Edge Function was the INTENDED path, never an ENFORCED one. Intent is not
-- a control.
--
-- The fix distinguishes callers by whether they have a session identity at all.
-- A confirmed debit may only be written by a caller with NO session — that is,
-- service role, which in this system means an Edge Function that has just
-- verified a PIN against Supabase Auth. A vendor's own session cannot write one
-- however it phrases the request.
--
-- Still allowed from a session, because neither claims anything about a
-- customer's consent:
--   * credits, which only ever increase what the customer holds;
--   * vendor_correction reversals, which the vendor is explicitly entitled to
--     make alone inside the window (0013).
--
-- FIX 2: reversals outside the correction window had no route at all.
--
-- The 15-minute window covers a typo spotted at the stall. A vendor who
-- notices at closing time still needs a way, and the honest one is to ask the
-- customer to agree — the same two-device handshake used for a purchase. So
-- pending_debits now carries reversals.

-- ---------------------------------------------------------------------------
-- FIX 1
-- ---------------------------------------------------------------------------

create or replace function public.post_ledger_entry(
  p_vendor_id           uuid,
  p_customer_id         uuid,
  p_direction           text,
  p_kind                text,
  p_amount_cfa          integer,
  p_idempotency_key     text,
  p_actor_user_id       uuid,
  p_customer_confirmed  boolean default false,
  p_reverses_entry_id   uuid    default null,
  p_note                text    default null,
  p_confirmation_method text    default 'own_device'
)
  returns public.ledger_entries
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $fn$
declare
  v_caller        uuid;
  v_max           integer;
  v_balance       integer;
  v_existing      public.ledger_entries;
  v_reversed      public.ledger_entries;
  v_new           public.ledger_entries;
  v_confirmed_at  timestamptz;
  v_method        text;
  v_pin_stale     boolean;
  v_is_correction boolean;
begin
  if p_amount_cfa is null or p_amount_cfa <= 0 then
    raise exception 'SIKA_INVALID_AMOUNT' using errcode = 'SW007';
  end if;

  if p_direction is null or p_direction not in ('credit','debit') then
    raise exception 'SIKA_INVALID_DIRECTION' using errcode = 'SW007';
  end if;

  if p_kind is null or p_kind not in ('change','purchase','refund','reversal') then
    raise exception 'SIKA_INVALID_KIND' using errcode = 'SW007';
  end if;

  if p_idempotency_key is null or length(btrim(p_idempotency_key)) = 0 then
    raise exception 'SIKA_IDEMPOTENCY_KEY_REQUIRED' using errcode = 'SW007';
  end if;

  if p_actor_user_id is null then
    raise exception 'SIKA_ACTOR_REQUIRED' using errcode = 'SW003';
  end if;

  v_caller := public.app_current_user_id();
  if v_caller is not null and v_caller <> p_actor_user_id then
    raise exception 'SIKA_ACTOR_MISMATCH' using errcode = 'SW002';
  end if;

  select v.max_balance_per_customer into v_max
  from public.vendors v
  where v.id = p_vendor_id
    and v.auth_user_id = p_actor_user_id
    and v.is_active;

  if not found then
    raise exception 'SIKA_VENDOR_FORBIDDEN' using errcode = 'SW001';
  end if;

  select c.pin_change_required into v_pin_stale
  from public.customers c where c.id = p_customer_id;

  if not found then
    raise exception 'SIKA_CUSTOMER_NOT_FOUND' using errcode = 'SW008';
  end if;

  v_is_correction := (p_direction = 'debit' and p_confirmation_method = 'vendor_correction');

  if p_direction = 'debit' then
    if v_is_correction then
      if p_kind <> 'reversal' then
        raise exception 'SIKA_CORRECTION_MUST_BE_REVERSAL' using errcode = 'SW007';
      end if;
      if p_customer_confirmed is true then
        raise exception 'SIKA_CORRECTION_NOT_CUSTOMER_CONFIRMED' using errcode = 'SW007';
      end if;
      v_method       := 'vendor_correction';
      v_confirmed_at := null;
    else
      -----------------------------------------------------------------------
      -- FIX 1. A session-bound caller may not assert a customer confirmation.
      --
      -- v_caller is non-null exactly when the call arrives with a real user
      -- session (a vendor's app, via PostgREST). It is null for service role.
      -- A genuine confirmed debit is always written by an Edge Function that
      -- has verified a PIN, and that function runs as service role — so this
      -- refusal costs the legitimate path nothing and closes the forged one
      -- completely.
      -----------------------------------------------------------------------
      if v_caller is not null then
        raise exception 'SIKA_CONFIRMED_DEBIT_REQUIRES_FUNCTION'
          using errcode = 'SW014',
                detail = 'a confirmed debit must be posted by the confirm-debit '
                         'function, which verifies the customer PIN';
      end if;

      if p_customer_confirmed is not true then
        raise exception 'SIKA_CUSTOMER_CONFIRMATION_REQUIRED' using errcode = 'SW004';
      end if;

      if p_confirmation_method is null
         or p_confirmation_method not in ('own_device','vendor_device') then
        raise exception 'SIKA_INVALID_CONFIRMATION_METHOD' using errcode = 'SW007';
      end if;

      v_method       := p_confirmation_method;
      v_confirmed_at := now();

      if v_pin_stale and v_method = 'own_device' and p_kind = 'purchase' then
        raise exception 'SIKA_PIN_CHANGE_REQUIRED' using errcode = 'SW010';
      end if;
    end if;
  else
    if p_customer_confirmed is true then
      raise exception 'SIKA_CONFIRMATION_NOT_APPLICABLE' using errcode = 'SW007';
    end if;
    if p_confirmation_method = 'vendor_correction' then
      raise exception 'SIKA_CORRECTION_IS_DEBIT_ONLY' using errcode = 'SW007';
    end if;
    v_method       := null;
    v_confirmed_at := null;
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(p_vendor_id::text || ':' || p_customer_id::text, 0)
  );

  select * into v_existing
  from public.ledger_entries
  where vendor_id = p_vendor_id
    and idempotency_key = p_idempotency_key;

  if found then
    return v_existing;
  end if;

  if p_kind = 'reversal' then
    if p_reverses_entry_id is null then
      raise exception 'SIKA_REVERSAL_TARGET_REQUIRED' using errcode = 'SW007';
    end if;

    select * into v_reversed
    from public.ledger_entries
    where id = p_reverses_entry_id
      and vendor_id = p_vendor_id
      and customer_id = p_customer_id;

    if not found then
      raise exception 'SIKA_REVERSAL_TARGET_INVALID' using errcode = 'SW008';
    end if;

    if v_reversed.kind = 'reversal' then
      raise exception 'SIKA_CANNOT_REVERSE_A_REVERSAL' using errcode = 'SW008';
    end if;

    if v_reversed.amount_cfa <> p_amount_cfa then
      raise exception 'SIKA_REVERSAL_AMOUNT_MISMATCH' using errcode = 'SW008';
    end if;

    if v_reversed.direction = p_direction then
      raise exception 'SIKA_REVERSAL_DIRECTION_INVALID' using errcode = 'SW008';
    end if;

    if v_is_correction
       and v_reversed.created_at < now() - public.vendor_correction_window() then
      raise exception 'SIKA_CORRECTION_WINDOW_CLOSED'
        using errcode = 'SW013',
              detail = format('entry_created_at=%s window=%s',
                              v_reversed.created_at, public.vendor_correction_window());
    end if;
  elsif p_reverses_entry_id is not null then
    raise exception 'SIKA_ONLY_REVERSAL_MAY_REFERENCE' using errcode = 'SW007';
  end if;

  select coalesce(
           sum(case when direction = 'credit' then amount_cfa else -amount_cfa end),
           0
         )::integer
    into v_balance
  from public.ledger_entries
  where vendor_id = p_vendor_id
    and customer_id = p_customer_id;

  if p_direction = 'credit' then
    if v_balance + p_amount_cfa > v_max then
      raise exception 'SIKA_CAP_EXCEEDED'
        using errcode = 'SW005',
              detail  = format('balance=%s amount=%s cap=%s', v_balance, p_amount_cfa, v_max);
    end if;
  else
    if p_amount_cfa > v_balance then
      raise exception 'SIKA_INSUFFICIENT_BALANCE'
        using errcode = 'SW006',
              detail  = format('balance=%s amount=%s', v_balance, p_amount_cfa);
    end if;
  end if;

  begin
    insert into public.ledger_entries (
      vendor_id, customer_id, direction, kind, amount_cfa,
      idempotency_key, reverses_entry_id, note, customer_confirmed_at,
      confirmation_method, created_by
    ) values (
      p_vendor_id, p_customer_id, p_direction, p_kind, p_amount_cfa,
      p_idempotency_key, p_reverses_entry_id, p_note, v_confirmed_at,
      v_method, p_actor_user_id
    )
    returning * into v_new;
  exception
    when unique_violation then
      select * into v_existing
      from public.ledger_entries
      where vendor_id = p_vendor_id
        and idempotency_key = p_idempotency_key;

      if found then
        return v_existing;
      end if;
      raise;
  end;

  if v_method = 'vendor_device' then
    update public.customers
       set pin_change_required = true
     where id = p_customer_id
       and pin_change_required = false;
  end if;

  return v_new;
end
$fn$;

revoke all on function public.post_ledger_entry(
  uuid, uuid, text, text, integer, text, uuid, boolean, uuid, text, text
) from public, anon;

grant execute on function public.post_ledger_entry(
  uuid, uuid, text, text, integer, text, uuid, boolean, uuid, text, text
) to authenticated;

-- ---------------------------------------------------------------------------
-- FIX 2 — reversals through the two-device handshake.
-- ---------------------------------------------------------------------------

alter table public.pending_debits
  add column if not exists reverses_entry_id uuid references public.ledger_entries(id);

alter table public.pending_debits
  drop constraint if exists pending_debits_kind_check;

alter table public.pending_debits
  add constraint pending_debits_kind_check
  check (kind in ('purchase','refund','reversal'));

alter table public.pending_debits
  drop constraint if exists pending_debits_reversal_consistent;

alter table public.pending_debits
  add constraint pending_debits_reversal_consistent
  check ((kind = 'reversal') = (reverses_entry_id is not null));

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

  if p_kind not in ('purchase','refund','reversal') then
    raise exception 'SIKA_INVALID_KIND' using errcode = 'SW007';
  end if;

  if p_amount_cfa is null or p_amount_cfa <= 0 then
    raise exception 'SIKA_INVALID_AMOUNT' using errcode = 'SW007';
  end if;

  if p_idempotency_key is null or length(btrim(p_idempotency_key)) = 0 then
    raise exception 'SIKA_IDEMPOTENCY_KEY_REQUIRED' using errcode = 'SW007';
  end if;

  -- Validate the reversal target at PROPOSAL time, so the customer is never
  -- asked to authorise a correction that cannot be applied.
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

    -- Only a CREDIT needs the customer's agreement to reverse: that reduces
    -- what they hold. Reversing a debit hands money back and needs no
    -- handshake, so it must not be routed through one.
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

-- The six-argument form from 0012 would otherwise remain as an overload that
-- cannot express a reversal.
drop function if exists public.create_pending_debit(uuid, uuid, text, integer, text, uuid);

create or replace function public.confirm_pending_debit(
  p_pending_id             uuid,
  p_customer_actor_user_id uuid
)
  returns public.ledger_entries
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $fn$
declare
  v_caller       uuid;
  v_pending      public.pending_debits;
  v_customer_id  uuid;
  v_vendor_actor uuid;
  v_entry        public.ledger_entries;
begin
  if p_customer_actor_user_id is null then
    raise exception 'SIKA_ACTOR_REQUIRED' using errcode = 'SW003';
  end if;

  v_caller := public.app_current_user_id();
  if v_caller is not null and v_caller <> p_customer_actor_user_id then
    raise exception 'SIKA_ACTOR_MISMATCH' using errcode = 'SW002';
  end if;

  select c.id into v_customer_id
  from public.customers c where c.auth_user_id = p_customer_actor_user_id;
  if not found then
    raise exception 'SIKA_CUSTOMER_NOT_FOUND' using errcode = 'SW008';
  end if;

  select * into v_pending
  from public.pending_debits where id = p_pending_id for update;

  if not found then
    raise exception 'SIKA_PENDING_NOT_FOUND' using errcode = 'SW008';
  end if;

  if v_pending.customer_id <> v_customer_id then
    raise exception 'SIKA_PENDING_NOT_YOURS' using errcode = 'SW001';
  end if;

  if v_pending.cancelled_at is not null then
    raise exception 'SIKA_PENDING_CANCELLED' using errcode = 'SW011';
  end if;

  if v_pending.consumed_at is not null then
    select * into v_entry
    from public.ledger_entries where id = v_pending.consumed_entry_id;
    return v_entry;
  end if;

  if v_pending.expires_at <= now() then
    raise exception 'SIKA_PENDING_EXPIRED'
      using errcode = 'SW012',
            detail = format('expired_at=%s', v_pending.expires_at);
  end if;

  select v.auth_user_id into v_vendor_actor
  from public.vendors v where v.id = v_pending.vendor_id;
  if not found then
    raise exception 'SIKA_VENDOR_FORBIDDEN' using errcode = 'SW001';
  end if;

  -- Runs as the definer with no session identity, so the FIX 1 guard above
  -- does not fire: this IS the trusted path, reached only after the Edge
  -- Function verified the customer's PIN.
  v_entry := public.post_ledger_entry(
    p_vendor_id           => v_pending.vendor_id,
    p_customer_id         => v_pending.customer_id,
    p_direction           => 'debit',
    p_kind                => v_pending.kind,
    p_amount_cfa          => v_pending.amount_cfa,
    p_idempotency_key     => v_pending.idempotency_key,
    p_actor_user_id       => v_vendor_actor,
    p_customer_confirmed  => true,
    p_reverses_entry_id   => v_pending.reverses_entry_id,
    p_note                => null,
    p_confirmation_method => 'own_device'
  );

  update public.pending_debits
     set consumed_at = now(),
         consumed_entry_id = v_entry.id
   where id = v_pending.id;

  return v_entry;
end
$fn$;

revoke all on function public.confirm_pending_debit(uuid, uuid)
  from public, anon, authenticated;
