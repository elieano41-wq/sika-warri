-- 0042 — One account. Both sides of every carnet, for everybody.
--
-- ===========================================================================
-- WHAT WAS WRONG. The app had two kinds of account, and which one you picked at
-- signup decided what you were allowed to write down. Only a "vendor" could
-- record a debt owed to them. So a tailor owed 6 000 F, or somebody who lent to
-- a friend, had no way to write it down without opening a business-shaped
-- account they did not recognise as theirs. The role picker asked a question
-- nobody at a counter thinks in terms of, and answered it wrongly either way.
--
-- WHAT THE SPLIT ACTUALLY WAS. Not a design: the shadow of one constant. A
-- vendor PIN was 6 digits and a customer's was 4, the auth password is derived
-- from the PIN, so one identity could not hold two — and register/index.ts
-- refused the second role outright. Unify the PIN length and the split has no
-- reason left to exist.
--
-- WHY THE LEDGER DOES NOT MOVE. It was already symmetric. ledger_entries and
-- debt_entries are keyed on (vendor_id, customer_id) with nothing anywhere
-- saying one identity may not be the vendor in one pair and the customer in
-- another. Both auth_user_id columns are SEPARATELY unique, so one person
-- holding one row in each table has always been legal. Every RLS policy, every
-- constraint and every invariant test keeps its exact meaning.
--
-- AND THE FRAUD MODEL GETS SIMPLER. It used to be two rules that both named a
-- role: a credit needs no confirmation because a VENDOR loses money by lying; a
-- debt needs the strongest confirmation because a VENDOR earns money by lying.
-- Those are one rule that names nobody:
--
--     A liability you declare about YOURSELF needs no confirmation.
--     A claim you make against SOMEBODY ELSE needs theirs.
--
-- Same SQL. It just stopped depending on which account type you signed up as.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. The neighbourhood stops being mandatory
-- ---------------------------------------------------------------------------
-- It was NOT NULL because it was a shop's address and a shop has one. For
-- somebody keeping a note of what a neighbour owes, it is a field they do not
-- have an answer to standing in a doorway, and a required field with no answer
-- is where a signup ends.
--
-- Kept as a column, and still asked for, because it is what lets the other
-- party recognise a name they only half remember.
alter table public.vendors alter column quartier drop not null;

comment on column public.vendors.quartier is
  'Optional since 0042. Was required when this table only held shops.';

comment on column public.vendors.business_name is
  'The name other people see. Not necessarily a business: since 0042 every '
  'account has a row here, so this is "Chez Awa" for a shop and "Awa" for a '
  'person keeping track of what a neighbour owes.';

comment on table public.vendors is
  'One row per account, holding the side of it that KEEPS: change kept for '
  'other people, and debts other people owe. Since 0042 every account has one, '
  'alongside its customers row. The table name is historical — renaming it '
  'would rewrite every policy, function and index in the schema to say the same '
  'thing, and rule 3 makes a ledger migration the last place to want churn.';

comment on table public.customers is
  'One row per account, holding the side of it that IS KEPT FOR: change other '
  'people hold, and debts this account owes. Since 0042 every account has one, '
  'alongside its vendors row. Rows with a null auth_user_id are still stubs '
  'somebody created inline while recording change for an unregistered number.';

-- ---------------------------------------------------------------------------
-- 1b. WHY a code has to change
-- ---------------------------------------------------------------------------
-- pin_change_required has meant exactly one thing since 0011: somebody typed
-- their code on another person's phone, so it has been seen. 0042 gives it a
-- second cause — an account still carrying a 4-digit code from before there was
-- one PIN length — and those two need very different sentences.
--
-- "Your code has been seen by someone else" is a security warning. "Your code is
-- four digits and codes are six now" is housekeeping. Showing the security
-- warning to somebody whose code was never seen cries wolf; showing the
-- housekeeping line to somebody whose code WAS seen loses the only warning they
-- get. A flag that cannot tell you why is a flag that has to guess.
alter table public.customers
  add column if not exists pin_change_reason text
    check (pin_change_reason is null
           or pin_change_reason in ('vendor_device', 'legacy_length'));

comment on column public.customers.pin_change_reason is
  'Why pin_change_required is set, so the banner can say the true thing. '
  'vendor_device: the code was typed on somebody else''s phone and has been '
  'seen. legacy_length: a 4-digit code from before 0042 made every code six. '
  'Null when no change is pending.';

-- Existing flags all predate 0042, so every one of them is the original cause.
-- Backfilled rather than left null: null would render the weaker sentence to
-- people who need the stronger one.
update public.customers
   set pin_change_reason = 'vendor_device'
 where pin_change_required and pin_change_reason is null;

-- ---------------------------------------------------------------------------
-- 2. Debts I OWE, aggregated — the mirror of vendor_debt_summary
-- ---------------------------------------------------------------------------
-- The one figure of the four that had no aggregate, because under two account
-- types nobody needed it: a customer was never shown a total of what they owed
-- across counterparties, only a per-shop position.
--
-- It is legitimate as ONE number, and this is worth being precise about, since
-- rule 1 forbids the mirror-image total. What other people hold FOR me cannot be
-- summed, because 500 F at Awa's and 500 F at Koffi's is not 1 000 F I can
-- spend anywhere. What I OWE can be summed, because it is a single fact about
-- me: money I have to find. Nobody is being told they can spend it.
--
-- Deliberately mirrors vendor_debt_summary's arithmetic line for line, down to
-- delegating the state to debt_entry_state(). One rule, one place — tests/30
-- compares them.
create function public.customer_debt_summary(
  p_customer_id   uuid,
  p_actor_user_id uuid
)
  returns table (
    debt_cfa        integer,
    creditors       integer,
    confirmed_cfa   integer,
    declared_cfa    integer,
    disputed_cfa    integer,
    disputed_count  integer,
    oldest_debt_at  timestamptz
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
  perform 1 from public.customers c
   where c.id = p_customer_id and c.auth_user_id = p_actor_user_id;
  if not found then
    raise exception 'SIKA_CUSTOMER_NOT_FOUND' using errcode = 'SW008';
  end if;

  return query
  select
    coalesce(sum(greatest(s.dette, 0)), 0)::integer,
    count(*) filter (where s.dette > 0)::integer,
    coalesce(sum(s.confirmee), 0)::integer,
    coalesce(sum(s.declaree), 0)::integer,
    coalesce(sum(s.contestee), 0)::integer,
    coalesce(sum(s.nb_contestees), 0)::integer,
    min(s.plus_ancienne)
  from (
    select
      sum(case when d.direction = 'owed' then d.amount_cfa else -d.amount_cfa end)::integer as dette,
      coalesce(sum(case when d.direction = 'owed'
        and public.debt_entry_state(d.customer_confirmed_at, r.decision) = 'confirmed'
        then d.amount_cfa else 0 end), 0)::integer as confirmee,
      coalesce(sum(case when d.direction = 'owed'
        and public.debt_entry_state(d.customer_confirmed_at, r.decision) = 'declared'
        then d.amount_cfa else 0 end), 0)::integer as declaree,
      coalesce(sum(case when d.direction = 'owed'
        and public.debt_entry_state(d.customer_confirmed_at, r.decision) = 'disputed'
        then d.amount_cfa else 0 end), 0)::integer as contestee,
      count(*) filter (where r.decision = 'disputed')::integer as nb_contestees,
      min(case when d.direction = 'owed' then d.created_at end) as plus_ancienne
    from public.debt_entries d
    left join public.debt_reviews r on r.debt_entry_id = d.id
    where d.customer_id = p_customer_id
    group by d.vendor_id
  ) s;
end
$fn$;

revoke all on function public.customer_debt_summary(uuid, uuid) from public, anon;
grant execute on function public.customer_debt_summary(uuid, uuid) to authenticated;

comment on function public.customer_debt_summary(uuid, uuid) is
  'Total this account owes, across everyone it owes. Legitimate as one figure '
  'because it is one fact about the caller: money they have to find. The '
  'mirror-image total — what others hold FOR them — is NOT legitimate and has '
  'no function, because rule 1 makes it unspendable and therefore misleading.';

-- ---------------------------------------------------------------------------
-- 3. All four registers, from one call
-- ---------------------------------------------------------------------------
-- THE HOME SCREEN IS A 2x2 and it must not be assembled from four round trips
-- that can each land in a different state. One row, one point in time.
--
-- It DELEGATES rather than recomputing: every figure comes from the function
-- that already owned it, so there is exactly one place each is defined and the
-- headline can never disagree with the list underneath it.
--
--                     I OWE                     OWED TO ME
--   change   garde_cfa  (aggregated)     garde_pour_moi_cfa  (informational)
--   debt     je_dois_cfa                on_me_doit_cfa
--
-- garde_pour_moi_cfa is returned but is NOT a spendable figure: rule 1 means it
-- cannot be spent anywhere in particular. It is carried so the screen can say
-- "you have money in four carnets" and send the reader to the list, which is
-- the only honest place for it.
create function public.account_summary(p_actor_user_id uuid)
  returns table (
    -- what I owe
    garde_cfa            integer,   -- change I am holding for other people
    garde_personnes      integer,
    je_dois_cfa          integer,   -- debts I owe
    je_dois_creanciers   integer,
    -- what I am owed
    garde_pour_moi_cfa   integer,   -- change others hold for me. NOT spendable.
    garde_pour_moi_carnets integer,
    on_me_doit_cfa       integer,   -- debts owed to me
    on_me_doit_debiteurs integer,
    on_me_doit_vieux_cfa integer,   -- of which, past 30 days
    -- housekeeping
    reclamations_ouvertes integer,
    a_verifier            integer   -- claims made in my name awaiting my answer
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
  v_gar         record;
  v_dette_a_moi record;
  v_gar_moi     record;
  v_je_dois     record;
  v_vieux       integer := 0;
  v_reclam      integer := 0;
  v_verif       integer := 0;
begin
  if p_actor_user_id is null then
    raise exception 'SIKA_ACTOR_REQUIRED' using errcode = 'SW003';
  end if;
  v_caller := public.app_current_user_id();
  if v_caller is not null and v_caller <> p_actor_user_id then
    raise exception 'SIKA_ACTOR_MISMATCH' using errcode = 'SW002';
  end if;

  select v.id into v_vendor_id
    from public.vendors v where v.auth_user_id = p_actor_user_id;
  select c.id into v_customer_id
    from public.customers c where c.auth_user_id = p_actor_user_id;

  -- An account created before 0042 has only one of the two halves. It reads as
  -- zeros on the missing side rather than failing: the figures are honest (there
  -- is genuinely nothing there) and a half-migrated account must still be able
  -- to open its own home screen.
  if v_vendor_id is null and v_customer_id is null then
    raise exception 'SIKA_ACCOUNT_NOT_FOUND' using errcode = 'SW008';
  end if;

  if v_vendor_id is not null then
    select * into v_gar
      from public.vendor_home_summary(v_vendor_id, p_actor_user_id);

    -- The 0036 signature, not the 0032 one: it already carries over_30_cfa and
    -- open_claims. Recomputing either here would have given this screen its own
    -- private definition of "past 30 days", and two definitions of an ageing
    -- threshold is how a home screen and a list come to disagree about the same
    -- debt.
    select * into v_dette_a_moi
      from public.vendor_debt_summary(v_vendor_id, p_actor_user_id);

    v_vieux  := coalesce(v_dette_a_moi.over_30_cfa, 0);
    v_reclam := coalesce(v_dette_a_moi.open_claims, 0);
  end if;

  if v_customer_id is not null then
    select * into v_gar_moi
      from public.customer_summary(p_actor_user_id);
    select * into v_je_dois
      from public.customer_debt_summary(v_customer_id, p_actor_user_id);

    -- Anything asserted about me that I have not answered. The one number on
    -- this screen that is about somebody else's word, so it is counted, never
    -- summed into a register.
    select count(*)::integer into v_verif
      from public.debt_entries d
      left join public.debt_reviews r on r.debt_entry_id = d.id
     where d.customer_id = v_customer_id
       and d.customer_confirmed_at is null
       and r.decision is null
       and d.direction = 'owed';
  end if;

  return query select
    coalesce(v_gar.circulation_cfa, 0)::integer,
    coalesce(v_gar.customers_owed, 0)::integer,
    coalesce(v_je_dois.debt_cfa, 0)::integer,
    coalesce(v_je_dois.creditors, 0)::integer,
    coalesce(v_gar_moi.total_cfa, 0)::integer,
    coalesce(v_gar_moi.shop_count, 0)::integer,
    coalesce(v_dette_a_moi.debt_cfa, 0)::integer,
    coalesce(v_dette_a_moi.debtors, 0)::integer,
    v_vieux,
    v_reclam,
    v_verif;
end
$fn$;

revoke all on function public.account_summary(uuid) from public, anon;
grant execute on function public.account_summary(uuid) to authenticated;

comment on function public.account_summary(uuid) is
  'All four registers in one row, for the 2x2 home screen. Delegates every '
  'figure to the function that already owned it, so no number is defined twice '
  'and the headline cannot disagree with the list. NOTHING here is netted: '
  'garde_cfa and je_dois_cfa are both money the caller owes and are still '
  'returned separately, because change and debt are two registers and their sum '
  'is not a thing anyone can act on.';
