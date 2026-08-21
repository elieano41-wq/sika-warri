-- 0020 — Recovery becomes a support desk. Vendor vouching is removed entirely.
--
-- WHY THE OLD MODEL IS GONE. A vouching vendor could request a reset for a
-- customer and then claim it themselves on their own phone, setting a code they
-- know. They would hold that customer's account and could confirm debits at
-- will — exactly what amendment H exists to prevent. The 60-minute cooling-off
-- delayed that; it did not prevent it, and a patient attacker simply waited.
-- Detection is not sufficient when the thing being protected is someone's money.
--
-- THE NEW MODEL. Every reset, for every role, goes through the operator.
--
--   1. The locked-out person asks, from the login screen. The app's answer is
--      identical whether or not the number is registered.
--   2. The request appears in the admin queue.
--   3. The operator telephones them and challenges their identity against
--      information only the account holder would know.
--   4. The SYSTEM generates a temporary code. The operator cannot choose it,
--      cannot reuse one, and sees it once.
--   5. The holder enters it on their own device and immediately sets a new PIN.
--   6. The code unlocks nothing else. It cannot authorise a debit.
--
-- The old pin_resets table is dropped rather than migrated. It holds test rows
-- only, and its shape encodes the vouching model — an attributed-to-a-vendor
-- column that must never be writable again.

drop function if exists public.request_customer_pin_reset(uuid, uuid, uuid, text);
drop function if exists public.admin_request_vendor_pin_reset(uuid, uuid, text);
drop function if exists public.open_pin_reset_for_phone(text);
drop function if exists public.consume_pin_reset(uuid, inet);
drop function if exists public.my_pin_resets(uuid);
drop function if exists public.vendor_barred_until(uuid, uuid);
drop function if exists public.pin_reset_cooloff();
drop table if exists public.pin_resets;

-- ---------------------------------------------------------------------------
-- Step 1 — somebody asks.
--
-- Created from a logged-out device with no proof of anything. It is a queue
-- entry, not a grant: it confers nothing at all. Rows exist for unregistered
-- numbers too, because refusing to create one would tell a caller whether a
-- number has an account.
-- ---------------------------------------------------------------------------
create table if not exists public.pin_reset_requests (
  id           uuid primary key default gen_random_uuid(),
  phone        text not null,
  created_at   timestamptz not null default now(),
  created_ip   inet,
  status       text not null default 'pending'
                 check (status in ('pending','granted','rejected')),
  resolved_at  timestamptz,
  resolved_by  uuid,
  note         text
);

create index if not exists pin_reset_requests_pending_idx
  on public.pin_reset_requests (created_at desc) where status = 'pending';
create index if not exists pin_reset_requests_phone_idx
  on public.pin_reset_requests (phone, created_at desc);

alter table public.pin_reset_requests enable row level security;
-- No client role may read this. A caller who could would learn which numbers
-- are registered and who is currently locked out.
revoke all on public.pin_reset_requests from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Step 4 — the operator issues a temporary code.
--
-- Only the HASH is stored. A database leak must not hand anybody a working
-- reset code, and the operator cannot look one up after the fact — it is shown
-- once, on issue, and then exists nowhere in readable form.
-- ---------------------------------------------------------------------------
create table if not exists public.pin_reset_grants (
  id            uuid primary key default gen_random_uuid(),
  request_id    uuid not null references public.pin_reset_requests(id),

  target_role        text not null check (target_role in ('vendor','customer')),
  target_customer_id uuid references public.customers(id),
  target_vendor_id   uuid references public.vendors(id),
  target_auth_user_id uuid not null,

  -- Never the code itself.
  code_hash     text not null,
  code_salt     text not null,

  -- A 6-digit code is 10^6 possibilities: trivially brute-forced without a
  -- ceiling. Five wrong guesses kills the grant.
  attempts      integer not null default 0,

  issued_by     uuid not null,
  issued_at     timestamptz not null default now(),
  expires_at    timestamptz not null,
  consumed_at   timestamptz,
  consumed_ip   inet,

  constraint pin_reset_grants_target_matches_role check (
    (target_role = 'customer' and target_customer_id is not null and target_vendor_id is null)
    or
    (target_role = 'vendor'   and target_vendor_id is not null and target_customer_id is null)
  ),
  constraint pin_reset_grants_expiry_after_issue check (expires_at > issued_at),
  -- One grant per request. Re-issuing means a new request, so the queue always
  -- reflects what actually happened.
  constraint pin_reset_grants_one_per_request unique (request_id)
);

create index if not exists pin_reset_grants_open_idx
  on public.pin_reset_grants (target_auth_user_id, expires_at desc)
  where consumed_at is null;

alter table public.pin_reset_grants enable row level security;
revoke all on public.pin_reset_grants from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Limits.
-- ---------------------------------------------------------------------------
create or replace function public.pin_reset_grant_window()
  returns interval language sql immutable as $$ select interval '30 minutes' $$;

/** Per-phone request ceiling, per 24 hours. */
create or replace function public.pin_reset_max_requests()
  returns integer language sql immutable as $$ select 3 $$;

/**
 * Global ceiling on grants issued per hour.
 *
 * Not a per-admin limit: the point is that a COMPROMISED admin account cannot
 * mass-reset the user base. A single stolen session hits this wall regardless
 * of which admin it belongs to.
 */
create or replace function public.pin_reset_max_grants_per_hour()
  returns integer language sql immutable as $$ select 10 $$;

/** Wrong guesses allowed against one grant. */
create or replace function public.pin_reset_max_attempts()
  returns integer language sql immutable as $$ select 5 $$;

-- ---------------------------------------------------------------------------
-- Create a request. Returns nothing that reveals whether the number exists.
-- ---------------------------------------------------------------------------
create or replace function public.create_pin_reset_request(
  p_phone text,
  p_ip    inet default null
)
  returns void
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $fn$
declare
  v_recent integer;
begin
  select count(*)::integer into v_recent
  from public.pin_reset_requests
  where phone = p_phone
    and created_at > now() - interval '24 hours';

  if v_recent >= public.pin_reset_max_requests() then
    raise exception 'SIKA_RESET_REQUEST_LIMIT' using errcode = 'SW015';
  end if;

  -- Nothing is checked about the phone. An unregistered number produces a row
  -- the operator will see and reject, which is cheaper than leaking existence.
  insert into public.pin_reset_requests (phone, created_ip) values (p_phone, p_ip);
end
$fn$;

revoke all on function public.create_pin_reset_request(text, inet)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The queue, with everything the operator needs to challenge an identity
-- WHILE ON THE CALL. Not two taps away: if it takes navigation, it will be
-- skipped under pressure and the challenge becomes theatre.
-- ---------------------------------------------------------------------------
create or replace function public.admin_reset_queue(p_actor_user_id uuid)
  returns table (
    request_id     uuid,
    phone          text,
    requested_at   timestamptz,
    account_exists boolean,
    role           text,
    nom            text,
    quartier       text,
    registered_at  timestamptz,
    -- Customers: the shops holding their change. Vendors: how many customers
    -- they owe and how much.
    contexte       text,
    -- The last three movements, as text the operator can read aloud.
    derniers       text[],
    prior_resets   integer
  )
  language plpgsql
  stable
  security definer
  set search_path = public, pg_temp
as $fn$
declare
  v_caller uuid;
begin
  if p_actor_user_id is null then
    raise exception 'SIKA_ACTOR_REQUIRED' using errcode = 'SW003';
  end if;

  v_caller := public.app_current_user_id();
  if v_caller is not null and v_caller <> p_actor_user_id then
    raise exception 'SIKA_ACTOR_MISMATCH' using errcode = 'SW002';
  end if;

  if not public.is_admin(p_actor_user_id) then
    raise exception 'SIKA_ADMIN_ONLY' using errcode = 'SW001';
  end if;

  return query
  with demandes as (
    select r.id, r.phone, r.created_at
    from public.pin_reset_requests r
    where r.status = 'pending'
    order by r.created_at
    limit 100
  ),
  resolu as (
    select
      d.*,
      v.id as vid, v.business_name as vnom, v.quartier as vq,
      v.created_at as vcreated, v.auth_user_id as vauth,
      c.id as cid, c.display_name as cnom, c.created_at as ccreated,
      c.auth_user_id as cauth
    from demandes d
    left join public.vendors v on v.phone = d.phone
    left join public.customers c on c.phone = d.phone
  )
  select
    r.id,
    r.phone,
    r.created_at,
    (r.vid is not null or r.cid is not null),
    case when r.vid is not null then 'vendor'
         when r.cid is not null then 'customer' end,
    coalesce(r.vnom, r.cnom),
    r.vq,
    coalesce(r.vcreated, r.ccreated),

    case
      when r.vid is not null then (
        select format('%s client(s), %s F en circulation',
                      count(*) filter (where s.solde > 0),
                      coalesce(sum(greatest(s.solde, 0)), 0))
        from (
          select sum(case when e.direction='credit' then e.amount_cfa else -e.amount_cfa end)::integer as solde
          from public.ledger_entries e
          where e.vendor_id = r.vid
          group by e.customer_id
        ) s
      )
      when r.cid is not null then (
        select coalesce(string_agg(x.nom || ' (' || x.solde || ' F)', ', '), 'aucune monnaie enregistrée')
        from (
          select v2.business_name as nom,
                 sum(case when e.direction='credit' then e.amount_cfa else -e.amount_cfa end)::integer as solde
          from public.ledger_entries e
          join public.vendors v2 on v2.id = e.vendor_id
          where e.customer_id = r.cid
          group by v2.business_name
          having sum(case when e.direction='credit' then e.amount_cfa else -e.amount_cfa end) > 0
        ) x
      )
    end,

    -- Three most recent movements. The operator asks about one of these.
    case
      when r.vid is not null then (
        select array_agg(t.ligne order by t.quand desc)
        from (
          select e.created_at as quand,
                 to_char(e.created_at, 'DD/MM') || ' ' ||
                 case e.kind when 'change' then 'gardé' when 'purchase' then 'utilisé'
                             when 'refund' then 'remboursé' else 'correction' end ||
                 ' ' || e.amount_cfa || ' F' as ligne
          from public.ledger_entries e
          where e.vendor_id = r.vid
          order by e.created_at desc limit 3
        ) t
      )
      when r.cid is not null then (
        select array_agg(t.ligne order by t.quand desc)
        from (
          select e.created_at as quand,
                 to_char(e.created_at, 'DD/MM') || ' ' || v3.business_name || ' ' ||
                 case e.kind when 'change' then 'gardé' when 'purchase' then 'utilisé'
                             when 'refund' then 'remboursé' else 'correction' end ||
                 ' ' || e.amount_cfa || ' F' as ligne
          from public.ledger_entries e
          join public.vendors v3 on v3.id = e.vendor_id
          where e.customer_id = r.cid
          order by e.created_at desc limit 3
        ) t
      )
    end,

    -- How many times this number has been reset before. A repeat caller is the
    -- pattern worth noticing.
    (select count(*)::integer
       from public.pin_reset_requests pr
      where pr.phone = r.phone and pr.status = 'granted')
  from resolu r
  order by r.created_at;
end
$fn$;

revoke all on function public.admin_reset_queue(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Issue a grant. The CODE HASH arrives from the Edge Function, which generated
-- the code with a CSPRNG. This function cannot be handed a chosen code: it
-- never sees a code at all.
-- ---------------------------------------------------------------------------
create or replace function public.admin_issue_pin_reset(
  p_request_id    uuid,
  p_code_hash     text,
  p_code_salt     text,
  p_actor_user_id uuid
)
  returns public.pin_reset_grants
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $fn$
declare
  v_caller  uuid;
  v_req     public.pin_reset_requests;
  v_role    text;
  v_cid     uuid;
  v_vid     uuid;
  v_auth    uuid;
  v_global  integer;
  v_row     public.pin_reset_grants;
begin
  if p_actor_user_id is null then
    raise exception 'SIKA_ACTOR_REQUIRED' using errcode = 'SW003';
  end if;

  v_caller := public.app_current_user_id();
  if v_caller is not null and v_caller <> p_actor_user_id then
    raise exception 'SIKA_ACTOR_MISMATCH' using errcode = 'SW002';
  end if;

  if not public.is_admin(p_actor_user_id) then
    raise exception 'SIKA_ADMIN_ONLY' using errcode = 'SW001';
  end if;

  if p_code_hash is null or length(p_code_hash) < 32
     or p_code_salt is null or length(p_code_salt) < 16 then
    raise exception 'SIKA_WEAK_GRANT_MATERIAL' using errcode = 'SW007';
  end if;

  -- Global hourly ceiling. A compromised admin session cannot mass-reset.
  select count(*)::integer into v_global
  from public.pin_reset_grants
  where issued_at > now() - interval '1 hour';

  if v_global >= public.pin_reset_max_grants_per_hour() then
    raise exception 'SIKA_GRANT_RATE_LIMITED'
      using errcode = 'SW015',
            detail = format('%s grants in the last hour', v_global);
  end if;

  select * into v_req from public.pin_reset_requests
   where id = p_request_id for update;
  if not found then
    raise exception 'SIKA_REQUEST_NOT_FOUND' using errcode = 'SW008';
  end if;

  if v_req.status <> 'pending' then
    raise exception 'SIKA_REQUEST_ALREADY_RESOLVED' using errcode = 'SW016';
  end if;

  select 'vendor', v.id, null::uuid, v.auth_user_id into v_role, v_vid, v_cid, v_auth
  from public.vendors v where v.phone = v_req.phone and v.auth_user_id is not null;

  if v_role is null then
    select 'customer', null::uuid, c.id, c.auth_user_id into v_role, v_vid, v_cid, v_auth
    from public.customers c where c.phone = v_req.phone and c.auth_user_id is not null;
  end if;

  if v_role is null then
    raise exception 'SIKA_NO_ACCOUNT_FOR_PHONE' using errcode = 'SW008';
  end if;

  insert into public.pin_reset_grants (
    request_id, target_role, target_customer_id, target_vendor_id,
    target_auth_user_id, code_hash, code_salt, issued_by, expires_at
  ) values (
    p_request_id, v_role, v_cid, v_vid,
    v_auth, p_code_hash, p_code_salt, p_actor_user_id,
    now() + public.pin_reset_grant_window()
  )
  returning * into v_row;

  update public.pin_reset_requests
     set status = 'granted', resolved_at = now(), resolved_by = p_actor_user_id
   where id = p_request_id;

  return v_row;
end
$fn$;

revoke all on function public.admin_issue_pin_reset(uuid, text, text, uuid)
  from public, anon, authenticated;

create or replace function public.admin_reject_pin_reset(
  p_request_id    uuid,
  p_actor_user_id uuid,
  p_note          text default null
)
  returns void
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $fn$
declare
  v_caller uuid;
begin
  v_caller := public.app_current_user_id();
  if v_caller is not null and v_caller <> p_actor_user_id then
    raise exception 'SIKA_ACTOR_MISMATCH' using errcode = 'SW002';
  end if;
  if not public.is_admin(p_actor_user_id) then
    raise exception 'SIKA_ADMIN_ONLY' using errcode = 'SW001';
  end if;

  update public.pin_reset_requests
     set status = 'rejected', resolved_at = now(),
         resolved_by = p_actor_user_id, note = p_note
   where id = p_request_id and status = 'pending';
end
$fn$;

revoke all on function public.admin_reject_pin_reset(uuid, uuid, text)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Redeeming. Returns the material the Edge Function needs to verify the code
-- it was given, and nothing else.
-- ---------------------------------------------------------------------------
create or replace function public.open_grant_for_phone(p_phone text)
  returns table (
    grant_id      uuid,
    target_role   text,
    auth_user_id  uuid,
    code_hash     text,
    code_salt     text,
    attempts      integer,
    max_attempts  integer
  )
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select g.id, g.target_role, g.target_auth_user_id, g.code_hash, g.code_salt,
         g.attempts, public.pin_reset_max_attempts()
  from public.pin_reset_grants g
  left join public.vendors v on v.id = g.target_vendor_id
  left join public.customers c on c.id = g.target_customer_id
  where coalesce(v.phone, c.phone) = p_phone
    and g.consumed_at is null
    and g.expires_at > now()
    and g.attempts < public.pin_reset_max_attempts()
  order by g.issued_at desc
  limit 1
$$;

revoke all on function public.open_grant_for_phone(text)
  from public, anon, authenticated;

create or replace function public.record_grant_attempt(p_grant_id uuid)
  returns integer
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $fn$
declare
  v_n integer;
begin
  update public.pin_reset_grants
     set attempts = attempts + 1
   where id = p_grant_id
  returning attempts into v_n;
  return coalesce(v_n, 0);
end
$fn$;

revoke all on function public.record_grant_attempt(uuid)
  from public, anon, authenticated;

create or replace function public.consume_grant(
  p_grant_id uuid,
  p_ip       inet default null
)
  returns public.pin_reset_grants
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $fn$
declare
  v_row public.pin_reset_grants;
begin
  update public.pin_reset_grants
     set consumed_at = now(), consumed_ip = p_ip
   where id = p_grant_id
     and consumed_at is null
     and expires_at > now()
  returning * into v_row;

  if not found then
    raise exception 'SIKA_GRANT_NOT_CLAIMABLE' using errcode = 'SW016';
  end if;

  -- The holder chose this code themselves at redemption, so nothing further is
  -- required of them — unlike the vendor_device case, where the PIN was seen.
  return v_row;
end
$fn$;

revoke all on function public.consume_grant(uuid, inet)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The user's own record of it. Permanent and visible to them.
-- ---------------------------------------------------------------------------
create or replace function public.my_pin_resets(p_actor_user_id uuid)
  returns table (
    id          uuid,
    reset_at    timestamptz,
    libelle     text
  )
  language plpgsql
  stable
  security definer
  set search_path = public, pg_temp
as $fn$
declare
  v_caller uuid;
begin
  if p_actor_user_id is null then
    raise exception 'SIKA_ACTOR_REQUIRED' using errcode = 'SW003';
  end if;

  v_caller := public.app_current_user_id();
  if v_caller is not null and v_caller <> p_actor_user_id then
    raise exception 'SIKA_ACTOR_MISMATCH' using errcode = 'SW002';
  end if;

  return query
  select g.id, g.consumed_at,
         'Code réinitialisé par le support'::text
  from public.pin_reset_grants g
  where g.target_auth_user_id = p_actor_user_id
    and g.consumed_at is not null
  order by g.consumed_at desc
  limit 50;
end
$fn$;

revoke all on function public.my_pin_resets(uuid) from public, anon;
grant execute on function public.my_pin_resets(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- create_pending_debit, without the cooling-off.
--
-- Obsolete: it existed only to blunt the vouching attack, and vouching no
-- longer exists. Leaving it would be a rule nobody could explain.
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
