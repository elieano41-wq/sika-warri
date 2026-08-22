-- 0035 — Closing the settlement gap.
--
-- ============================================================================
-- THE EXPOSURE INVERTS AGAIN, and this is the part the first pass got wrong.
--
-- With change, the vendor holds the cash and the customer walks away: the
-- customer is exposed afterwards, which is what the ledger protects.
--
-- With debt, the customer HANDS OVER cash and must then trust it was recorded.
-- The customer is exposed at the MOMENT OF PAYMENT and has nothing to point at
-- afterwards. Settlement being a vendor-only write meant a customer who paid
-- 2 000 F and watched it not get typed in had no recourse at all.
--
-- And the common case is not theft. It is an honest vendor at a busy counter
-- forgetting, and two people disagreeing about 2 000 F a month later. That will
-- happen far more often than fraud, and it is what this file is for.
-- ============================================================================
--
-- What is NOT done: gating settlement behind customer confirmation. That would
-- trap debts open whenever the customer has no phone, no battery, or has already
-- left — the same trap a strict PIN gate would create, penalising the honest
-- case to inconvenience the dishonest one. Settlement stays an unconfirmed
-- vendor write, and recourse is added around it:
--
--   * every settlement notifies the customer immediately, informationally
--   * the customer may ACKNOWLEDGE, upgrading it from vendor-declared to
--     mutually recorded — optional, never blocking
--   * the customer may DISPUTE a settlement they did not make
--   * the customer may claim a payment that was NEVER RECORDED, which is the
--     case with no recourse before this
--
-- New error codes:
--   SW029 wrong decision for this direction   SW031 claim already resolved
--   SW030 nothing owed to claim against       SW032 not your claim

-- ---------------------------------------------------------------------------
-- 'acknowledged' as a third verdict
--
-- An 'owed' entry is accepted or disputed: the customer is being asked whether
-- they agree they owe it. A 'repaid' entry is acknowledged or disputed: they are
-- being told something in their favour happened, and confirming it is a
-- courtesy that makes the record mutual rather than a permission.
-- ---------------------------------------------------------------------------
alter table public.debt_reviews drop constraint if exists debt_reviews_decision_check;

alter table public.debt_reviews
  add constraint debt_reviews_decision_check
  check (decision in ('accepted', 'disputed', 'acknowledged'));

-- ---------------------------------------------------------------------------
-- review_debt_entry, taught the difference between the two directions
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
  if p_decision is null
     or p_decision not in ('accepted', 'disputed', 'acknowledged') then
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

  -- ONLY THE DEBTOR. A vendor accepting their own claim, or acknowledging their
  -- own settlement on the customer's behalf, would be the fraud with an extra
  -- step.
  select * into v_client from public.customers where id = v_entree.customer_id;
  if not found or v_client.auth_user_id is null
     or v_client.auth_user_id <> p_actor_user_id then
    raise exception 'SIKA_NOT_YOUR_ENTRY' using errcode = 'SW024';
  end if;

  -- The verdict has to fit the direction, or "accepted" on a repayment would
  -- read as agreeing to owe money the customer has just paid off.
  if v_entree.direction = 'owed' and p_decision = 'acknowledged' then
    raise exception 'SIKA_DECISION_WRONG_DIRECTION' using errcode = 'SW029';
  end if;
  if v_entree.direction = 'repaid' and p_decision = 'accepted' then
    raise exception 'SIKA_DECISION_WRONG_DIRECTION' using errcode = 'SW029';
  end if;

  if v_entree.customer_confirmed_at is not null then
    raise exception 'SIKA_ALREADY_CONFIRMED' using errcode = 'SW025';
  end if;
  if exists (select 1 from public.debt_reviews r where r.debt_entry_id = p_entry_id) then
    raise exception 'SIKA_ALREADY_REVIEWED' using errcode = 'SW025';
  end if;

  insert into public.debt_reviews (debt_entry_id, decision, reason, decided_by)
  values (p_entry_id, p_decision, p_reason, p_actor_user_id)
  returning * into v_ligne;

  return v_ligne;
end
$fn$;

revoke all on function public.review_debt_entry(uuid, text, uuid, text) from public, anon;
grant execute on function public.review_debt_entry(uuid, text, uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- The customer's settlement feed
--
-- Informational, not a gate. Shown like a notification: "Chez Awa a enregistré
-- votre paiement de 2 000 F." Acknowledging is one tap and changes nothing about
-- the money; it changes the record from something one party asserts into
-- something both parties say.
-- ---------------------------------------------------------------------------
drop function if exists public.my_settlements(uuid, integer);

create function public.my_settlements(
  p_actor_user_id uuid,
  p_limit         integer default 50
)
  returns table (
    id             uuid,
    vendor_id      uuid,
    business_name  text,
    kind           text,
    amount_cfa     integer,
    note           text,
    created_at     timestamptz,
    state          text,
    -- Still answerable. False once acknowledged or disputed, so a screen never
    -- offers a button that will be refused.
    answerable     boolean,
    remaining_debt integer,
    total_count    integer
  )
  language plpgsql
  stable
  security definer
  set search_path = public, pg_temp
as $fn$
declare
  v_caller      uuid;
  v_customer_id uuid;
  v_total       integer;
begin
  if p_actor_user_id is null then
    raise exception 'SIKA_ACTOR_REQUIRED' using errcode = 'SW003';
  end if;
  v_caller := public.app_current_user_id();
  if v_caller is not null and v_caller <> p_actor_user_id then
    raise exception 'SIKA_ACTOR_MISMATCH' using errcode = 'SW002';
  end if;

  select c.id into v_customer_id from public.customers c
   where c.auth_user_id = p_actor_user_id;
  if not found then
    raise exception 'SIKA_CUSTOMER_NOT_FOUND' using errcode = 'SW008';
  end if;

  select count(*)::integer into v_total
  from public.debt_entries d
  where d.customer_id = v_customer_id and d.direction = 'repaid';

  return query
  select
    d.id, d.vendor_id, v.business_name, d.kind, d.amount_cfa, d.note, d.created_at,
    case
      when d.customer_confirmed_at is not null then 'confirmed'
      when r.decision = 'acknowledged'         then 'acknowledged'
      when r.decision = 'disputed'             then 'disputed'
      else 'declared'
    end,
    (d.customer_confirmed_at is null and r.id is null),
    e.restant,
    v_total
  from public.debt_entries d
  join public.vendors v on v.id = d.vendor_id
  left join public.debt_reviews r on r.debt_entry_id = d.id
  cross join lateral (
    select coalesce(sum(case when x.direction = 'owed'
                             then x.amount_cfa else -x.amount_cfa end), 0)::integer as restant
    from public.debt_entries x
    where x.vendor_id = d.vendor_id and x.customer_id = v_customer_id
  ) e
  where d.customer_id = v_customer_id
    and d.direction = 'repaid'
  order by d.created_at desc
  limit greatest(1, least(coalesce(p_limit, 50), 200));
end
$fn$;

revoke all on function public.my_settlements(uuid, integer) from public, anon;
grant execute on function public.my_settlements(uuid, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- payment_claims — "j'ai payé, ce n'est pas enregistré"
--
-- THE CASE WITH NO RECOURSE BEFORE THIS. A customer hands over cash, the vendor
-- does not type it in, and a month later there is a disagreement with nothing on
-- either side but memory. This gives the customer something to point at, created
-- at the time rather than reconstructed afterwards.
--
-- WHAT IT DOES NOT DO: change the debt. A customer who could unilaterally reduce
-- what they owe would be the mirror image of the fraud this whole design is
-- built against — the vendor would be exposed exactly as the customer is now.
-- The claim is a flag, visible to both parties and to the support panel, and it
-- is resolved by the vendor recording the settlement or by a conversation
-- outside the app.
-- ---------------------------------------------------------------------------
create table if not exists public.payment_claims (
  id            uuid primary key default gen_random_uuid(),
  vendor_id     uuid not null references public.vendors(id),
  customer_id   uuid not null references public.customers(id),
  amount_cfa    integer not null check (amount_cfa > 0),
  -- When the customer says they paid. Free-form on purpose: someone recalling
  -- last Tuesday should not be forced into a precision they do not have.
  paid_on       date,
  note          text,
  created_at    timestamptz not null default now(),
  created_by    uuid not null,

  -- Resolution, appended not edited.
  resolved_at   timestamptz,
  resolved_by   uuid,
  resolution    text check (resolution in ('recorded', 'rejected', 'withdrawn')),
  -- The settlement the vendor posted in response, when there is one.
  settled_entry_id uuid references public.debt_entries(id),

  constraint payment_claims_resolution_consistent
    check ((resolved_at is null) = (resolution is null))
);

create index if not exists payment_claims_open_idx
  on public.payment_claims (created_at desc) where resolved_at is null;
create index if not exists payment_claims_pair_idx
  on public.payment_claims (vendor_id, customer_id, created_at desc);

-- One open claim per pair at a time. Otherwise a customer could file twenty and
-- the flag stops meaning anything.
create unique index if not exists payment_claims_one_open_idx
  on public.payment_claims (vendor_id, customer_id) where resolved_at is null;

alter table public.payment_claims enable row level security;

drop policy if exists payment_claims_select on public.payment_claims;
create policy payment_claims_select on public.payment_claims
  for select to authenticated
  using (
    vendor_id = public.app_current_vendor_id()
    or customer_id = public.app_current_customer_id()
  );

revoke insert, update, delete on public.payment_claims from anon, authenticated;
grant select on public.payment_claims to authenticated;

-- ---------------------------------------------------------------------------
create or replace function public.claim_unrecorded_payment(
  p_vendor_id     uuid,
  p_amount_cfa    integer,
  p_actor_user_id uuid,
  p_paid_on       date default null,
  p_note          text default null
)
  returns public.payment_claims
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $fn$
declare
  v_caller      uuid;
  v_customer_id uuid;
  v_encours     integer;
  v_ligne       public.payment_claims;
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

  select c.id into v_customer_id from public.customers c
   where c.auth_user_id = p_actor_user_id;
  if not found then
    raise exception 'SIKA_CUSTOMER_NOT_FOUND' using errcode = 'SW008';
  end if;

  -- Only against a debt that exists. A claim of paying a shop the customer owes
  -- nothing at is noise, and it would let anyone flag any vendor.
  select coalesce(sum(case when d.direction = 'owed'
                           then d.amount_cfa else -d.amount_cfa end), 0)::integer
    into v_encours
  from public.debt_entries d
  where d.vendor_id = p_vendor_id and d.customer_id = v_customer_id;

  if v_encours <= 0 then
    raise exception 'SIKA_NOTHING_OWED_HERE' using errcode = 'SW030';
  end if;

  insert into public.payment_claims (
    vendor_id, customer_id, amount_cfa, paid_on, note, created_by
  ) values (
    p_vendor_id, v_customer_id, p_amount_cfa, p_paid_on, p_note, p_actor_user_id
  )
  returning * into v_ligne;

  return v_ligne;
end
$fn$;

revoke all on function public.claim_unrecorded_payment(uuid, integer, uuid, date, text)
  from public, anon;
grant execute on function public.claim_unrecorded_payment(uuid, integer, uuid, date, text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- Resolving a claim
--
-- 'recorded'  — the vendor agrees and posts the settlement. The claim carries a
--               pointer to the entry, so the two are readable together.
-- 'rejected'  — the vendor says it did not happen. The claim STAYS, resolved but
--               visible: a rejected claim is evidence of a disagreement, and
--               deleting it would erase exactly the thing worth keeping.
-- 'withdrawn' — the customer takes it back.
-- ---------------------------------------------------------------------------
create or replace function public.resolve_payment_claim(
  p_claim_id        uuid,
  p_resolution      text,
  p_actor_user_id   uuid,
  p_settled_entry_id uuid default null
)
  returns public.payment_claims
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $fn$
declare
  v_caller uuid;
  v_claim  public.payment_claims;
  v_est_vendeur boolean;
  v_est_client  boolean;
  v_ligne  public.payment_claims;
begin
  if p_actor_user_id is null then
    raise exception 'SIKA_ACTOR_REQUIRED' using errcode = 'SW003';
  end if;
  if p_resolution is null
     or p_resolution not in ('recorded', 'rejected', 'withdrawn') then
    raise exception 'SIKA_RESOLUTION_INVALID' using errcode = 'SW007';
  end if;

  v_caller := public.app_current_user_id();
  if v_caller is not null and v_caller <> p_actor_user_id then
    raise exception 'SIKA_ACTOR_MISMATCH' using errcode = 'SW002';
  end if;

  select * into v_claim from public.payment_claims where id = p_claim_id;
  if not found then
    raise exception 'SIKA_CLAIM_NOT_FOUND' using errcode = 'SW008';
  end if;
  if v_claim.resolved_at is not null then
    raise exception 'SIKA_CLAIM_ALREADY_RESOLVED' using errcode = 'SW031';
  end if;

  select exists (select 1 from public.vendors v
                  where v.id = v_claim.vendor_id and v.auth_user_id = p_actor_user_id)
    into v_est_vendeur;
  select exists (select 1 from public.customers c
                  where c.id = v_claim.customer_id and c.auth_user_id = p_actor_user_id)
    into v_est_client;

  if not (v_est_vendeur or v_est_client) then
    raise exception 'SIKA_NOT_YOUR_CLAIM' using errcode = 'SW032';
  end if;

  -- Only the customer may withdraw; only the vendor may record or reject. A
  -- vendor "withdrawing" a customer's claim would be deleting the complaint
  -- against them.
  if p_resolution = 'withdrawn' and not v_est_client then
    raise exception 'SIKA_NOT_YOUR_CLAIM' using errcode = 'SW032';
  end if;
  if p_resolution in ('recorded', 'rejected') and not v_est_vendeur then
    raise exception 'SIKA_NOT_YOUR_CLAIM' using errcode = 'SW032';
  end if;

  update public.payment_claims
     set resolved_at = now(),
         resolved_by = p_actor_user_id,
         resolution = p_resolution,
         settled_entry_id = p_settled_entry_id
   where id = p_claim_id
  returning * into v_ligne;

  return v_ligne;
end
$fn$;

revoke all on function public.resolve_payment_claim(uuid, text, uuid, uuid)
  from public, anon;
grant execute on function public.resolve_payment_claim(uuid, text, uuid, uuid)
  to authenticated;

-- ---------------------------------------------------------------------------
-- Open claims, for whichever side is asking
-- ---------------------------------------------------------------------------
drop function if exists public.my_payment_claims(uuid, integer);

create function public.my_payment_claims(
  p_actor_user_id uuid,
  p_limit         integer default 50
)
  returns table (
    id            uuid,
    vendor_id     uuid,
    business_name text,
    customer_id   uuid,
    customer_phone text,
    customer_label text,
    amount_cfa    integer,
    paid_on       date,
    note          text,
    created_at    timestamptz,
    resolved_at   timestamptz,
    resolution    text,
    total_count   integer
  )
  language plpgsql
  stable
  security definer
  set search_path = public, pg_temp
as $fn$
declare
  v_caller      uuid;
  v_vendor_id   uuid;
  v_customer_id uuid;
  v_total       integer;
begin
  if p_actor_user_id is null then
    raise exception 'SIKA_ACTOR_REQUIRED' using errcode = 'SW003';
  end if;
  v_caller := public.app_current_user_id();
  if v_caller is not null and v_caller <> p_actor_user_id then
    raise exception 'SIKA_ACTOR_MISMATCH' using errcode = 'SW002';
  end if;

  select v.id into v_vendor_id from public.vendors v where v.auth_user_id = p_actor_user_id;
  select c.id into v_customer_id from public.customers c where c.auth_user_id = p_actor_user_id;

  if v_vendor_id is null and v_customer_id is null then
    raise exception 'SIKA_CUSTOMER_NOT_FOUND' using errcode = 'SW008';
  end if;

  select count(*)::integer into v_total
  from public.payment_claims pc
  where (v_vendor_id is not null and pc.vendor_id = v_vendor_id)
     or (v_customer_id is not null and pc.customer_id = v_customer_id);

  return query
  select
    pc.id, pc.vendor_id, v.business_name, pc.customer_id, c.phone, l.display_name,
    pc.amount_cfa, pc.paid_on, pc.note, pc.created_at,
    pc.resolved_at, pc.resolution, v_total
  from public.payment_claims pc
  join public.vendors v on v.id = pc.vendor_id
  join public.customers c on c.id = pc.customer_id
  left join public.vendor_customer_labels l
    on l.vendor_id = pc.vendor_id and l.customer_id = pc.customer_id
  where (v_vendor_id is not null and pc.vendor_id = v_vendor_id)
     or (v_customer_id is not null and pc.customer_id = v_customer_id)
  -- Open first: an unresolved claim is the one that needs doing something about.
  order by (pc.resolved_at is null) desc, pc.created_at desc
  limit greatest(1, least(coalesce(p_limit, 50), 200));
end
$fn$;

revoke all on function public.my_payment_claims(uuid, integer) from public, anon;
grant execute on function public.my_payment_claims(uuid, integer) to authenticated;
