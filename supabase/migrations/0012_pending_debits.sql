-- 0012 — Pending debits.  (Amendment H)
--
-- The hole this closes: a PIN typed on the vendor's device is observable by the
-- vendor, who can then debit that customer whenever they like. The confirmation
-- was supposed to prove the customer consented to THIS transaction; once the
-- vendor knows the PIN it proves nothing at all.
--
-- So a debit becomes a two-party handshake across two devices. The vendor
-- proposes; the customer disposes, on their own phone, with a PIN the vendor
-- never sees. The pending row is the proposal — it holds no money, moves no
-- balance, and expires quickly.
--
-- Registration is global: one phone, one PIN, valid at every vendor. There is
-- no per-vendor enrolment and no per-vendor code.

create table if not exists public.pending_debits (
  id                uuid primary key default gen_random_uuid(),
  vendor_id         uuid not null references public.vendors(id),
  customer_id       uuid not null references public.customers(id),
  kind              text not null check (kind in ('purchase','refund')),
  amount_cfa        integer not null check (amount_cfa > 0),

  -- Generated at proposal time and carried through to the ledger entry, so a
  -- double confirmation collapses onto one entry via the existing idempotency
  -- path rather than needing a second mechanism.
  idempotency_key   text not null,

  created_by        uuid not null,
  created_at        timestamptz not null default now(),
  expires_at        timestamptz not null,

  consumed_at       timestamptz,
  consumed_entry_id uuid references public.ledger_entries(id),
  cancelled_at      timestamptz,

  constraint pending_debits_vendor_idem_unique unique (vendor_id, idempotency_key),

  -- Consumption is all-or-nothing: a row either points at the entry it became
  -- or at nothing. A consumed row with no entry would be a debit we believe
  -- happened but cannot show.
  constraint pending_debits_consumed_consistent
    check ((consumed_at is null) = (consumed_entry_id is null)),

  -- A proposal cannot be both accepted and withdrawn.
  constraint pending_debits_not_both
    check (not (consumed_at is not null and cancelled_at is not null)),

  constraint pending_debits_expiry_after_creation
    check (expires_at > created_at)
);

-- The customer app polls "what is waiting for me right now", and the vendor
-- screen polls "has mine landed yet". Both are this shape.
create index if not exists pending_debits_customer_open_idx
  on public.pending_debits (customer_id, expires_at desc)
  where consumed_at is null and cancelled_at is null;

create index if not exists pending_debits_vendor_open_idx
  on public.pending_debits (vendor_id, created_at desc);

alter table public.pending_debits enable row level security;

revoke all on public.pending_debits from anon, authenticated;
grant select on public.pending_debits to authenticated;

-- Both parties may watch their own side. Neither may write directly: the
-- proposal and its acceptance are the two functions below, nothing else.
drop policy if exists pending_debits_select_own_side on public.pending_debits;
create policy pending_debits_select_own_side on public.pending_debits
  for select to authenticated
  using (
    vendor_id = public.app_current_vendor_id()
    or customer_id = public.app_current_customer_id()
  );

-- ---------------------------------------------------------------------------
-- Step 1 — the vendor proposes.
--
-- Validates everything it can up front so the customer is not asked to
-- authorise something that will fail anyway. It does NOT reserve the balance:
-- the authoritative check happens inside post_ledger_entry under the pair lock
-- at confirmation time, because the balance can legitimately move in the 180
-- seconds in between.
-- ---------------------------------------------------------------------------
create or replace function public.create_pending_debit(
  p_vendor_id       uuid,
  p_customer_id     uuid,
  p_kind            text,
  p_amount_cfa      integer,
  p_idempotency_key text,
  p_actor_user_id   uuid
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

  if p_kind not in ('purchase','refund') then
    raise exception 'SIKA_INVALID_KIND' using errcode = 'SW007';
  end if;

  if p_amount_cfa is null or p_amount_cfa <= 0 then
    raise exception 'SIKA_INVALID_AMOUNT' using errcode = 'SW007';
  end if;

  if p_idempotency_key is null or length(btrim(p_idempotency_key)) = 0 then
    raise exception 'SIKA_IDEMPOTENCY_KEY_REQUIRED' using errcode = 'SW007';
  end if;

  -- Re-proposing with the same key returns the original proposal, so a flaky
  -- connection on the vendor's side cannot spawn two requests at the customer.
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
    created_by, expires_at
  ) values (
    p_vendor_id, p_customer_id, p_kind, p_amount_cfa, p_idempotency_key,
    p_actor_user_id, now() + interval '180 seconds'
  )
  returning * into v_row;

  return v_row;
end
$fn$;

revoke all on function public.create_pending_debit(uuid, uuid, text, integer, text, uuid)
  from public, anon;
grant execute on function public.create_pending_debit(uuid, uuid, text, integer, text, uuid)
  to authenticated;

-- ---------------------------------------------------------------------------
-- Step 2 — what the customer's app polls.
--
-- Discloses the vendor's business_name, which the customer cannot read from the
-- vendors table. That is deliberate and minimal: you cannot ask someone to
-- authorise paying a shop without naming the shop. Nothing else about the
-- vendor is exposed, and only for a proposal addressed to this customer.
-- ---------------------------------------------------------------------------
create or replace function public.pending_debits_for_customer(p_actor_user_id uuid)
  returns table (
    id                uuid,
    vendor_id         uuid,
    business_name     text,
    kind              text,
    amount_cfa        integer,
    current_balance   integer,
    resulting_balance integer,
    expires_at        timestamptz,
    seconds_left      integer
  )
  language plpgsql
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
    p.id,
    p.vendor_id,
    v.business_name,
    p.kind,
    p.amount_cfa,
    b.balance,
    b.balance - p.amount_cfa,
    p.expires_at,
    greatest(0, ceil(extract(epoch from (p.expires_at - now())))::integer)
  from public.pending_debits p
  join public.vendors v on v.id = p.vendor_id
  cross join lateral (
    select coalesce(
             sum(case when e.direction = 'credit' then e.amount_cfa else -e.amount_cfa end), 0
           )::integer as balance
    from public.ledger_entries e
    where e.vendor_id = p.vendor_id and e.customer_id = p.customer_id
  ) b
  where p.customer_id = v_customer_id
    and p.consumed_at is null
    and p.cancelled_at is null
    and p.expires_at > now()
  order by p.created_at;
end
$fn$;

revoke all on function public.pending_debits_for_customer(uuid) from public, anon;
grant execute on function public.pending_debits_for_customer(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Step 3 — the customer accepts, on their own device.
--
-- Called ONLY by the confirm-debit Edge Function, as service role, after it has
-- verified the customer's own JWT and their PIN. Execute is withheld from
-- `authenticated` precisely so a client cannot reach it without that PIN check:
-- the function itself cannot verify a PIN, so it must not be directly callable.
--
-- Note it passes the VENDOR's auth user as the ledger actor. post_ledger_entry
-- checks vendor ownership against that, and the customer's consent is recorded
-- separately as customer_confirmed_at plus confirmation_method = own_device.
-- This is also why the caller must be service role: with a live customer
-- session, post_ledger_entry's actor guard would correctly reject the mismatch.
-- ---------------------------------------------------------------------------
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
  v_caller      uuid;
  v_pending     public.pending_debits;
  v_customer_id uuid;
  v_vendor_actor uuid;
  v_entry       public.ledger_entries;
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

  -- Lock the proposal so two taps cannot both convert it.
  select * into v_pending
  from public.pending_debits
  where id = p_pending_id
  for update;

  if not found then
    raise exception 'SIKA_PENDING_NOT_FOUND' using errcode = 'SW008';
  end if;

  -- Only the customer the proposal is addressed to may accept it.
  if v_pending.customer_id <> v_customer_id then
    raise exception 'SIKA_PENDING_NOT_YOURS' using errcode = 'SW001';
  end if;

  if v_pending.cancelled_at is not null then
    raise exception 'SIKA_PENDING_CANCELLED' using errcode = 'SW011';
  end if;

  -- Already accepted: hand back the entry it became. Idempotent by design, so
  -- a retry on a dropped response does not look like a second debit.
  if v_pending.consumed_at is not null then
    select * into v_entry
    from public.ledger_entries where id = v_pending.consumed_entry_id;
    return v_entry;
  end if;

  -- Test 15. Expiry is checked here, against now(), rather than trusted from a
  -- client clock. An expired proposal is never convertible — not by a retry,
  -- not by a replay, not by a vendor holding the id.
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

  v_entry := public.post_ledger_entry(
    p_vendor_id           => v_pending.vendor_id,
    p_customer_id         => v_pending.customer_id,
    p_direction           => 'debit',
    p_kind                => v_pending.kind,
    p_amount_cfa          => v_pending.amount_cfa,
    p_idempotency_key     => v_pending.idempotency_key,
    p_actor_user_id       => v_vendor_actor,
    p_customer_confirmed  => true,
    p_reverses_entry_id   => null,
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

-- Withheld from authenticated on purpose — see the comment above.
revoke all on function public.confirm_pending_debit(uuid, uuid)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The vendor withdraws a proposal.
--
-- Not in amendment H's four steps, but a mistyped amount otherwise leaves the
-- customer staring at a request for the wrong sum for three minutes with no
-- way to clear it. Flagged as an addition.
-- ---------------------------------------------------------------------------
create or replace function public.cancel_pending_debit(
  p_pending_id    uuid,
  p_actor_user_id uuid
)
  returns public.pending_debits
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $fn$
declare
  v_caller  uuid;
  v_pending public.pending_debits;
  v_row     public.pending_debits;
begin
  if p_actor_user_id is null then
    raise exception 'SIKA_ACTOR_REQUIRED' using errcode = 'SW003';
  end if;

  v_caller := public.app_current_user_id();
  if v_caller is not null and v_caller <> p_actor_user_id then
    raise exception 'SIKA_ACTOR_MISMATCH' using errcode = 'SW002';
  end if;

  select * into v_pending
  from public.pending_debits where id = p_pending_id for update;
  if not found then
    raise exception 'SIKA_PENDING_NOT_FOUND' using errcode = 'SW008';
  end if;

  perform 1 from public.vendors v
   where v.id = v_pending.vendor_id and v.auth_user_id = p_actor_user_id;
  if not found then
    raise exception 'SIKA_VENDOR_FORBIDDEN' using errcode = 'SW001';
  end if;

  -- A debit that already landed is history and cannot be withdrawn; correcting
  -- it means a reversal entry (rule 3).
  if v_pending.consumed_at is not null then
    raise exception 'SIKA_PENDING_ALREADY_CONSUMED' using errcode = 'SW011';
  end if;

  update public.pending_debits
     set cancelled_at = coalesce(cancelled_at, now())
   where id = v_pending.id
  returning * into v_row;

  return v_row;
end
$fn$;

revoke all on function public.cancel_pending_debit(uuid, uuid) from public, anon;
grant execute on function public.cancel_pending_debit(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Housekeeping. Expired proposals are inert — confirm_pending_debit refuses
-- them regardless — so this is table hygiene, not a safety mechanism. Called
-- from the keepalive workflow.
-- ---------------------------------------------------------------------------
create or replace function public.purge_expired_pending_debits(
  p_older_than interval default interval '7 days'
)
  returns integer
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $fn$
declare
  v_deleted integer;
begin
  delete from public.pending_debits
  where consumed_at is null
    and expires_at < now() - p_older_than;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end
$fn$;

revoke all on function public.purge_expired_pending_debits(interval)
  from public, anon, authenticated;
