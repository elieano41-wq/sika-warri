-- 0007 — post_ledger_entry: the single write path into the ledger.
--
-- Error codes are distinct SQLSTATEs in the user-defined 'SW' class so the
-- client can show a specific French message per failure. No generic failures.
--
--   SW001 vendor forbidden            SW005 cap exceeded
--   SW002 actor mismatch              SW006 insufficient balance
--   SW003 actor required              SW007 invalid input
--   SW004 customer confirmation req.  SW008 referenced record invalid

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
  p_note                text    default null
)
  returns public.ledger_entries
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $fn$
declare
  v_caller       uuid;
  v_max          integer;
  v_balance      integer;
  v_existing     public.ledger_entries;
  v_reversed     public.ledger_entries;
  v_new          public.ledger_entries;
  v_confirmed_at timestamptz;
begin
  ---------------------------------------------------------------------------
  -- 0. Input validation. Fail loudly, name what is wrong (standing rule 6).
  ---------------------------------------------------------------------------
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

  ---------------------------------------------------------------------------
  -- 1. Establish the acting user.
  --
  -- The actor is always an explicit argument, never inferred from auth.uid()
  -- (amendment C) — the debit path reaches this function as service role,
  -- where auth.uid() is null.
  --
  -- The guard below is what stops that argument becoming an impersonation
  -- hole: whenever there IS a real session identity, the asserted actor must
  -- equal it. Only a service-role caller, which has no session identity, may
  -- assert an actor freely, and it does so having already verified the JWT.
  ---------------------------------------------------------------------------
  if p_actor_user_id is null then
    raise exception 'SIKA_ACTOR_REQUIRED' using errcode = 'SW003';
  end if;

  v_caller := public.app_current_user_id();
  if v_caller is not null and v_caller <> p_actor_user_id then
    raise exception 'SIKA_ACTOR_MISMATCH' using errcode = 'SW002';
  end if;

  ---------------------------------------------------------------------------
  -- 2. Vendor ownership, checked against the asserted actor (amendment C).
  --    Acceptance test 12: vendor A identity plus vendor B id fails here.
  ---------------------------------------------------------------------------
  select v.max_balance_per_customer into v_max
  from public.vendors v
  where v.id = p_vendor_id
    and v.auth_user_id = p_actor_user_id
    and v.is_active;

  if not found then
    raise exception 'SIKA_VENDOR_FORBIDDEN' using errcode = 'SW001';
  end if;

  perform 1 from public.customers c where c.id = p_customer_id;
  if not found then
    raise exception 'SIKA_CUSTOMER_NOT_FOUND' using errcode = 'SW008';
  end if;

  ---------------------------------------------------------------------------
  -- 3. Every debit requires the customer PIN confirmation (amendment D).
  --    This includes refunds: without it a vendor could mark a balance
  --    refunded without handing over any cash. It also includes a reversal
  --    that runs as a debit, since that too reduces what the customer holds.
  ---------------------------------------------------------------------------
  if p_direction = 'debit' then
    if p_customer_confirmed is not true then
      raise exception 'SIKA_CUSTOMER_CONFIRMATION_REQUIRED' using errcode = 'SW004';
    end if;
    v_confirmed_at := now();
  else
    if p_customer_confirmed is true then
      raise exception 'SIKA_CONFIRMATION_NOT_APPLICABLE' using errcode = 'SW007';
    end if;
    v_confirmed_at := null;
  end if;

  ---------------------------------------------------------------------------
  -- 4. Serialise this (vendor, customer) pair BEFORE reading the balance
  --    (amendment A).
  --
  --    Rule 4 forbids a stored balance, so no row exists to SELECT ... FOR
  --    UPDATE — the balance is an aggregate. A transaction-scoped advisory
  --    lock is the portable substitute and is what makes acceptance test 5
  --    hold: two concurrent debits cannot both read the same pre-debit
  --    balance. Keyed with hashtextextended for a 64-bit space.
  ---------------------------------------------------------------------------
  perform pg_advisory_xact_lock(
    hashtextextended(p_vendor_id::text || ':' || p_customer_id::text, 0)
  );

  ---------------------------------------------------------------------------
  -- 5. Idempotent replay. Checked after the lock, so a resent offline entry
  --    cannot slip past a concurrent first attempt. Returns the ORIGINAL
  --    entry untouched and writes nothing.
  --
  --    Deliberately ordered before the balance guards, unlike section 4 of
  --    the spec which lists it at step 6: a replay must stay a no-op even if
  --    the cap or the balance has since moved against it. Otherwise a queued
  --    credit that synced successfully could report a spurious cap failure on
  --    a later resend.
  ---------------------------------------------------------------------------
  select * into v_existing
  from public.ledger_entries
  where vendor_id = p_vendor_id
    and idempotency_key = p_idempotency_key;

  if found then
    return v_existing;
  end if;

  ---------------------------------------------------------------------------
  -- 6. Reversal integrity.
  ---------------------------------------------------------------------------
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
  elsif p_reverses_entry_id is not null then
    raise exception 'SIKA_ONLY_REVERSAL_MAY_REFERENCE' using errcode = 'SW007';
  end if;

  ---------------------------------------------------------------------------
  -- 7. Recompute the balance from the entries themselves (rule 4).
  ---------------------------------------------------------------------------
  select coalesce(
           sum(case when direction = 'credit' then amount_cfa else -amount_cfa end),
           0
         )::integer
    into v_balance
  from public.ledger_entries
  where vendor_id = p_vendor_id
    and customer_id = p_customer_id;

  ---------------------------------------------------------------------------
  -- 8. Balance guards. Rule 2: a balance can never go negative, because a
  --    negative balance is credit extension and a different regulatory
  --    regime entirely.
  ---------------------------------------------------------------------------
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

  ---------------------------------------------------------------------------
  -- 9. Append.
  ---------------------------------------------------------------------------
  begin
    insert into public.ledger_entries (
      vendor_id, customer_id, direction, kind, amount_cfa,
      idempotency_key, reverses_entry_id, note, customer_confirmed_at, created_by
    ) values (
      p_vendor_id, p_customer_id, p_direction, p_kind, p_amount_cfa,
      p_idempotency_key, p_reverses_entry_id, p_note, v_confirmed_at, p_actor_user_id
    )
    returning * into v_new;
  exception
    -- Two different customers of one vendor could in principle present the
    -- same idempotency key; the unique constraint is per vendor, so the
    -- per-pair advisory lock does not serialise them. Treat it as a replay.
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

  return v_new;
end
$fn$;

revoke all on function public.post_ledger_entry(
  uuid, uuid, text, text, integer, text, uuid, boolean, uuid, text
) from public, anon;

grant execute on function public.post_ledger_entry(
  uuid, uuid, text, text, integer, text, uuid, boolean, uuid, text
) to authenticated;

-- ---------------------------------------------------------------------------
-- Receipt code — DISPLAY ONLY.
--
-- Derived from the entry id rather than stored, so there is no column to
-- collide on and nothing extra to keep consistent. Four digits is a human
-- memory aid for the customer to note down; it is NOT a credential and is
-- NOT unique. Nothing accepts it as input and nothing authorises against it.
-- There is deliberately no lookup-by-receipt-code function anywhere.
-- ---------------------------------------------------------------------------
create or replace function public.entry_receipt_code(p_entry_id uuid)
  returns text
  language sql
  immutable
as $rc$
  select lpad(
    ((('x' || substr(md5(p_entry_id::text), 1, 8))::bit(32)::bigint) % 10000)::text,
    4, '0'
  )
$rc$;

grant execute on function public.entry_receipt_code(uuid) to authenticated;
