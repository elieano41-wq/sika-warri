-- 0017 — Naming a customer, per vendor.
--
-- A phone number is useless at a counter. The vendor needs "Awa", not
-- 2250701020304, and they need it in every place they meet that customer.
--
-- vendor_customer_labels (0004) already exists for exactly this. It was built
-- because customers.display_name is global: any vendor able to read it would see
-- a name entered by a different vendor, and RLS is row-level so a single column
-- cannot be hidden by policy. So:
--
--   * customers.display_name  — the name the CUSTOMER chose for themselves.
--     Never shown to a vendor.
--   * vendor_customer_labels  — what ONE vendor privately calls them. Never
--     shown to another vendor, and never to the customer.

create or replace function public.set_vendor_customer_label(
  p_vendor_id     uuid,
  p_customer_id   uuid,
  p_label         text,
  p_actor_user_id uuid
)
  returns text
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $fn$
declare
  v_caller uuid;
  v_propre text;
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

  perform 1 from public.customers c where c.id = p_customer_id;
  if not found then
    raise exception 'SIKA_CUSTOMER_NOT_FOUND' using errcode = 'SW008';
  end if;

  v_propre := btrim(regexp_replace(coalesce(p_label, ''), '\s+', ' ', 'g'));

  -- An empty label removes it rather than storing a blank, so the UI falls back
  -- to the phone number instead of showing nothing.
  if v_propre = '' then
    delete from public.vendor_customer_labels
     where vendor_id = p_vendor_id and customer_id = p_customer_id;
    return null;
  end if;

  v_propre := left(v_propre, 60);

  insert into public.vendor_customer_labels (vendor_id, customer_id, display_name)
  values (p_vendor_id, p_customer_id, v_propre)
  on conflict (vendor_id, customer_id)
    do update set display_name = excluded.display_name;

  return v_propre;
end
$fn$;

revoke all on function public.set_vendor_customer_label(uuid, uuid, text, uuid)
  from public, anon;
grant execute on function public.set_vendor_customer_label(uuid, uuid, text, uuid)
  to authenticated;

-- ---------------------------------------------------------------------------
-- A vendor's view of one pending debit, with their own label attached.
--
-- The waiting screen showed a bare number while the customer confirmed. The
-- vendor should see the name they know.
-- ---------------------------------------------------------------------------
create or replace function public.vendor_pending_detail(
  p_pending_id    uuid,
  p_actor_user_id uuid
)
  returns table (
    id                uuid,
    customer_id       uuid,
    phone             text,
    your_label        text,
    kind              text,
    amount_cfa        integer,
    expires_at        timestamptz,
    consumed_entry_id uuid,
    cancelled_at      timestamptz
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
  select
    p.id, p.customer_id, c.phone, l.display_name,
    p.kind, p.amount_cfa, p.expires_at, p.consumed_entry_id, p.cancelled_at
  from public.pending_debits p
  join public.vendors v on v.id = p.vendor_id
  join public.customers c on c.id = p.customer_id
  left join public.vendor_customer_labels l
    on l.vendor_id = p.vendor_id and l.customer_id = p.customer_id
  where p.id = p_pending_id
    -- Only the vendor who created it. Another vendor asking gets no row at all
    -- rather than an error, which would confirm the id exists.
    and v.auth_user_id = p_actor_user_id;
end
$fn$;

revoke all on function public.vendor_pending_detail(uuid, uuid) from public, anon;
grant execute on function public.vendor_pending_detail(uuid, uuid) to authenticated;
