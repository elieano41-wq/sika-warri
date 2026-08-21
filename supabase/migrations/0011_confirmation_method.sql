-- 0011 — Confirmation provenance.  (Amendment I)
--
-- Amendment H moves confirmation to the customer's own device, because a PIN
-- typed on the vendor's device can be observed by the vendor and replayed to
-- debit that customer at will — which defeats amendment D entirely.
--
-- But customers without a smartphone still have to be able to spend their
-- change, and rule 9 says they must always be able to demand cash back. So the
-- vendor-device path survives as an explicitly degraded fallback, and every
-- entry records which path produced it. Recording it is what makes the weaker
-- path auditable rather than invisible.

-- ---------------------------------------------------------------------------
-- The column.
-- ---------------------------------------------------------------------------
alter table public.ledger_entries
  add column if not exists confirmation_method text;

-- Provenance backfill, one time only.
--
-- Any debit already recorded predates this column and was, by definition,
-- confirmed on the vendor's device — that was the only flow that existed. This
-- is the one UPDATE the ledger will ever see, and it annotates how an entry was
-- authorised rather than altering what it records: no amount, direction, kind
-- or party changes. Rule 3 governs financial content, and none is touched here.
-- On a fresh database this matches zero rows.
update public.ledger_entries
   set confirmation_method = 'vendor_device'
 where direction = 'debit'
   and confirmation_method is null;

do $guard$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'ledger_entries_confirmation_method_valid'
  ) then
    alter table public.ledger_entries
      add constraint ledger_entries_confirmation_method_valid
      check (confirmation_method in ('own_device', 'vendor_device'));
  end if;

  -- Mirrors the customer_confirmed_at constraint: a debit must say how it was
  -- confirmed, and a credit must not claim to have been confirmed at all.
  if not exists (
    select 1 from pg_constraint where conname = 'ledger_entries_method_matches_direction'
  ) then
    alter table public.ledger_entries
      add constraint ledger_entries_method_matches_direction
      check (
        (direction = 'debit'  and confirmation_method is not null)
        or
        (direction = 'credit' and confirmation_method is null)
      );
  end if;
end
$guard$;

create index if not exists ledger_entries_vendor_device_idx
  on public.ledger_entries (vendor_id, created_at desc)
  where confirmation_method = 'vendor_device';

-- ---------------------------------------------------------------------------
-- Customer PIN hygiene state.
-- ---------------------------------------------------------------------------
alter table public.customers
  -- Set whenever a vendor_device debit is recorded against this customer. The
  -- vendor has now seen the PIN, so it must be treated as compromised.
  add column if not exists pin_change_required boolean not null default false;

alter table public.customers
  -- Lets the app surface the vendor_device history prominently exactly once,
  -- at first own-device login, rather than nagging forever.
  add column if not exists vendor_device_notice_seen_at timestamptz;

-- ---------------------------------------------------------------------------
-- Fraud signal: each vendor's share of debits confirmed on their own device.
--
-- A vendor legitimately serving customers without smartphones shows a high
-- share. So does a vendor harvesting PINs. The number does not distinguish
-- them on its own — it tells you where to look, which is all a signal should
-- claim to do.
-- ---------------------------------------------------------------------------
create or replace view public.v_vendor_confirmation_mix
  with (security_invoker = true)
as
select
  vendor_id,
  count(*)                                                         as debits,
  count(*) filter (where confirmation_method = 'vendor_device')     as vendor_device_debits,
  count(*) filter (where confirmation_method = 'own_device')        as own_device_debits,
  round(
    100.0 * count(*) filter (where confirmation_method = 'vendor_device')
    / nullif(count(*), 0),
    1
  )                                                                as vendor_device_pct,
  count(distinct customer_id) filter (where confirmation_method = 'vendor_device')
                                                                   as customers_affected,
  max(created_at) filter (where confirmation_method = 'vendor_device')
                                                                   as last_vendor_device_at
from public.ledger_entries
where direction = 'debit'
group by vendor_id;

grant select on public.v_vendor_confirmation_mix to authenticated;

-- ---------------------------------------------------------------------------
-- Replace post_ledger_entry.
--
-- DROP first, deliberately. Adding a parameter to a function with defaults
-- creates an OVERLOAD rather than replacing it, so the previous ten-argument
-- signature would remain callable — and it accepts no confirmation_method,
-- which means it would happily write debits with the constraint unsatisfied or,
-- worse, become a quiet path around amendment I. There must be exactly one
-- write path, so the old one is removed.
-- ---------------------------------------------------------------------------
drop function if exists public.post_ledger_entry(
  uuid, uuid, text, text, integer, text, uuid, boolean, uuid, text
);

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
  -- Defaults to the SAFE value. Recording a debit as vendor_device — the
  -- weaker, observable path — requires the caller to say so explicitly. A
  -- caller that forgets the argument cannot silently produce a vendor_device
  -- entry; it produces an own_device one, which the Edge Function will only
  -- ever pass after verifying the customer's own JWT.
  p_confirmation_method text    default 'own_device'
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
  v_method       text;
  v_pin_stale    boolean;
begin
  ---------------------------------------------------------------------------
  -- 0. Input validation.
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
  -- 1. Acting user (amendment C).
  ---------------------------------------------------------------------------
  if p_actor_user_id is null then
    raise exception 'SIKA_ACTOR_REQUIRED' using errcode = 'SW003';
  end if;

  v_caller := public.app_current_user_id();
  if v_caller is not null and v_caller <> p_actor_user_id then
    raise exception 'SIKA_ACTOR_MISMATCH' using errcode = 'SW002';
  end if;

  ---------------------------------------------------------------------------
  -- 2. Vendor ownership.
  ---------------------------------------------------------------------------
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

  ---------------------------------------------------------------------------
  -- 3. Confirmation, with provenance (amendments D and I).
  ---------------------------------------------------------------------------
  if p_direction = 'debit' then
    if p_customer_confirmed is not true then
      raise exception 'SIKA_CUSTOMER_CONFIRMATION_REQUIRED' using errcode = 'SW004';
    end if;

    if p_confirmation_method is null
       or p_confirmation_method not in ('own_device','vendor_device') then
      raise exception 'SIKA_INVALID_CONFIRMATION_METHOD' using errcode = 'SW007';
    end if;

    v_method       := p_confirmation_method;
    v_confirmed_at := now();

    -----------------------------------------------------------------------
    -- Stale-PIN gate.
    --
    -- A customer whose PIN was typed on a vendor's device must change it at
    -- their first own-device login, before their next debit. Enforced here
    -- for own_device purchases: at that moment the customer is holding their
    -- own phone and can change the PIN immediately.
    --
    -- DELIBERATELY NOT enforced for refunds, nor for vendor_device entries.
    -- Blocking those would strand the money of exactly the phone-less
    -- customers this fallback exists to serve — they have no own-device login
    -- at which to clear the flag — and it would contradict rule 9, which says
    -- the customer can always demand cash back. Flagged for review: this is
    -- an interpretation of amendment I, not a literal reading of it.
    -----------------------------------------------------------------------
    if v_pin_stale
       and v_method = 'own_device'
       and p_kind = 'purchase' then
      raise exception 'SIKA_PIN_CHANGE_REQUIRED' using errcode = 'SW010';
    end if;
  else
    if p_customer_confirmed is true then
      raise exception 'SIKA_CONFIRMATION_NOT_APPLICABLE' using errcode = 'SW007';
    end if;
    v_method       := null;
    v_confirmed_at := null;
  end if;

  ---------------------------------------------------------------------------
  -- 4. Serialise the pair before reading the balance (amendment A).
  ---------------------------------------------------------------------------
  perform pg_advisory_xact_lock(
    hashtextextended(p_vendor_id::text || ':' || p_customer_id::text, 0)
  );

  ---------------------------------------------------------------------------
  -- 5. Idempotent replay, after the lock and before the balance guards.
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
  -- 7. Recompute the balance from the entries.
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
  -- 8. Balance guards.
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

  ---------------------------------------------------------------------------
  -- 10. A vendor_device debit means the vendor has seen this customer's PIN.
  --     Treat it as compromised from this moment.
  ---------------------------------------------------------------------------
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
