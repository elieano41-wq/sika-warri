-- 0004 — Per-relationship customer labels.  (Forced by amendment F)
--
-- customers.display_name is global, so any vendor able to read the customer row
-- would see a name entered by a different vendor. Amendment F forbids exactly
-- that. RLS is row-level, not column-level, so suppressing one column via
-- policy is not possible.
--
-- Resolution: the name a vendor types when creating a customer inline is a
-- label private to that vendor's relationship. customers.display_name is
-- reserved for a name the customer sets for themselves after registering.
-- Vendors get no direct SELECT on customers at all (see 0006).

create table if not exists public.vendor_customer_labels (
  vendor_id    uuid not null references public.vendors(id),
  customer_id  uuid not null references public.customers(id),
  display_name text not null,
  created_at   timestamptz not null default now(),
  primary key (vendor_id, customer_id)
);
