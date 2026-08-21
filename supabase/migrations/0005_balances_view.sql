-- 0005 — Derived balances.
--
-- Standing rule 4: balance is always derived, never stored. There is no
-- mutable balance column anywhere that could drift from the entries.
--
-- security_invoker = true is load-bearing. Without it the view executes with
-- the privileges of its owner and would hand every caller every vendor's
-- balances, silently defeating the RLS in 0006. Stock Postgres 15+, so it
-- costs nothing in portability.

create or replace view public.v_balances
  with (security_invoker = true)
as
select
  vendor_id,
  customer_id,
  sum(case when direction = 'credit' then amount_cfa else -amount_cfa end)::integer
    as balance_cfa,
  max(created_at) as last_activity_at
from public.ledger_entries
group by vendor_id, customer_id;

grant select on public.v_balances to authenticated;
