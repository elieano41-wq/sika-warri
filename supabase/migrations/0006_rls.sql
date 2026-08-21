-- 0006 — Row Level Security.
--
-- This file is the legal position expressed as code. Standing rule 1: a
-- balance exists for a (customer, vendor) pair and there is no path by which
-- one vendor observes another's. Enforced structurally here, not in the client.

-- Resolving "which vendor am I" inside a policy would re-enter the policy on
-- vendors and recurse. These helpers are SECURITY DEFINER so the lookup itself
-- is not subject to RLS. They expose only the caller's own id, nothing more.
create or replace function public.app_current_vendor_id()
  returns uuid
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select v.id from public.vendors v
  where v.auth_user_id = public.app_current_user_id()
$$;

create or replace function public.app_current_customer_id()
  returns uuid
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select c.id from public.customers c
  where c.auth_user_id = public.app_current_user_id()
$$;

grant execute on function public.app_current_vendor_id() to authenticated;
grant execute on function public.app_current_customer_id() to authenticated;

alter table public.vendors                 enable row level security;
alter table public.customers               enable row level security;
alter table public.ledger_entries          enable row level security;
alter table public.vendor_customer_labels  enable row level security;

-- ---------------------------------------------------------------------------
-- vendors: a vendor sees only their own record.
-- ---------------------------------------------------------------------------
drop policy if exists vendors_select_own on public.vendors;
create policy vendors_select_own on public.vendors
  for select to authenticated
  using (auth_user_id = public.app_current_user_id());

-- ---------------------------------------------------------------------------
-- customers: only the customer themself. Vendors deliberately get NO policy
-- and therefore no direct read (amendment F) — a vendor reading the row would
-- see display_name set by some other vendor's relationship. Vendor-side
-- customer information is served by the functions in 0009, which disclose
-- only what that vendor is entitled to.
-- ---------------------------------------------------------------------------
drop policy if exists customers_select_self on public.customers;
create policy customers_select_self on public.customers
  for select to authenticated
  using (auth_user_id = public.app_current_user_id());

-- ---------------------------------------------------------------------------
-- vendor_customer_labels: each vendor sees only labels they wrote.
-- ---------------------------------------------------------------------------
drop policy if exists vcl_select_own on public.vendor_customer_labels;
create policy vcl_select_own on public.vendor_customer_labels
  for select to authenticated
  using (vendor_id = public.app_current_vendor_id());

-- ---------------------------------------------------------------------------
-- ledger_entries: readable by the vendor who owns it or the customer it
-- concerns. Never by anyone else.
-- ---------------------------------------------------------------------------
drop policy if exists ledger_select_own_side on public.ledger_entries;
create policy ledger_select_own_side on public.ledger_entries
  for select to authenticated
  using (
    vendor_id = public.app_current_vendor_id()
    or customer_id = public.app_current_customer_id()
  );

-- ---------------------------------------------------------------------------
-- Privileges. Standing rule 3: the ledger is append-only and corrections are
-- new reversing entries.
--
-- Note the belt and braces: no UPDATE/DELETE policy exists, AND the privilege
-- itself is revoked. Either alone would suffice today, but a future migration
-- that adds a permissive policy by mistake still cannot grant a privilege the
-- role does not hold. INSERT is revoked too — the RPC in 0007 is the only
-- write path, and it is SECURITY DEFINER so it does not need the caller to
-- hold the privilege.
-- ---------------------------------------------------------------------------
revoke all on public.ledger_entries from anon, authenticated;
grant select on public.ledger_entries to authenticated;
revoke insert, update, delete, truncate on public.ledger_entries from authenticated;

revoke all on public.vendors                from anon, authenticated;
grant select on public.vendors              to authenticated;

revoke all on public.customers              from anon, authenticated;
grant select on public.customers            to authenticated;

revoke all on public.vendor_customer_labels from anon, authenticated;
grant select on public.vendor_customer_labels to authenticated;

-- Reversals must never be reachable by mutating history.
revoke update, delete on public.vendors   from authenticated;
revoke update, delete on public.customers from authenticated;
