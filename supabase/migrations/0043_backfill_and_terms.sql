-- 0043 — Give every existing account its missing half, without handing anyone a
--        capability they never agreed to.
--
-- ===========================================================================
-- WHY. 0042 made every account two rows, but only for accounts created AFTER
-- it. Everything already in the database has one half, so an existing account
-- opens the app and finds two of its four tabs saying "cette partie de votre
-- carnet n'est pas encore ouverte". That is accurate and useless.
--
-- THE TRAP THIS OPENS, AND WHY MOST OF THIS FILE IS ABOUT IT.
--
-- The vendors row is the half that KEEPS other people's money, and spec section
-- 6 requires whoever does that to have acknowledged the disclosure explicitly,
-- timestamped and stored. Before 0042 that acknowledgement was collected from
-- vendors only — the registration flow never showed the text to a customer at
-- all.
--
-- So backfilling a vendors row for every existing customer would hand a keeper
-- capability to people who have never seen the disclosure. Worse, nothing
-- anywhere enforced it: terms_accepted_at was written at registration and then
-- read by nothing, so the requirement lived entirely in one Edge Function's
-- input validation. A backfill would have walked straight past it.
--
-- This migration therefore does three things, and the second is the point:
--
--   1. Backfill the missing halves.
--   2. REFUSE keeper writes from an account that has not acknowledged, in SQL,
--      where it cannot be routed around.
--   3. Give the app a way to collect the acknowledgement later, so the refusal
--      is a door rather than a wall.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. The missing halves
-- ---------------------------------------------------------------------------

-- Customers half, for accounts that only had a vendors row.
--
-- The name carries across: the other party has always seen this account under
-- its business_name, and showing them a different word for the same person
-- because of which table the row came from would be gratuitous.
insert into public.customers (auth_user_id, phone, display_name, pepper_version)
select v.auth_user_id, v.phone, v.business_name, v.pepper_version
  from public.vendors v
 where v.auth_user_id is not null
   and not exists (
     select 1 from public.customers c where c.auth_user_id = v.auth_user_id
   )
   -- A stub may already hold this phone from somebody recording change for it
   -- before it registered. That row owns real ledger history: it is LINKED
   -- below, never duplicated, because a second row on the same phone would
   -- split one person's balance in two and the unique index would refuse it
   -- anyway.
   and not exists (
     select 1 from public.customers c where c.phone = v.phone
   );

-- The stub case, linked rather than inserted.
update public.customers c
   set auth_user_id  = v.auth_user_id,
       pepper_version = coalesce(c.pepper_version, v.pepper_version),
       display_name  = coalesce(c.display_name, v.business_name)
  from public.vendors v
 where c.phone = v.phone
   and c.auth_user_id is null
   and v.auth_user_id is not null;

-- Vendors half, for accounts that only had a customers row.
--
-- terms_accepted_at is deliberately LEFT NULL. This account has never been shown
-- the disclosure, so claiming it accepted one would be a fabricated consent
-- record — the one kind of row this schema must never contain. The refusal added
-- in section 2 is what makes leaving it null safe.
insert into public.vendors (
  auth_user_id, phone, business_name, quartier, pepper_version
)
select
  c.auth_user_id,
  c.phone,
  -- A name is NOT NULL here. Falling back to the local number is honest: it is
  -- what the other party would recognise anyway, and it is visibly a
  -- placeholder rather than an invented shop name.
  coalesce(nullif(btrim(c.display_name), ''), right(c.phone, 10)),
  null,
  c.pepper_version
  from public.customers c
 where c.auth_user_id is not null
   and not exists (
     select 1 from public.vendors v where v.auth_user_id = c.auth_user_id
   )
   and not exists (
     select 1 from public.vendors v where v.phone = c.phone
   );

-- ---------------------------------------------------------------------------
-- 2. THE REFUSAL. Keeping other people's money requires the acknowledgement.
-- ---------------------------------------------------------------------------

create or replace function public.assert_terms_accepted(p_vendor_id uuid)
  returns void
  language plpgsql
  stable
  security definer
  set search_path = public, pg_temp
as $fn$
declare
  v_ok boolean;
begin
  select terms_accepted_at is not null into v_ok
    from public.vendors where id = p_vendor_id;

  if v_ok is null then
    raise exception 'SIKA_VENDOR_FORBIDDEN' using errcode = 'SW001';
  end if;

  if not v_ok then
    raise exception 'SIKA_TERMS_NOT_ACCEPTED' using errcode = 'SW033';
  end if;
end
$fn$;

revoke all on function public.assert_terms_accepted(uuid) from public, anon, authenticated;

comment on function public.assert_terms_accepted(uuid) is
  'Refuses SW033 when this account has not acknowledged the section 6 '
  'disclosure. Called by every write that puts somebody else''s money in this '
  'account''s hands. Enforced HERE rather than in the Edge Function that '
  'collects it at registration, because 0043 creates keeper rows for accounts '
  'that never went through that flow — a requirement that lives in one input '
  'validator is a requirement a backfill walks past.';

-- ---------------------------------------------------------------------------
-- 3. The door: accept it later
-- ---------------------------------------------------------------------------

create or replace function public.accept_terms(
  p_actor_user_id uuid,
  p_version       text
)
  returns timestamptz
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $fn$
declare
  v_caller uuid;
  v_quand  timestamptz;
begin
  if p_actor_user_id is null then
    raise exception 'SIKA_ACTOR_REQUIRED' using errcode = 'SW003';
  end if;
  v_caller := public.app_current_user_id();
  if v_caller is not null and v_caller <> p_actor_user_id then
    raise exception 'SIKA_ACTOR_MISMATCH' using errcode = 'SW002';
  end if;
  if coalesce(btrim(p_version), '') = '' then
    raise exception 'SIKA_TERMS_VERSION_REQUIRED' using errcode = 'SW003';
  end if;

  -- APPEND-ONLY IN SPIRIT: an existing acknowledgement is never overwritten.
  -- Re-accepting would move the timestamp and lose when consent was actually
  -- given, and a consent record whose date can move is not a consent record.
  -- Accepting twice is therefore a no-op that returns the original moment.
  update public.vendors
     set terms_accepted_at = now(),
         terms_version     = btrim(p_version)
   where auth_user_id = p_actor_user_id
     and terms_accepted_at is null;

  select terms_accepted_at into v_quand
    from public.vendors where auth_user_id = p_actor_user_id;

  if v_quand is null then
    raise exception 'SIKA_VENDOR_FORBIDDEN' using errcode = 'SW001';
  end if;

  return v_quand;
end
$fn$;

revoke all on function public.accept_terms(uuid, text) from public, anon;
grant execute on function public.accept_terms(uuid, text) to authenticated;

comment on function public.accept_terms(uuid, text) is
  'Records the section 6 acknowledgement for the calling account, once. Never '
  'overwrites an existing one: a consent record whose date can move is not a '
  'consent record, so accepting twice returns the original moment.';

-- ---------------------------------------------------------------------------
-- 4. Wiring the refusal into the two writes that take custody
-- ---------------------------------------------------------------------------
-- Patched by rewriting the LIVE definition rather than by restating the whole
-- function here. Restating it is how SIKA_INVALID_KIND happened: the constraint
-- was widened and the function's own copy of the rule was not, because the copy
-- in the migration was written against an older body. pg_get_functiondef always
-- describes what is actually installed.
--
-- ONLY THE DIRECTION THAT TAKES CUSTODY IS GATED, and the exceptions matter more
-- than the rule:
--
--   * credit  — this account takes somebody else's money into its own hands.
--               Gated. This is what the disclosure discloses.
--   * debit   — purchase or refund. Both RELEASE custody. Gating a refund would
--               trap a customer's money behind a form its holder had not filled
--               in, which is standing rule 9 broken by paperwork.
--   * reversal — a correction. Never gated; a mistake must always be fixable.
--
-- Same logic for the debt register: 'owed' is a claim this account makes and is
-- gated; 'repaid' reduces what somebody owes and never is.

do $patch$
declare
  v_def   text;
  v_ancre text := E'    raise exception \'SIKA_VENDOR_FORBIDDEN\' using errcode = \'SW001\';\n  end if;';
  v_n     int;
begin
  -- ---- post_ledger_entry ------------------------------------------------
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'post_ledger_entry';

  if v_def is null then
    raise exception 'post_ledger_entry not found; 0043 cannot patch it';
  end if;

  v_n := (length(v_def) - length(replace(v_def, v_ancre, ''))) / length(v_ancre);
  if v_n <> 1 then
    raise exception 'expected exactly one vendor-ownership check in post_ledger_entry, found %', v_n;
  end if;

  v_def := replace(
    v_def,
    v_ancre,
    v_ancre || E'\n\n  -- 0043: taking custody requires the section 6 acknowledgement. Credits only\n  -- — a debit releases custody and a refund must never be blocked (rule 9).\n  if p_direction = \'credit\' then\n    perform public.assert_terms_accepted(p_vendor_id);\n  end if;'
  );
  execute v_def;

  -- ---- post_debt_entry --------------------------------------------------
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'post_debt_entry';

  if v_def is null then
    raise exception 'post_debt_entry not found; 0043 cannot patch it';
  end if;

  v_n := (length(v_def) - length(replace(v_def, v_ancre, ''))) / length(v_ancre);
  if v_n <> 1 then
    raise exception 'expected exactly one vendor-ownership check in post_debt_entry, found %', v_n;
  end if;

  v_def := replace(
    v_def,
    v_ancre,
    v_ancre || E'\n\n  -- 0043: claiming a debt requires the section 6 acknowledgement. \'owed\' only\n  -- — \'repaid\' reduces what somebody owes and is never blocked.\n  if p_direction = \'owed\' then\n    perform public.assert_terms_accepted(p_vendor_id);\n  end if;'
  );
  execute v_def;
end
$patch$;
