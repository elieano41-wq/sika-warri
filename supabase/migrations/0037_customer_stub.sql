-- 0037 — Recording a debt against someone with no account.
--
-- REQUIRED, and where the risk concentrates. A vendor must be able to write down
-- that Aya owes 2 000 F whether or not Aya has ever heard of Sika Warri —
-- that is how the paper carnet works and what makes this usable on day one. A
-- register that only worked for registered customers would be a register nobody
-- used.
--
-- It also means a vendor can create a row against any phone number in Côte
-- d'Ivoire. Three things bound that, none of which makes it safe, all of which
-- make it survivable:
--
--   1. The debt itself is DÉCLARÉE and stays a claim. When that number
--      registers, everything against it surfaces for review (0032) rather than
--      becoming fact.
--   2. Stub creation is rate-limited here, separately from debt creation, so
--      loading a list of numbers is slow and visible.
--   3. Every stub a vendor creates is attributable: created_by_vendor records
--      who did it, which is what makes the déclarée share in the support panel
--      mean something.
--
-- NO NEW DISCLOSURE. The function returns a customer id whether or not the
-- number was already known, so it says nothing about existence that
-- lookup_customer_for_vendor does not already say (amendment F).

alter table public.customers
  add column if not exists created_by_vendor uuid references public.vendors(id);

comment on column public.customers.created_by_vendor is
  'The vendor who first wrote this number down, when the row was created as a '
  'stub rather than by registration. Attribution for claims made against people '
  'who never asked to be here.';

-- ---------------------------------------------------------------------------
create or replace function public.ensure_customer_for_debt(
  p_vendor_id     uuid,
  p_phone         text,
  p_actor_user_id uuid,
  p_label         text default null
)
  returns table (
    customer_id   uuid,
    is_registered boolean,
    your_label    text,
    was_created   boolean
  )
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $fn$
declare
  v_caller   uuid;
  v_msisdn   text;
  v_existant public.customers;
  v_id       uuid;
  v_recents  integer;
  v_cree     boolean := false;
  v_label    text;
begin
  if p_actor_user_id is null then
    raise exception 'SIKA_ACTOR_REQUIRED' using errcode = 'SW003';
  end if;

  v_caller := public.app_current_user_id();
  if v_caller is not null and v_caller <> p_actor_user_id then
    raise exception 'SIKA_ACTOR_MISMATCH' using errcode = 'SW002';
  end if;

  perform 1 from public.vendors v
   where v.id = p_vendor_id and v.auth_user_id = p_actor_user_id and v.is_active;
  if not found then
    raise exception 'SIKA_VENDOR_FORBIDDEN' using errcode = 'SW001';
  end if;

  -- The same normalisation the rest of the system uses. Two spellings of one
  -- number is how a person ends up with two rows and a split balance.
  v_msisdn := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  if left(v_msisdn, 3) = '225' then
    v_msisdn := substr(v_msisdn, 4);
  end if;
  if length(v_msisdn) <> 10 then
    raise exception 'SIKA_PHONE_INVALID' using errcode = 'SW007';
  end if;
  -- Ivorian mobile prefixes. A landline or a typo becomes a debt against a
  -- number that can never register and never answer.
  if left(v_msisdn, 2) not in ('01', '05', '07') then
    raise exception 'SIKA_PHONE_NOT_MOBILE' using errcode = 'SW007';
  end if;
  v_msisdn := '225' || v_msisdn;

  select * into v_existant from public.customers c where c.phone = v_msisdn;

  if found then
    v_id := v_existant.id;
  else
    -- Rate-limited separately from debt creation. Writing down a name and a
    -- number for someone standing in front of you happens a handful of times a
    -- day; loading a list happens once, fast, and this makes that slow.
    select count(*)::integer into v_recents
    from public.customers c
    where c.created_by_vendor = p_vendor_id
      and c.created_at > now() - interval '1 hour';

    if v_recents >= 20 then
      raise exception 'SIKA_STUB_RATE_LIMIT'
        using errcode = 'SW022',
              detail = format('%s nouveaux numéros dans la dernière heure', v_recents);
    end if;

    insert into public.customers (phone, display_name, created_by_vendor)
    values (v_msisdn, null, p_vendor_id)
    returning id into v_id;
    v_cree := true;
  end if;

  -- The vendor's private name for this person. Never shown to another vendor,
  -- never shown to the customer.
  if p_label is not null and btrim(p_label) <> '' then
    insert into public.vendor_customer_labels (vendor_id, customer_id, display_name)
    values (p_vendor_id, v_id, btrim(p_label))
    on conflict (vendor_id, customer_id) do update
      set display_name = excluded.display_name;
  end if;

  select l.display_name into v_label
  from public.vendor_customer_labels l
  where l.vendor_id = p_vendor_id and l.customer_id = v_id;

  return query
  select v_id,
         (select c.auth_user_id is not null from public.customers c where c.id = v_id),
         v_label,
         v_cree;
end
$fn$;

revoke all on function public.ensure_customer_for_debt(uuid, text, uuid, text)
  from public, anon;
grant execute on function public.ensure_customer_for_debt(uuid, text, uuid, text)
  to authenticated;
