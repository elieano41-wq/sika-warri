-- 0029 — The debt register: tables, constraints, RLS.
--
-- ============================================================================
-- THE FRAUD MODEL INVERTS HERE. Read this before changing anything below.
-- ============================================================================
--
-- Every write in ledger_entries assumes the vendor LOSES money by lying. A
-- fabricated change credit means the vendor owes a customer money they never
-- held, so credits need no confirmation and a vendor recording one is acting
-- against their own interest. That assumption is load-bearing throughout the
-- ledger.
--
-- It is FALSE for debt. A fabricated debt EARNS the vendor money. So debt
-- creation is the highest-risk write in the system and carries the STRONGEST
-- confirmation, not the weakest — the exact opposite of the ledger.
--
-- Three consequences, all structural rather than procedural:
--
--   1. SEPARATE TABLE, not a direction on ledger_entries. If debts lived in the
--      ledger, any sum(case when direction...) anywhere would silently net 500 F
--      of change against 2 000 F of debt into −1 500 F — recreating the negative
--      balance standing rule 2 forbids, in a place nobody would look. Two
--      registers side by side means netting requires a deliberate join that a
--      test can forbid.
--
--   2. vendor_device IS NOT IN THE ENUM. Not discouraged, not checked at the
--      application layer — absent. A vendor typing the customer's own PIN on the
--      vendor's phone can mint a debt from nothing, which is the single most
--      dangerous action available in this product. confirmation_method for a debt
--      is 'own_device' or 'declared'. There is no third value to pass.
--
--   3. CONFIRMÉE vs DÉCLARÉE IS DERIVED, NEVER STORED AS MUTABLE STATE. A
--      declared debt that the customer later accepts does not have a column
--      flipped — that would break append-only. A row is written to debt_reviews,
--      and the state is derived from its presence. Rule 3 and rule 4 both hold.

-- ---------------------------------------------------------------------------
-- The per-customer debt cap
-- ---------------------------------------------------------------------------
alter table public.vendors
  add column if not exists max_debt_per_customer integer not null default 10000;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'vendors_debt_cap_sane'
  ) then
    alter table public.vendors
      add constraint vendors_debt_cap_sane check (max_debt_per_customer >= 0);
  end if;
end
$$;

comment on column public.vendors.max_debt_per_customer is
  'Ceiling on what one customer may owe this vendor. Default 10 000 F. A cap does '
  'not make a fabricated debt honest; it bounds how much one dishonest vendor can '
  'claim against one person.';

-- ---------------------------------------------------------------------------
-- debt_entries — append-only, mirroring ledger_entries in shape and nothing else
-- ---------------------------------------------------------------------------
create table if not exists public.debt_entries (
  id                uuid primary key default gen_random_uuid(),
  vendor_id         uuid not null references public.vendors(id),
  customer_id       uuid not null references public.customers(id),

  -- 'owed'   — the customer owes MORE. The dangerous direction.
  -- 'repaid' — the customer owes LESS. Settlement, write-off, compensation.
  direction         text not null check (direction in ('owed', 'repaid')),

  kind              text not null check (
                      kind in ('debt', 'settlement', 'cancellation',
                               'compensation', 'reversal')),

  amount_cfa        integer not null check (amount_cfa > 0),
  idempotency_key   text not null,
  reverses_entry_id uuid references public.debt_entries(id),
  note              text,

  -- THE ENUM IS THE ENFORCEMENT. 'vendor_device' is not a value here and must
  -- never be added: see the header.
  confirmation_method text not null check (
                        confirmation_method in ('own_device', 'declared')),

  -- Set at INSERT only, never updated. A debt confirmed later gets a
  -- debt_reviews row instead, so this column always means "confirmed at the
  -- moment it was created".
  customer_confirmed_at timestamptz,

  created_at        timestamptz not null default now(),
  created_by        uuid not null,

  -- Direction follows from kind, so a settlement cannot be recorded as
  -- something the customer owes more of.
  constraint debt_entries_direction_matches_kind check (
    (kind = 'debt' and direction = 'owed')
    or (kind in ('settlement', 'cancellation', 'compensation') and direction = 'repaid')
    -- A reversal inverts whatever it reverses, so it may go either way.
    or (kind = 'reversal')
  ),

  constraint debt_entries_reversal_consistent
    check ((kind = 'reversal') = (reverses_entry_id is not null)),

  -- own_device means someone confirmed, so there is a time it happened.
  -- declared means nobody did, so there is not.
  constraint debt_entries_confirmation_consistent check (
    (confirmation_method = 'own_device') = (customer_confirmed_at is not null)
  ),

  -- A compensation moves money between two registers. It can only ever be
  -- something the customer agreed to on their own device.
  constraint debt_entries_compensation_is_confirmed check (
    kind <> 'compensation' or confirmation_method = 'own_device'
  )
);

create unique index if not exists debt_entries_idempotency_idx
  on public.debt_entries (vendor_id, idempotency_key);

-- One reversal per entry: otherwise a debt could be repaid twice by replaying
-- the correction, or a repayment cancelled twice to inflate the debt.
create unique index if not exists debt_entries_one_reversal_per_entry_idx
  on public.debt_entries (reverses_entry_id)
  where reverses_entry_id is not null;

create index if not exists debt_entries_pair_idx
  on public.debt_entries (vendor_id, customer_id, created_at desc);

create index if not exists debt_entries_customer_idx
  on public.debt_entries (customer_id, created_at desc);

-- Finding what still needs review is the hot path at first login.
create index if not exists debt_entries_unconfirmed_idx
  on public.debt_entries (customer_id)
  where customer_confirmed_at is null;

comment on table public.debt_entries is
  'What customers owe vendors. SEPARATE from ledger_entries so the two can never '
  'be netted into a single figure. Append-only: settlement and cancellation are '
  'new rows, never deletions or updates.';

-- ---------------------------------------------------------------------------
-- debt_reviews — the customer's verdict on a claim
--
-- This is what turns DÉCLARÉE into CONFIRMÉE or DISPUTÉE without mutating the
-- entry. One decision per entry: a customer who disputes has said so, and a
-- vendor must not be able to talk them round into flipping it repeatedly. If a
-- dispute was a mistake, the vendor cancels the entry and records it again.
-- ---------------------------------------------------------------------------
create table if not exists public.debt_reviews (
  id            uuid primary key default gen_random_uuid(),
  debt_entry_id uuid not null unique references public.debt_entries(id),
  decision      text not null check (decision in ('accepted', 'disputed')),
  -- Free text from the customer. Shown to the vendor and to the admin panel.
  reason        text,
  decided_at    timestamptz not null default now(),
  -- The customer's auth user. Never a vendor: a vendor reviewing their own claim
  -- would be the whole fraud, so the write function checks this.
  decided_by    uuid not null
);

create index if not exists debt_reviews_disputed_idx
  on public.debt_reviews (decided_at desc)
  where decision = 'disputed';

-- ---------------------------------------------------------------------------
-- ledger_reviews — the same treatment for unconfirmed CHANGE entries
--
-- Change credits carry no confirmation by design, because a vendor recording one
-- is acting against their own interest. But a customer registering with a number
-- that already has entries against it should be able to review everything
-- recorded in their name, not just the half that was dangerous. Both ledgers
-- behave the same way at first login.
-- ---------------------------------------------------------------------------
create table if not exists public.ledger_reviews (
  id              uuid primary key default gen_random_uuid(),
  ledger_entry_id uuid not null unique references public.ledger_entries(id),
  decision        text not null check (decision in ('accepted', 'disputed')),
  reason          text,
  decided_at      timestamptz not null default now(),
  decided_by      uuid not null
);

create index if not exists ledger_reviews_disputed_idx
  on public.ledger_reviews (decided_at desc)
  where decision = 'disputed';

-- ---------------------------------------------------------------------------
-- pending_debts — the two-device handshake for CREATING a debt
--
-- A separate table from pending_debits, deliberately. Each pending table maps to
-- exactly ONE outcome, so a customer who confirms a debt cannot have that
-- confirmation redirected into a ledger debit, or the reverse. Given that a
-- fabricated debt earns the vendor money, "the confirmation can only do the
-- thing it was shown for" is worth a table.
--
-- 180 seconds, matching pending_debits: long enough to hand a phone over, short
-- enough that a proposal cannot sit around waiting to be confirmed by accident.
-- ---------------------------------------------------------------------------
create table if not exists public.pending_debts (
  id                uuid primary key default gen_random_uuid(),
  vendor_id         uuid not null references public.vendors(id),
  customer_id       uuid not null references public.customers(id),
  amount_cfa        integer not null check (amount_cfa > 0),
  note              text,
  idempotency_key   text not null,
  created_at        timestamptz not null default now(),
  created_by        uuid not null,
  expires_at        timestamptz not null,
  consumed_at       timestamptz,
  consumed_entry_id uuid references public.debt_entries(id),
  cancelled_at      timestamptz,

  constraint pending_debts_consumed_consistent
    check ((consumed_at is null) = (consumed_entry_id is null))
);

create unique index if not exists pending_debts_idempotency_idx
  on public.pending_debts (vendor_id, idempotency_key);

-- At most one live proposal per pair. Without it a vendor could queue several
-- and a customer confirming once would not know which.
create unique index if not exists pending_debts_one_live_idx
  on public.pending_debts (vendor_id, customer_id)
  where consumed_at is null and cancelled_at is null;

create index if not exists pending_debts_customer_idx
  on public.pending_debts (customer_id, expires_at desc);

-- ---------------------------------------------------------------------------
-- pending_compensations — the handshake for offsetting change against debt
--
-- Its own table for the same reason: one pending table, one outcome. Confirming
-- this writes a ledger debit AND a debt repayment AND the compensations row that
-- ties them together, all or nothing.
-- ---------------------------------------------------------------------------
create table if not exists public.pending_compensations (
  id                uuid primary key default gen_random_uuid(),
  vendor_id         uuid not null references public.vendors(id),
  customer_id       uuid not null references public.customers(id),
  amount_cfa        integer not null check (amount_cfa > 0),
  idempotency_key   text not null,
  created_at        timestamptz not null default now(),
  created_by        uuid not null,
  expires_at        timestamptz not null,
  consumed_at       timestamptz,
  cancelled_at      timestamptz
);

create unique index if not exists pending_compensations_idempotency_idx
  on public.pending_compensations (vendor_id, idempotency_key);

create unique index if not exists pending_compensations_one_live_idx
  on public.pending_compensations (vendor_id, customer_id)
  where consumed_at is null and cancelled_at is null;

-- ---------------------------------------------------------------------------
-- compensations — the paired write, traceable from either side
--
-- Both foreign keys are NOT NULL and UNIQUE. That is the whole design: a
-- compensation cannot exist with only one leg, the same ledger entry cannot be
-- offset twice, and either side of the pair can be found from the other. No
-- automatic offsetting exists anywhere in this schema; this row is the only
-- thing that connects the two registers, and it is written only on an explicit
-- customer confirmation.
-- ---------------------------------------------------------------------------
create table if not exists public.compensations (
  id              uuid primary key default gen_random_uuid(),
  vendor_id       uuid not null references public.vendors(id),
  customer_id     uuid not null references public.customers(id),
  amount_cfa      integer not null check (amount_cfa > 0),
  ledger_entry_id uuid not null unique references public.ledger_entries(id),
  debt_entry_id   uuid not null unique references public.debt_entries(id),
  created_at      timestamptz not null default now(),
  confirmed_at    timestamptz not null
);

create index if not exists compensations_pair_idx
  on public.compensations (vendor_id, customer_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 'compensation' as a ledger kind
--
-- The change side of a compensation is a debit like any other, so it goes
-- through post_ledger_entry and needs customer confirmation. It gets its own kind
-- rather than being filed as a purchase, because "you spent this" and "this was
-- used to settle what you owe me" are different events and a customer reading
-- their history must be able to tell them apart.
-- ---------------------------------------------------------------------------
alter table public.ledger_entries
  drop constraint if exists ledger_entries_kind_check;

alter table public.ledger_entries
  add constraint ledger_entries_kind_check
  check (kind in ('change', 'purchase', 'refund', 'reversal', 'compensation'));

-- The existing direction/kind rule has to learn about it too: a compensation
-- reduces the change the customer holds, so it is always a debit.
alter table public.ledger_entries
  drop constraint if exists ledger_entries_direction_kind;

do $$
declare
  v_nom text;
begin
  -- The original constraint name differs by migration history, so find whichever
  -- one encodes the direction/kind rule rather than guessing.
  select conname into v_nom
  from pg_constraint
  where conrelid = 'public.ledger_entries'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) like '%direction%kind%'
    and conname <> 'ledger_entries_kind_check'
  limit 1;

  if v_nom is not null then
    execute format('alter table public.ledger_entries drop constraint %I', v_nom);
  end if;
end
$$;

alter table public.ledger_entries
  add constraint ledger_entries_direction_kind check (
    (kind = 'change'       and direction = 'credit')
    or (kind = 'purchase'  and direction = 'debit')
    or (kind = 'refund'    and direction = 'debit')
    or (kind = 'compensation' and direction = 'debit')
    or (kind = 'reversal')
  );

-- ---------------------------------------------------------------------------
-- Row level security
--
-- Same shape as ledger_entries: nobody writes through a policy. Every write goes
-- through a SECURITY DEFINER function that applies the guards, so the policies
-- here grant SELECT only and INSERT/UPDATE/DELETE are revoked outright.
-- ---------------------------------------------------------------------------
alter table public.debt_entries          enable row level security;
alter table public.debt_reviews          enable row level security;
alter table public.ledger_reviews        enable row level security;
alter table public.pending_debts         enable row level security;
alter table public.pending_compensations enable row level security;
alter table public.compensations         enable row level security;

-- A vendor sees the debts they are owed. A customer sees the debts they owe.
-- NOBODY sees a debt belonging to a pair they are not part of — see the hard
-- rule: debtor information is never visible across vendors, because sharing it
-- would make this a credit reference agency.
drop policy if exists debt_entries_vendor_select on public.debt_entries;
create policy debt_entries_vendor_select on public.debt_entries
  for select to authenticated
  using (vendor_id = public.app_current_vendor_id());

drop policy if exists debt_entries_customer_select on public.debt_entries;
create policy debt_entries_customer_select on public.debt_entries
  for select to authenticated
  using (customer_id = public.app_current_customer_id());

drop policy if exists debt_reviews_select on public.debt_reviews;
create policy debt_reviews_select on public.debt_reviews
  for select to authenticated
  using (
    exists (
      select 1 from public.debt_entries e
      where e.id = debt_reviews.debt_entry_id
        and (e.vendor_id = public.app_current_vendor_id()
             or e.customer_id = public.app_current_customer_id())
    )
  );

drop policy if exists ledger_reviews_select on public.ledger_reviews;
create policy ledger_reviews_select on public.ledger_reviews
  for select to authenticated
  using (
    exists (
      select 1 from public.ledger_entries e
      where e.id = ledger_reviews.ledger_entry_id
        and (e.vendor_id = public.app_current_vendor_id()
             or e.customer_id = public.app_current_customer_id())
    )
  );

drop policy if exists pending_debts_vendor_select on public.pending_debts;
create policy pending_debts_vendor_select on public.pending_debts
  for select to authenticated
  using (vendor_id = public.app_current_vendor_id());

drop policy if exists pending_debts_customer_select on public.pending_debts;
create policy pending_debts_customer_select on public.pending_debts
  for select to authenticated
  using (customer_id = public.app_current_customer_id());

drop policy if exists pending_comp_vendor_select on public.pending_compensations;
create policy pending_comp_vendor_select on public.pending_compensations
  for select to authenticated
  using (vendor_id = public.app_current_vendor_id());

drop policy if exists pending_comp_customer_select on public.pending_compensations;
create policy pending_comp_customer_select on public.pending_compensations
  for select to authenticated
  using (customer_id = public.app_current_customer_id());

drop policy if exists compensations_select on public.compensations;
create policy compensations_select on public.compensations
  for select to authenticated
  using (
    vendor_id = public.app_current_vendor_id()
    or customer_id = public.app_current_customer_id()
  );

-- No client role writes to any of these, ever. The guards live in functions.
revoke insert, update, delete on public.debt_entries          from anon, authenticated;
revoke insert, update, delete on public.debt_reviews          from anon, authenticated;
revoke insert, update, delete on public.ledger_reviews        from anon, authenticated;
revoke insert, update, delete on public.pending_debts         from anon, authenticated;
revoke insert, update, delete on public.pending_compensations from anon, authenticated;
revoke insert, update, delete on public.compensations         from anon, authenticated;

grant select on public.debt_entries          to authenticated;
grant select on public.debt_reviews          to authenticated;
grant select on public.ledger_reviews        to authenticated;
grant select on public.pending_debts         to authenticated;
grant select on public.pending_compensations to authenticated;
grant select on public.compensations         to authenticated;

-- ---------------------------------------------------------------------------
-- No UPDATE or DELETE on the debt ledger, for anyone routed through a policy.
--
-- Belt and braces alongside the revokes: acceptance test 6 for the debt
-- register. Settlement and cancellation are new rows.
-- ---------------------------------------------------------------------------
create or replace function public.debt_entries_are_append_only()
  returns trigger
  language plpgsql
as $fn$
begin
  raise exception 'SIKA_DEBT_APPEND_ONLY' using errcode = 'SW019';
end
$fn$;

drop trigger if exists debt_entries_no_update on public.debt_entries;
create trigger debt_entries_no_update
  before update or delete on public.debt_entries
  for each row execute function public.debt_entries_are_append_only();
