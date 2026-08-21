-- 0003 — Core tables.
--
-- Amounts are integer FCFA throughout (standing rule 5). No numeric, no float,
-- no centimes. gen_random_uuid() is core Postgres from 13 onward, so no
-- extension is required and nothing here is Supabase-specific.

create table if not exists public.vendors (
  id                        uuid primary key default gen_random_uuid(),
  auth_user_id              uuid unique not null,
  phone                     text unique not null,
  business_name             text not null,
  quartier                  text not null,
  commune                   text,
  max_balance_per_customer  integer not null default 3000
                              check (max_balance_per_customer > 0),
  is_active                 boolean not null default true,

  -- Approved addition. Section 6 requires the disclosure acknowledgement to be
  -- stored and timestamped; the original model had nowhere to put it.
  -- terms_version records WHICH wording was accepted, so a later revision of
  -- the legal text does not silently inherit consent given to the old one.
  terms_accepted_at         timestamptz,
  terms_version             text,

  created_at                timestamptz not null default now(),

  constraint vendors_terms_consistent
    check ((terms_accepted_at is null) = (terms_version is null))
);

create table if not exists public.customers (
  id            uuid primary key default gen_random_uuid(),
  -- Nullable by design: a vendor may record change for someone who has never
  -- registered. The row is linked to an auth user later, at PIN enrolment.
  auth_user_id  uuid unique,
  phone         text unique not null,
  display_name  text,
  created_at    timestamptz not null default now()
);

create table if not exists public.ledger_entries (
  id                uuid primary key default gen_random_uuid(),
  vendor_id         uuid not null references public.vendors(id),
  customer_id       uuid not null references public.customers(id),
  direction         text not null check (direction in ('credit','debit')),
  kind              text not null check (kind in ('change','purchase','refund','reversal')),
  amount_cfa        integer not null check (amount_cfa > 0),
  idempotency_key   text not null,
  reverses_entry_id uuid references public.ledger_entries(id),
  note              text,

  -- Amendment D. Every debit — purchase AND refund — requires the customer to
  -- confirm with their own PIN. Recording when that happened makes an
  -- unconfirmed debit structurally impossible rather than merely discouraged:
  -- without it a vendor could mark balances refunded without paying out.
  customer_confirmed_at timestamptz,

  created_at        timestamptz not null default now(),
  created_by        uuid not null,

  constraint ledger_entries_vendor_idem_unique unique (vendor_id, idempotency_key),

  -- Debits must carry confirmation; credits must not claim it.
  constraint ledger_entries_debit_confirmed
    check (
      (direction = 'debit'  and customer_confirmed_at is not null)
      or
      (direction = 'credit' and customer_confirmed_at is null)
    ),

  -- Only a reversal may reference another entry, and it must reference one.
  constraint ledger_entries_reversal_consistent
    check ((kind = 'reversal') = (reverses_entry_id is not null)),

  -- Direction and kind must agree. `change` is the only credit; purchase and
  -- refund are always debits. A reversal may go either way, since it inverts
  -- whatever it corrects.
  constraint ledger_entries_direction_kind_agree
    check (
      (kind = 'change'   and direction = 'credit')
      or (kind in ('purchase','refund') and direction = 'debit')
      or (kind = 'reversal')
    )
);

create index if not exists ledger_entries_vendor_customer_created_idx
  on public.ledger_entries (vendor_id, customer_id, created_at desc);

-- One reversal per reversed entry: prevents draining a balance by replaying
-- corrections against the same original.
create unique index if not exists ledger_entries_one_reversal_per_entry_idx
  on public.ledger_entries (reverses_entry_id)
  where reverses_entry_id is not null;

create table if not exists public.heartbeat (
  id        bigserial primary key,
  pinged_at timestamptz not null default now()
);
