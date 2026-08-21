-- 0013 — Vendor self-correction window.
--
-- THE GAP THIS CLOSES. A vendor who typed 5000 F instead of 500 F had created a
-- debt they could not undo. Reversing a credit is a debit, and amendment D
-- requires customer confirmation on every debit — so the correction depended on
-- the very person who benefits from the mistake. An absent or dishonest customer
-- simply never confirms and the vendor is out 4500 F they never received.
--
-- THE TENSION. Letting a vendor reverse unilaterally without limit destroys the
-- product: they could hand over change, record it, then erase it. So the power
-- has to exist and has to be narrow.
--
-- THE SHAPE. A vendor may reverse THEIR OWN entry, without the customer, only
-- while all of these hold:
--
--   * the original entry is less than 15 minutes old — the customer is still at
--     the stall, which is when a till error is actually noticed;
--   * the full amount is still present in the balance. The existing
--     insufficient-balance guard enforces this for free: if the customer has
--     already spent any of it, the exact-amount reversal is refused. A vendor
--     therefore cannot claw back change that has already bought something;
--   * it is a reversal, never an ordinary purchase;
--   * and it is recorded as confirmation_method = 'vendor_correction', so it is
--     permanently distinguishable from a debit the customer authorised.
--
-- Rule 3 is untouched: nothing is edited or deleted, the correction is a new
-- entry, and both remain visible in the customer's history forever.

-- ---------------------------------------------------------------------------
-- Widen confirmation_method and relax the confirmation constraint for it.
-- ---------------------------------------------------------------------------

alter table public.ledger_entries
  drop constraint if exists ledger_entries_confirmation_method_valid;

alter table public.ledger_entries
  add constraint ledger_entries_confirmation_method_valid
  check (confirmation_method in ('own_device', 'vendor_device', 'vendor_correction'));

-- The original constraint demanded customer_confirmed_at on every debit. A
-- vendor correction has no customer confirmation — that is the point — so the
-- column must be null for it. Keeping it NOT NULL would have forced a lie into
-- the ledger: a timestamp claiming the customer confirmed something they never
-- saw.
alter table public.ledger_entries
  drop constraint if exists ledger_entries_debit_confirmed;

alter table public.ledger_entries
  add constraint ledger_entries_debit_confirmed
  check (
    (direction = 'credit' and customer_confirmed_at is null)
    or (direction = 'debit'
        and confirmation_method = 'vendor_correction'
        and customer_confirmed_at is null)
    or (direction = 'debit'
        and confirmation_method in ('own_device', 'vendor_device')
        and customer_confirmed_at is not null)
  );

-- A vendor correction may ONLY ever be a reversal. Without this, the value
-- would be a general-purpose way to record an unconfirmed purchase.
alter table public.ledger_entries
  drop constraint if exists ledger_entries_correction_only_reversal;

alter table public.ledger_entries
  add constraint ledger_entries_correction_only_reversal
  check (confirmation_method <> 'vendor_correction' or kind = 'reversal');

create index if not exists ledger_entries_vendor_correction_idx
  on public.ledger_entries (vendor_id, created_at desc)
  where confirmation_method = 'vendor_correction';

-- ---------------------------------------------------------------------------
-- How long a vendor has to notice.
--
-- Exposed as a function rather than inlined so the vendor app can show a
-- countdown, and so changing it is one edit in one place.
-- ---------------------------------------------------------------------------
create or replace function public.vendor_correction_window()
  returns interval
  language sql
  immutable
as $$
  select interval '15 minutes'
$$;

grant execute on function public.vendor_correction_window() to authenticated;

-- ---------------------------------------------------------------------------
-- Replace post_ledger_entry. Signature is unchanged, so this replaces rather
-- than overloads — no second callable path appears.
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
  v_caller       uuid;
  v_max          integer;
  v_balance      integer;
  v_existing     public.ledger_entries;
  v_reversed     public.ledger_entries;
  v_new          public.ledger_entries;
  v_confirmed_at timestamptz;
  v_method       text;
  v_pin_stale    boolean;
  v_is_correction boolean;
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

  v_is_correction := (p_direction = 'debit' and p_confirmation_method = 'vendor_correction');

  ---------------------------------------------------------------------------
  -- 3. Confirmation, with provenance.
  ---------------------------------------------------------------------------
  if p_direction = 'debit' then
    if v_is_correction then
      -- A vendor correction is authorised by the vendor alone, so it must be a
      -- reversal and must not claim customer confirmation.
      if p_kind <> 'reversal' then
        raise exception 'SIKA_CORRECTION_MUST_BE_REVERSAL' using errcode = 'SW007';
      end if;
      if p_customer_confirmed is true then
        raise exception 'SIKA_CORRECTION_NOT_CUSTOMER_CONFIRMED' using errcode = 'SW007';
      end if;
      v_method       := 'vendor_correction';
      v_confirmed_at := null;
    else
      if p_customer_confirmed is not true then
        raise exception 'SIKA_CUSTOMER_CONFIRMATION_REQUIRED' using errcode = 'SW004';
      end if;

      if p_confirmation_method is null
         or p_confirmation_method not in ('own_device','vendor_device') then
        raise exception 'SIKA_INVALID_CONFIRMATION_METHOD' using errcode = 'SW007';
      end if;

      v_method       := p_confirmation_method;
      v_confirmed_at := now();

      -- Stale-PIN gate. Never applies to refunds (the escape valve that keeps
      -- the credit a plain commercial debt), nor to vendor_device entries,
      -- whose holders have no own-device login at which to clear the flag.
      if v_pin_stale and v_method = 'own_device' and p_kind = 'purchase' then
        raise exception 'SIKA_PIN_CHANGE_REQUIRED' using errcode = 'SW010';
      end if;
    end if;
  else
    if p_customer_confirmed is true then
      raise exception 'SIKA_CONFIRMATION_NOT_APPLICABLE' using errcode = 'SW007';
    end if;
    if p_confirmation_method = 'vendor_correction' then
      -- Reversing a debit already needs no confirmation: it returns money to
      -- the customer. Labelling it a correction would be noise in the history.
      raise exception 'SIKA_CORRECTION_IS_DEBIT_ONLY' using errcode = 'SW007';
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
  -- 5. Idempotent replay.
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

    -- The window. Measured from the ORIGINAL entry, not from now, and only for
    -- the unilateral path — a customer-confirmed reversal has no time limit
    -- because the customer agreed to it.
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
  --
  -- For a correction this is the real protection, not a formality: the
  -- exact-amount rule plus this check together mean a vendor can only undo
  -- change the customer has not touched. Spend one franc of it and the
  -- correction is refused.
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
  -- 10. A vendor_device debit means the vendor has seen the PIN.
  --     A vendor_correction involves no PIN at all, so it does not apply.
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

-- ---------------------------------------------------------------------------
-- What a vendor can still correct, for the vendor app to render.
--
-- Answers "which of my recent entries can I still undo, and for how long" so
-- the shopkeeper sees a countdown rather than discovering the limit by being
-- refused. RLS applies through security_invoker, so a vendor sees only theirs.
-- ---------------------------------------------------------------------------
create or replace view public.v_correctable_entries
  with (security_invoker = true)
as
select
  e.id,
  e.vendor_id,
  e.customer_id,
  e.direction,
  e.kind,
  e.amount_cfa,
  e.created_at,
  e.created_at + public.vendor_correction_window() as correctable_until,
  greatest(
    0,
    ceil(extract(epoch from (
      e.created_at + public.vendor_correction_window() - now()
    )))::integer
  ) as seconds_left
from public.ledger_entries e
where e.kind <> 'reversal'
  -- Nothing already reversed can be reversed again.
  and not exists (
    select 1 from public.ledger_entries r where r.reverses_entry_id = e.id
  )
  and e.created_at >= now() - public.vendor_correction_window();

grant select on public.v_correctable_entries to authenticated;

-- Count corrections alongside the other confirmation methods, so a vendor
-- correcting constantly is as visible as one harvesting PINs.
--
-- DROP first: create-or-replace can only append columns to a view, and
-- vendor_corrections belongs beside the other counts rather than tacked on the
-- end. Nothing depends on this view, so dropping is safe and keeps the column
-- order readable.
drop view if exists public.v_vendor_confirmation_mix;

create view public.v_vendor_confirmation_mix
  with (security_invoker = true)
as
select
  vendor_id,
  count(*)                                                          as debits,
  count(*) filter (where confirmation_method = 'vendor_device')      as vendor_device_debits,
  count(*) filter (where confirmation_method = 'own_device')         as own_device_debits,
  count(*) filter (where confirmation_method = 'vendor_correction')  as vendor_corrections,
  round(
    100.0 * count(*) filter (where confirmation_method = 'vendor_device')
    / nullif(count(*), 0), 1
  )                                                                 as vendor_device_pct,
  count(distinct customer_id) filter (where confirmation_method = 'vendor_device')
                                                                    as customers_affected,
  max(created_at) filter (where confirmation_method = 'vendor_device')
                                                                    as last_vendor_device_at
from public.ledger_entries
where direction = 'debit'
group by vendor_id;

grant select on public.v_vendor_confirmation_mix to authenticated;
