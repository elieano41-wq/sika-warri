-- 0030 — The guarded writes for the debt register.
--
-- Error codes introduced here:
--   SW019 debt ledger is append-only        SW024 not the customer's own review
--   SW020 debt cap exceeded                 SW025 already reviewed
--   SW021 debt would go negative            SW026 nothing to compensate
--   SW022 debt rate limit                   SW027 vendor may not confirm a debt
--   SW023 vendor_device forbidden           SW028 compensation exceeds a balance
--
-- ONE LOCK FOR BOTH REGISTERS. post_debt_entry takes the SAME advisory lock key
-- as post_ledger_entry — hashtextextended('<vendor>:<customer>'). Two separate
-- lock namespaces would be marginally more concurrent and would let a
-- compensation deadlock against itself by needing both. One lock per pair costs
-- nothing at this scale and makes the paired write trivially safe.

-- ---------------------------------------------------------------------------
-- post_debt_entry — every write to the debt register goes through here
-- ---------------------------------------------------------------------------
create or replace function public.post_debt_entry(
  p_vendor_id           uuid,
  p_customer_id         uuid,
  p_direction           text,
  p_kind                text,
  p_amount_cfa          integer,
  p_idempotency_key     text,
  p_actor_user_id       uuid,
  p_confirmation_method text default 'declared',
  p_reverses_entry_id   uuid default null,
  p_note                text default null
)
  returns public.debt_entries
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $fn$
declare
  v_caller     uuid;
  v_existing   public.debt_entries;
  v_reversed   public.debt_entries;
  v_vendor     public.vendors;
  v_encours    integer;
  v_recents    integer;
  v_confirme   timestamptz;
  v_ligne      public.debt_entries;
begin
  ---------------------------------------------------------------------------
  -- 1. Shape.
  ---------------------------------------------------------------------------
  if p_actor_user_id is null then
    raise exception 'SIKA_ACTOR_REQUIRED' using errcode = 'SW003';
  end if;
  if p_amount_cfa is null or p_amount_cfa <= 0 then
    raise exception 'SIKA_AMOUNT_INVALID' using errcode = 'SW007';
  end if;
  if p_direction is null or p_direction not in ('owed', 'repaid') then
    raise exception 'SIKA_DIRECTION_INVALID' using errcode = 'SW007';
  end if;
  if p_kind is null or p_kind not in
     ('debt', 'settlement', 'cancellation', 'compensation', 'reversal') then
    raise exception 'SIKA_INVALID_KIND' using errcode = 'SW007';
  end if;
  if p_idempotency_key is null or length(btrim(p_idempotency_key)) = 0 then
    raise exception 'SIKA_IDEMPOTENCY_KEY_REQUIRED' using errcode = 'SW007';
  end if;

  ---------------------------------------------------------------------------
  -- 2. vendor_device is refused BY NAME.
  --
  -- The column's check constraint already makes it unstorable, but a caller
  -- passing it deserves to be told why rather than getting a generic constraint
  -- violation. This is the single most dangerous thing anyone could ask for: a
  -- vendor typing the customer's PIN on the vendor's phone can mint a debt from
  -- nothing.
  ---------------------------------------------------------------------------
  if p_confirmation_method = 'vendor_device' then
    raise exception 'SIKA_DEBT_VENDOR_DEVICE_FORBIDDEN' using errcode = 'SW023';
  end if;
  if p_confirmation_method is null
     or p_confirmation_method not in ('own_device', 'declared') then
    raise exception 'SIKA_CONFIRMATION_METHOD_INVALID' using errcode = 'SW007';
  end if;

  ---------------------------------------------------------------------------
  -- 3. The actor is who they say they are, and owns this vendor.
  ---------------------------------------------------------------------------
  v_caller := public.app_current_user_id();
  if v_caller is not null and v_caller <> p_actor_user_id then
    raise exception 'SIKA_ACTOR_MISMATCH' using errcode = 'SW002';
  end if;

  select * into v_vendor from public.vendors
   where id = p_vendor_id and auth_user_id = p_actor_user_id;
  if not found then
    raise exception 'SIKA_VENDOR_FORBIDDEN' using errcode = 'SW001';
  end if;
  if not v_vendor.is_active then
    raise exception 'SIKA_VENDOR_INACTIVE' using errcode = 'SW001';
  end if;

  ---------------------------------------------------------------------------
  -- 4. A SESSION-BOUND CALLER MAY NOT ASSERT A CONFIRMATION.
  --
  -- The mirror of migration 0014, and more important here. A vendor holding a
  -- normal session must not be able to post a debt marked own_device: that would
  -- let them forge the customer's agreement, which is the entire fraud this
  -- design exists to prevent. Only the service role — meaning the Edge Function
  -- that has just verified a PIN against the customer's own device — may.
  ---------------------------------------------------------------------------
  if p_confirmation_method = 'own_device' and v_caller is not null then
    raise exception 'SIKA_DEBT_CONFIRMATION_REQUIRES_FUNCTION' using errcode = 'SW027';
  end if;

  ---------------------------------------------------------------------------
  -- 5. Serialise the pair before reading anything (amendment A). Same key as
  --    post_ledger_entry.
  ---------------------------------------------------------------------------
  perform pg_advisory_xact_lock(
    hashtextextended(p_vendor_id::text || ':' || p_customer_id::text, 0)
  );

  ---------------------------------------------------------------------------
  -- 6. Idempotent replay, after the lock and before the guards.
  ---------------------------------------------------------------------------
  select * into v_existing from public.debt_entries
   where vendor_id = p_vendor_id and idempotency_key = p_idempotency_key;
  if found then
    return v_existing;
  end if;

  ---------------------------------------------------------------------------
  -- 7. Reversal integrity, same rules as the ledger.
  ---------------------------------------------------------------------------
  if p_kind = 'reversal' then
    if p_reverses_entry_id is null then
      raise exception 'SIKA_REVERSAL_TARGET_REQUIRED' using errcode = 'SW007';
    end if;

    select * into v_reversed from public.debt_entries
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
    raise exception 'SIKA_REVERSAL_TARGET_NOT_APPLICABLE' using errcode = 'SW007';
  end if;

  ---------------------------------------------------------------------------
  -- 8. The outstanding debt, derived. Never stored.
  ---------------------------------------------------------------------------
  select coalesce(sum(case when d.direction = 'owed'
                           then d.amount_cfa else -d.amount_cfa end), 0)::integer
    into v_encours
  from public.debt_entries d
  where d.vendor_id = p_vendor_id and d.customer_id = p_customer_id;

  if p_direction = 'owed' then
    -- The cap. Bounds how much ONE vendor can claim against ONE customer. It
    -- does not make a fabricated debt honest and it does not stop several
    -- vendors each claiming their own maximum — see the honest-limits note in
    -- README.
    if v_encours + p_amount_cfa > v_vendor.max_debt_per_customer then
      raise exception 'SIKA_DEBT_CAP_EXCEEDED'
        using errcode = 'SW020',
              detail = format('encours=%s ajout=%s plafond=%s',
                              v_encours, p_amount_cfa, v_vendor.max_debt_per_customer);
    end if;

    -----------------------------------------------------------------------
    -- Rate limit, on the dangerous direction only.
    --
    -- Repayments and write-offs are uncapped: they favour the customer, and
    -- throttling them would be throttling the good outcome. Creating debt is
    -- throttled because a vendor bulk-loading claims against a list of phone
    -- numbers is the abuse this register makes possible.
    -----------------------------------------------------------------------
    select count(*)::integer into v_recents
    from public.debt_entries d
    where d.vendor_id = p_vendor_id
      and d.direction = 'owed'
      and d.created_at > now() - interval '1 hour';

    if v_recents >= 30 then
      raise exception 'SIKA_DEBT_RATE_LIMIT'
        using errcode = 'SW022',
              detail = format('%s dettes créées dans la dernière heure', v_recents);
    end if;
  else
    -- Rule 2, restated for this register: a debt cannot go negative. A customer
    -- who has repaid everything owes nothing; they do not owe less than nothing,
    -- and a vendor does not owe them change through this table.
    if p_amount_cfa > v_encours then
      raise exception 'SIKA_DEBT_WOULD_GO_NEGATIVE'
        using errcode = 'SW021',
              detail = format('encours=%s remboursement=%s', v_encours, p_amount_cfa);
    end if;
  end if;

  ---------------------------------------------------------------------------
  -- 9. Write.
  ---------------------------------------------------------------------------
  v_confirme := case when p_confirmation_method = 'own_device' then now() else null end;

  insert into public.debt_entries (
    vendor_id, customer_id, direction, kind, amount_cfa, idempotency_key,
    reverses_entry_id, note, confirmation_method, customer_confirmed_at, created_by
  ) values (
    p_vendor_id, p_customer_id, p_direction, p_kind, p_amount_cfa, p_idempotency_key,
    p_reverses_entry_id, p_note, p_confirmation_method, v_confirme, p_actor_user_id
  )
  returning * into v_ligne;

  return v_ligne;
exception
  when unique_violation then
    -- Two identical calls racing. The advisory lock serialises a pair, but the
    -- same key from two connections can still collide on the index. Treat it as
    -- the replay it is.
    select * into v_existing from public.debt_entries
     where vendor_id = p_vendor_id and idempotency_key = p_idempotency_key;
    if found then
      return v_existing;
    end if;
    raise;
end
$fn$;

revoke all on function public.post_debt_entry(uuid, uuid, text, text, integer, text, uuid, text, uuid, text)
  from public, anon;
grant execute on function public.post_debt_entry(uuid, uuid, text, text, integer, text, uuid, text, uuid, text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- The handshake: propose a debt
-- ---------------------------------------------------------------------------
create or replace function public.create_pending_debt(
  p_vendor_id       uuid,
  p_customer_id     uuid,
  p_amount_cfa      integer,
  p_idempotency_key text,
  p_actor_user_id   uuid,
  p_note            text default null
)
  returns public.pending_debts
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $fn$
declare
  v_caller   uuid;
  v_vendor   public.vendors;
  v_customer public.customers;
  v_encours  integer;
  v_existant public.pending_debts;
  v_ligne    public.pending_debts;
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

  -- An unregistered customer has no device to confirm on, so there is nothing
  -- to propose. That path records a DÉCLARÉE debt directly instead, and the
  -- caller is told which situation it is in rather than being left to guess.
  if v_customer.auth_user_id is null then
    raise exception 'SIKA_CUSTOMER_NOT_REGISTERED' using errcode = 'SW008';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(p_vendor_id::text || ':' || p_customer_id::text, 0)
  );

  select * into v_existant from public.pending_debts
   where vendor_id = p_vendor_id and idempotency_key = p_idempotency_key;
  if found then
    return v_existant;
  end if;

  -- Checked at proposal time as well as at confirmation, so a vendor is told
  -- the cap is reached before a customer is asked to agree to something that
  -- cannot be recorded.
  select coalesce(sum(case when d.direction = 'owed'
                           then d.amount_cfa else -d.amount_cfa end), 0)::integer
    into v_encours
  from public.debt_entries d
  where d.vendor_id = p_vendor_id and d.customer_id = p_customer_id;

  if v_encours + p_amount_cfa > v_vendor.max_debt_per_customer then
    raise exception 'SIKA_DEBT_CAP_EXCEEDED'
      using errcode = 'SW020',
            detail = format('encours=%s ajout=%s plafond=%s',
                            v_encours, p_amount_cfa, v_vendor.max_debt_per_customer);
  end if;

  -- Supersede any expired proposal for this pair, so the partial unique index
  -- does not block a fresh one after a window has lapsed.
  update public.pending_debts
     set cancelled_at = now()
   where vendor_id = p_vendor_id
     and customer_id = p_customer_id
     and consumed_at is null
     and cancelled_at is null
     and expires_at <= now();

  insert into public.pending_debts (
    vendor_id, customer_id, amount_cfa, note, idempotency_key,
    created_by, expires_at
  ) values (
    p_vendor_id, p_customer_id, p_amount_cfa, p_note, p_idempotency_key,
    p_actor_user_id, now() + interval '180 seconds'
  )
  returning * into v_ligne;

  return v_ligne;
end
$fn$;

revoke all on function public.create_pending_debt(uuid, uuid, integer, text, uuid, text)
  from public, anon;
grant execute on function public.create_pending_debt(uuid, uuid, integer, text, uuid, text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- The handshake: the customer confirms, on their own device
--
-- Service role only. Reached from the Edge Function that has just verified the
-- customer's PIN — which is what makes 'own_device' true rather than asserted.
-- ---------------------------------------------------------------------------
create or replace function public.confirm_pending_debt(
  p_pending_id    uuid,
  p_actor_user_id uuid
)
  returns public.debt_entries
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $fn$
declare
  v_caller   uuid;
  v_pending  public.pending_debts;
  v_customer public.customers;
  v_entree   public.debt_entries;
begin
  if p_actor_user_id is null then
    raise exception 'SIKA_ACTOR_REQUIRED' using errcode = 'SW003';
  end if;

  -- A session-bound caller must never reach this. If a vendor could confirm on
  -- the customer's behalf, the whole two-device design would be decoration.
  v_caller := public.app_current_user_id();
  if v_caller is not null then
    raise exception 'SIKA_DEBT_CONFIRMATION_REQUIRES_FUNCTION' using errcode = 'SW027';
  end if;

  select * into v_pending from public.pending_debts where id = p_pending_id;
  if not found then
    raise exception 'SIKA_PENDING_NOT_FOUND' using errcode = 'SW008';
  end if;

  -- Already done: return the same entry rather than creating a second debt.
  if v_pending.consumed_at is not null then
    select * into v_entree from public.debt_entries where id = v_pending.consumed_entry_id;
    return v_entree;
  end if;
  if v_pending.cancelled_at is not null then
    raise exception 'SIKA_PENDING_CANCELLED' using errcode = 'SW008';
  end if;
  if v_pending.expires_at <= now() then
    raise exception 'SIKA_PENDING_EXPIRED' using errcode = 'SW015';
  end if;

  -- The confirming user must be THE customer named on the proposal. Not any
  -- customer, and not the vendor.
  select * into v_customer from public.customers where id = v_pending.customer_id;
  if not found or v_customer.auth_user_id is null
     or v_customer.auth_user_id <> p_actor_user_id then
    raise exception 'SIKA_NOT_YOUR_REQUEST' using errcode = 'SW001';
  end if;

  -- Posted as the VENDOR's entry — they are the creditor — but marked
  -- own_device, which only this path can do.
  v_entree := public.post_debt_entry(
    v_pending.vendor_id,
    v_pending.customer_id,
    'owed',
    'debt',
    v_pending.amount_cfa,
    'pending-debt:' || v_pending.id::text,
    v_pending.created_by,
    'own_device',
    null,
    v_pending.note
  );

  update public.pending_debts
     set consumed_at = now(), consumed_entry_id = v_entree.id
   where id = v_pending.id;

  return v_entree;
end
$fn$;

revoke all on function public.confirm_pending_debt(uuid, uuid)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Cancel a proposal (either party, before it is confirmed)
-- ---------------------------------------------------------------------------
create or replace function public.cancel_pending_debt(
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
  v_pending public.pending_debts;
  v_permis  boolean;
begin
  if p_actor_user_id is null then
    raise exception 'SIKA_ACTOR_REQUIRED' using errcode = 'SW003';
  end if;
  v_caller := public.app_current_user_id();
  if v_caller is not null and v_caller <> p_actor_user_id then
    raise exception 'SIKA_ACTOR_MISMATCH' using errcode = 'SW002';
  end if;

  select * into v_pending from public.pending_debts where id = p_pending_id;
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

  update public.pending_debts
     set cancelled_at = now()
   where id = p_pending_id and consumed_at is null and cancelled_at is null;
end
$fn$;

revoke all on function public.cancel_pending_debt(uuid, uuid) from public, anon;
grant execute on function public.cancel_pending_debt(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Record a DÉCLARÉE debt directly
--
-- The unregistered-customer path, and the "customer is not here" path. No
-- confirmation, so the entry is a CLAIM, not a record — and every read view
-- labels it as one.
-- ---------------------------------------------------------------------------
create or replace function public.declare_debt(
  p_vendor_id       uuid,
  p_customer_id     uuid,
  p_amount_cfa      integer,
  p_idempotency_key text,
  p_actor_user_id   uuid,
  p_note            text default null
)
  returns public.debt_entries
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $fn$
begin
  -- Deliberately thin: all the guarding is in post_debt_entry, and this exists
  -- so the API surface says out loud which of the two paths is being taken.
  return public.post_debt_entry(
    p_vendor_id, p_customer_id, 'owed', 'debt', p_amount_cfa,
    p_idempotency_key, p_actor_user_id, 'declared', null, p_note
  );
end
$fn$;

revoke all on function public.declare_debt(uuid, uuid, integer, text, uuid, text)
  from public, anon;
grant execute on function public.declare_debt(uuid, uuid, integer, text, uuid, text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- Settle, write off, reverse
-- ---------------------------------------------------------------------------
create or replace function public.settle_debt(
  p_vendor_id       uuid,
  p_customer_id     uuid,
  p_amount_cfa      integer,
  p_idempotency_key text,
  p_actor_user_id   uuid,
  p_note            text default null
)
  returns public.debt_entries
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $fn$
begin
  -- The customer paid cash. No confirmation required, and that asymmetry is
  -- deliberate: this reduces what they owe, so a vendor recording it is acting
  -- against their own interest — the same reasoning that lets change credits go
  -- unconfirmed. The reverse gap is real and recorded in README: a vendor who
  -- REFUSES to record a payment leaves the debt standing, and the customer has
  -- no way to record it themselves.
  return public.post_debt_entry(
    p_vendor_id, p_customer_id, 'repaid', 'settlement', p_amount_cfa,
    p_idempotency_key, p_actor_user_id, 'declared', null, p_note
  );
end
$fn$;

revoke all on function public.settle_debt(uuid, uuid, integer, text, uuid, text)
  from public, anon;
grant execute on function public.settle_debt(uuid, uuid, integer, text, uuid, text)
  to authenticated;

create or replace function public.cancel_debt(
  p_vendor_id       uuid,
  p_customer_id     uuid,
  p_amount_cfa      integer,
  p_idempotency_key text,
  p_actor_user_id   uuid,
  p_note            text default null
)
  returns public.debt_entries
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $fn$
begin
  -- A write-off. The vendor forgives it. Never a deletion — the debt and its
  -- cancellation both stay visible, so the history reads as what happened.
  return public.post_debt_entry(
    p_vendor_id, p_customer_id, 'repaid', 'cancellation', p_amount_cfa,
    p_idempotency_key, p_actor_user_id, 'declared', null, p_note
  );
end
$fn$;

revoke all on function public.cancel_debt(uuid, uuid, integer, text, uuid, text)
  from public, anon;
grant execute on function public.cancel_debt(uuid, uuid, integer, text, uuid, text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- The customer's verdict
-- ---------------------------------------------------------------------------
create or replace function public.review_debt_entry(
  p_entry_id      uuid,
  p_decision      text,
  p_actor_user_id uuid,
  p_reason        text default null
)
  returns public.debt_reviews
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $fn$
declare
  v_caller uuid;
  v_entree public.debt_entries;
  v_client public.customers;
  v_ligne  public.debt_reviews;
begin
  if p_actor_user_id is null then
    raise exception 'SIKA_ACTOR_REQUIRED' using errcode = 'SW003';
  end if;
  if p_decision is null or p_decision not in ('accepted', 'disputed') then
    raise exception 'SIKA_DECISION_INVALID' using errcode = 'SW007';
  end if;

  v_caller := public.app_current_user_id();
  if v_caller is not null and v_caller <> p_actor_user_id then
    raise exception 'SIKA_ACTOR_MISMATCH' using errcode = 'SW002';
  end if;

  select * into v_entree from public.debt_entries where id = p_entry_id;
  if not found then
    raise exception 'SIKA_ENTRY_NOT_FOUND' using errcode = 'SW008';
  end if;

  -- ONLY THE DEBTOR. A vendor accepting their own claim on the customer's
  -- behalf would convert every déclarée debt into a confirmée one, which is the
  -- fraud with an extra step.
  select * into v_client from public.customers where id = v_entree.customer_id;
  if not found or v_client.auth_user_id is null
     or v_client.auth_user_id <> p_actor_user_id then
    raise exception 'SIKA_NOT_YOUR_ENTRY' using errcode = 'SW024';
  end if;

  -- Already confirmed at creation: there is nothing to review, and allowing a
  -- "dispute" here would let a customer walk back an agreement they gave on
  -- their own device.
  if v_entree.customer_confirmed_at is not null then
    raise exception 'SIKA_ALREADY_CONFIRMED' using errcode = 'SW025';
  end if;

  -- One decision per entry. A vendor must not be able to pressure a customer
  -- into flipping a dispute repeatedly until it sticks.
  if exists (select 1 from public.debt_reviews r where r.debt_entry_id = p_entry_id) then
    raise exception 'SIKA_ALREADY_REVIEWED' using errcode = 'SW025';
  end if;

  insert into public.debt_reviews (debt_entry_id, decision, reason, decided_by)
  values (p_entry_id, p_decision, p_reason, p_actor_user_id)
  returning * into v_ligne;

  return v_ligne;
end
$fn$;

revoke all on function public.review_debt_entry(uuid, text, uuid, text)
  from public, anon;
grant execute on function public.review_debt_entry(uuid, text, uuid, text)
  to authenticated;

-- The same, for an unconfirmed CHANGE entry, so both ledgers behave alike.
create or replace function public.review_ledger_entry(
  p_entry_id      uuid,
  p_decision      text,
  p_actor_user_id uuid,
  p_reason        text default null
)
  returns public.ledger_reviews
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $fn$
declare
  v_caller uuid;
  v_entree public.ledger_entries;
  v_client public.customers;
  v_ligne  public.ledger_reviews;
begin
  if p_actor_user_id is null then
    raise exception 'SIKA_ACTOR_REQUIRED' using errcode = 'SW003';
  end if;
  if p_decision is null or p_decision not in ('accepted', 'disputed') then
    raise exception 'SIKA_DECISION_INVALID' using errcode = 'SW007';
  end if;

  v_caller := public.app_current_user_id();
  if v_caller is not null and v_caller <> p_actor_user_id then
    raise exception 'SIKA_ACTOR_MISMATCH' using errcode = 'SW002';
  end if;

  select * into v_entree from public.ledger_entries where id = p_entry_id;
  if not found then
    raise exception 'SIKA_ENTRY_NOT_FOUND' using errcode = 'SW008';
  end if;

  select * into v_client from public.customers where id = v_entree.customer_id;
  if not found or v_client.auth_user_id is null
     or v_client.auth_user_id <> p_actor_user_id then
    raise exception 'SIKA_NOT_YOUR_ENTRY' using errcode = 'SW024';
  end if;

  if v_entree.customer_confirmed_at is not null then
    raise exception 'SIKA_ALREADY_CONFIRMED' using errcode = 'SW025';
  end if;
  if exists (select 1 from public.ledger_reviews r where r.ledger_entry_id = p_entry_id) then
    raise exception 'SIKA_ALREADY_REVIEWED' using errcode = 'SW025';
  end if;

  insert into public.ledger_reviews (ledger_entry_id, decision, reason, decided_by)
  values (p_entry_id, p_decision, p_reason, p_actor_user_id)
  returning * into v_ligne;

  return v_ligne;
end
$fn$;

revoke all on function public.review_ledger_entry(uuid, text, uuid, text)
  from public, anon;
grant execute on function public.review_ledger_entry(uuid, text, uuid, text)
  to authenticated;
