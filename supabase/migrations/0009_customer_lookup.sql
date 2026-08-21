-- 0009 — Vendor-side customer lookup.  (Amendment F)
--
-- Phone enumeration is unavoidable: the vendor must be able to tell whether a
-- number is already known before offering to create it inline. Amendment F
-- accepts that and requires it be minimised. Two measures here:
--
--   1. Disclosure is existence only. The name returned is the label THIS
--      vendor wrote (0004). A name entered by any other vendor, and the
--      customer's own display_name, are never returned.
--   2. Lookups are rate limited per vendor, so a vendor cannot sweep the
--      number space at speed.

create table if not exists public.vendor_lookup_log (
  id           bigserial primary key,
  vendor_id    uuid not null references public.vendors(id),
  looked_up_at timestamptz not null default now()
);

create index if not exists vendor_lookup_log_vendor_at_idx
  on public.vendor_lookup_log (vendor_id, looked_up_at desc);

alter table public.vendor_lookup_log enable row level security;
revoke all on public.vendor_lookup_log from anon, authenticated;
revoke all on sequence public.vendor_lookup_log_id_seq from anon, authenticated;

-- 60 lookups per 10 minutes. A market stall serving a customer every few
-- seconds stays well inside this; a script walking 2250700000000 upward does
-- not. Tuned to be invisible to legitimate use and immediately fatal to
-- enumeration.
create or replace function public.lookup_customer_for_vendor(
  p_vendor_id     uuid,
  p_phone         text,
  p_actor_user_id uuid
)
  returns table (
    exists_in_system boolean,
    customer_id      uuid,
    your_label       text,
    has_relationship boolean
  )
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $fn$
declare
  v_caller      uuid;
  v_recent      integer;
  v_customer_id uuid;
begin
  if p_actor_user_id is null then
    raise exception 'SIKA_ACTOR_REQUIRED' using errcode = 'SW003';
  end if;

  -- Same actor guard as post_ledger_entry: an explicit actor argument, but it
  -- may not contradict a real session identity where one exists.
  v_caller := public.app_current_user_id();
  if v_caller is not null and v_caller <> p_actor_user_id then
    raise exception 'SIKA_ACTOR_MISMATCH' using errcode = 'SW002';
  end if;

  perform 1
  from public.vendors v
  where v.id = p_vendor_id
    and v.auth_user_id = p_actor_user_id
    and v.is_active;

  if not found then
    raise exception 'SIKA_VENDOR_FORBIDDEN' using errcode = 'SW001';
  end if;

  select count(*)::integer into v_recent
  from public.vendor_lookup_log l
  where l.vendor_id = p_vendor_id
    and l.looked_up_at > now() - interval '10 minutes';

  if v_recent >= 60 then
    raise exception 'SIKA_LOOKUP_RATE_LIMITED' using errcode = 'SW009';
  end if;

  insert into public.vendor_lookup_log (vendor_id) values (p_vendor_id);

  select c.id into v_customer_id
  from public.customers c
  where c.phone = p_phone;

  return query
  select
    v_customer_id is not null,
    v_customer_id,
    -- This vendor's own label only. Never customers.display_name, never
    -- another vendor's label.
    (select l.display_name
       from public.vendor_customer_labels l
      where l.vendor_id = p_vendor_id
        and l.customer_id = v_customer_id),
    exists (
      select 1 from public.ledger_entries e
      where e.vendor_id = p_vendor_id
        and e.customer_id = v_customer_id
    );
end
$fn$;

revoke all on function public.lookup_customer_for_vendor(uuid, text, uuid) from public, anon;
grant execute on function public.lookup_customer_for_vendor(uuid, text, uuid) to authenticated;
