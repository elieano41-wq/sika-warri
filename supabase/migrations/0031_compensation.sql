-- 0031 — Compenser: offsetting change against debt, once, explicitly, on the
--        customer's own device.
--
-- ============================================================================
-- THE TWO REGISTERS ARE NEVER NETTED. This file is the only exception, and it is
-- not an exception to the rule so much as the rule's escape valve.
-- ============================================================================
--
-- 500 F of change and 2 000 F of debt must never collapse into −1 500 F. That
-- figure would recreate the negative balance standing rule 2 forbids, and it
-- would state something false: the customer holds 500 F at that shop AND owes
-- 2 000 F there. Two facts, two registers, both true.
--
-- What a customer may do is ASK for one to pay down the other. That is a
-- transaction, not a display choice, and it has all the properties of one:
--
--   * proposed by the vendor, confirmed by the CUSTOMER on their OWN device
--   * bounded by both balances — it cannot overdraw the change or overpay the
--     debt
--   * written as a PAIR, in one transaction, with a compensations row whose two
--     foreign keys are NOT NULL and UNIQUE, so one leg cannot exist without the
--     other and neither can be reused
--   * visible in both histories, as 'compensation' in each
--
-- There is no automatic offsetting anywhere in this schema. Nothing reconciles
-- on a timer, nothing nets at read time, and no view returns a signed figure
-- spanning both tables.

-- ---------------------------------------------------------------------------
-- Propose
-- ---------------------------------------------------------------------------
create or replace function public.create_pending_compensation(
  p_vendor_id       uuid,
  p_customer_id     uuid,
  p_amount_cfa      integer,
  p_idempotency_key text,
  p_actor_user_id   uuid
)
  returns public.pending_compensations
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $fn$
declare
  v_caller   uuid;
  v_vendor   public.vendors;
  v_customer public.customers;
  v_monnaie  integer;
  v_dette    integer;
  v_existant public.pending_compensations;
  v_ligne    public.pending_compensations;
begin
  if p_actor_user_id is null then
    raise exception 'SIKA_ACTOR_REQUIRED' using errcode = 'SW003';
  end if;
  if p_amount_cfa is null or p_amount_cfa <= 0 then
    raise exception 'SIKA_AMOUNT_INVALID' using errcode = 'SW007';
  end if;

  v_caller := public.app_current_user_id();
  if v_caller is not null and v_caller <> p_actor_user_id then
    raise exception 'SIKA_ACTOR_MISMATCH' using errcode = 'SW002';
  end if;

  select * into v_vendor from public.vendors
   where id = p_vendor_id and auth_user_id = p_actor_user_id;
  if not found then
    raise exception 'SIKA_VENDOR_FORBIDDEN' using errcode = 'SW001';
  end if;

  select * into v_customer from public.customers where id = p_customer_id;
  if not found then
    raise exception 'SIKA_CUSTOMER_NOT_FOUND' using errcode = 'SW008';
  end if;
  -- No device, no confirmation, no compensation. An unregistered customer's
  -- change sits and their debt stands until they register — recorded in README
  -- as a real limitation rather than worked around with a vendor-side approval.
  if v_customer.auth_user_id is null then
    raise exception 'SIKA_CUSTOMER_NOT_REGISTERED' using errcode = 'SW008';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(p_vendor_id::text || ':' || p_customer_id::text, 0)
  );

  select * into v_existant from public.pending_compensations
   where vendor_id = p_vendor_id and idempotency_key = p_idempotency_key;
  if found then
    return v_existant;
  end if;

  -- Both balances, read separately and never combined into one number.
  select coalesce(sum(case when e.direction = 'credit'
                           then e.amount_cfa else -e.amount_cfa end), 0)::integer
    into v_monnaie
  from public.ledger_entries e
  where e.vendor_id = p_vendor_id and e.customer_id = p_customer_id;

  select coalesce(sum(case when d.direction = 'owed'
                           then d.amount_cfa else -d.amount_cfa end), 0)::integer
    into v_dette
  from public.debt_entries d
  where d.vendor_id = p_vendor_id and d.customer_id = p_customer_id;

  if v_monnaie <= 0 or v_dette <= 0 then
    raise exception 'SIKA_NOTHING_TO_COMPENSATE'
      using errcode = 'SW026',
            detail = format('monnaie=%s dette=%s', v_monnaie, v_dette);
  end if;

  -- Bounded by BOTH. Overdrawing the change would break rule 2 on the ledger
  -- side; overpaying the debt would break it on this side.
  if p_amount_cfa > least(v_monnaie, v_dette) then
    raise exception 'SIKA_COMPENSATION_TOO_LARGE'
      using errcode = 'SW028',
            detail = format('monnaie=%s dette=%s demandé=%s',
                            v_monnaie, v_dette, p_amount_cfa);
  end if;

  update public.pending_compensations
     set cancelled_at = now()
   where vendor_id = p_vendor_id
     and customer_id = p_customer_id
     and consumed_at is null
     and cancelled_at is null
     and expires_at <= now();

  insert into public.pending_compensations (
    vendor_id, customer_id, amount_cfa, idempotency_key, created_by, expires_at
  ) values (
    p_vendor_id, p_customer_id, p_amount_cfa, p_idempotency_key,
    p_actor_user_id, now() + interval '180 seconds'
  )
  returning * into v_ligne;

  return v_ligne;
end
$fn$;

revoke all on function public.create_pending_compensation(uuid, uuid, integer, text, uuid)
  from public, anon;
grant execute on function public.create_pending_compensation(uuid, uuid, integer, text, uuid)
  to authenticated;

-- ---------------------------------------------------------------------------
-- Confirm — the paired write
--
-- Service role only, reached from the Edge Function that has just verified the
-- customer's PIN. One transaction: a ledger debit, a debt repayment, and the row
-- that ties them together. If any part fails, none of it happened.
-- ---------------------------------------------------------------------------
create or replace function public.confirm_pending_compensation(
  p_pending_id    uuid,
  p_actor_user_id uuid
)
  returns public.compensations
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $fn$
declare
  v_caller   uuid;
  v_pending  public.pending_compensations;
  v_customer public.customers;
  v_ledger   public.ledger_entries;
  v_dette    public.debt_entries;
  v_ligne    public.compensations;
begin
  if p_actor_user_id is null then
    raise exception 'SIKA_ACTOR_REQUIRED' using errcode = 'SW003';
  end if;

  v_caller := public.app_current_user_id();
  if v_caller is not null then
    raise exception 'SIKA_DEBT_CONFIRMATION_REQUIRES_FUNCTION' using errcode = 'SW027';
  end if;

  select * into v_pending from public.pending_compensations where id = p_pending_id;
  if not found then
    raise exception 'SIKA_PENDING_NOT_FOUND' using errcode = 'SW008';
  end if;

  if v_pending.consumed_at is not null then
    -- Idempotent: return the pair that already exists rather than writing a
    -- second one.
    select * into v_ligne from public.compensations
     where vendor_id = v_pending.vendor_id
       and customer_id = v_pending.customer_id
       and created_at >= v_pending.consumed_at
     order by created_at limit 1;
    return v_ligne;
  end if;
  if v_pending.cancelled_at is not null then
    raise exception 'SIKA_PENDING_CANCELLED' using errcode = 'SW008';
  end if;
  if v_pending.expires_at <= now() then
    raise exception 'SIKA_PENDING_EXPIRED' using errcode = 'SW015';
  end if;

  select * into v_customer from public.customers where id = v_pending.customer_id;
  if not found or v_customer.auth_user_id is null
     or v_customer.auth_user_id <> p_actor_user_id then
    raise exception 'SIKA_NOT_YOUR_REQUEST' using errcode = 'SW001';
  end if;

  -- Leg one: the change side. A debit, confirmed, so post_ledger_entry applies
  -- its own balance guard — this cannot overdraw even if the proposal was stale.
  v_ledger := public.post_ledger_entry(
    v_pending.vendor_id,
    v_pending.customer_id,
    'debit',
    'compensation',
    v_pending.amount_cfa,
    'compensation-ledger:' || v_pending.id::text,
    v_pending.created_by,
    true,
    null,
    'Compensation dette',
    'own_device'
  );

  -- Leg two: the debt side. post_debt_entry applies its own guard, so this
  -- cannot overpay even if the debt moved since the proposal.
  v_dette := public.post_debt_entry(
    v_pending.vendor_id,
    v_pending.customer_id,
    'repaid',
    'compensation',
    v_pending.amount_cfa,
    'compensation-debt:' || v_pending.id::text,
    v_pending.created_by,
    'own_device',
    null,
    'Compensation monnaie'
  );

  insert into public.compensations (
    vendor_id, customer_id, amount_cfa, ledger_entry_id, debt_entry_id, confirmed_at
  ) values (
    v_pending.vendor_id, v_pending.customer_id, v_pending.amount_cfa,
    v_ledger.id, v_dette.id, now()
  )
  returning * into v_ligne;

  update public.pending_compensations
     set consumed_at = now()
   where id = v_pending.id;

  return v_ligne;
end
$fn$;

revoke all on function public.confirm_pending_compensation(uuid, uuid)
  from public, anon, authenticated;

create or replace function public.cancel_pending_compensation(
  p_pending_id    uuid,
  p_actor_user_id uuid
)
  returns void
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $fn$
declare
  v_caller  uuid;
  v_pending public.pending_compensations;
  v_permis  boolean;
begin
  if p_actor_user_id is null then
    raise exception 'SIKA_ACTOR_REQUIRED' using errcode = 'SW003';
  end if;
  v_caller := public.app_current_user_id();
  if v_caller is not null and v_caller <> p_actor_user_id then
    raise exception 'SIKA_ACTOR_MISMATCH' using errcode = 'SW002';
  end if;

  select * into v_pending from public.pending_compensations where id = p_pending_id;
  if not found then
    raise exception 'SIKA_PENDING_NOT_FOUND' using errcode = 'SW008';
  end if;

  select exists (
    select 1 from public.vendors v
     where v.id = v_pending.vendor_id and v.auth_user_id = p_actor_user_id
    union all
    select 1 from public.customers c
     where c.id = v_pending.customer_id and c.auth_user_id = p_actor_user_id
  ) into v_permis;

  if not v_permis then
    raise exception 'SIKA_NOT_YOUR_REQUEST' using errcode = 'SW001';
  end if;

  update public.pending_compensations
     set cancelled_at = now()
   where id = p_pending_id and consumed_at is null and cancelled_at is null;
end
$fn$;

revoke all on function public.cancel_pending_compensation(uuid, uuid) from public, anon;
grant execute on function public.cancel_pending_compensation(uuid, uuid) to authenticated;
