-- 0010 — Versioned PIN peppers.  (Amendment J)
--
-- The original design had a single SIKA_PIN_PEPPER. Because the stored auth
-- password is PIN+pepper, changing it would invalidate every vendor and
-- customer credential at once, with no migration path. That is an unacceptable
-- property for a credential protecting a money ledger: it means a suspected
-- pepper compromise has no remedy short of forcing every user in the country
-- to re-register.
--
-- Versioning fixes it with a lazy, per-user migration. Each row records which
-- pepper version its credential was derived under. On a SUCCESSFUL login the
-- Edge Function holds the plaintext PIN for one moment — the only moment it
-- ever legitimately does — and can therefore re-derive the credential under the
-- current pepper and bump the version, in one transaction.
--
-- No PIN, and no pepper, is ever stored in this database. Only the version
-- number lives here.

alter table public.vendors
  add column if not exists pepper_version integer not null default 1;

alter table public.customers
  add column if not exists pepper_version integer not null default 1;

do $guard$
begin
  -- A version is meaningless if it is zero or negative, and a row that somehow
  -- lost its version would silently be treated as "needs no upgrade".
  if not exists (
    select 1 from pg_constraint where conname = 'vendors_pepper_version_positive'
  ) then
    alter table public.vendors
      add constraint vendors_pepper_version_positive check (pepper_version >= 1);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'customers_pepper_version_positive'
  ) then
    alter table public.customers
      add constraint customers_pepper_version_positive check (pepper_version >= 1);
  end if;
end
$guard$;

-- Indexed because pepper retirement asks exactly one question: does any row
-- still reference the version I want to delete? That query must stay cheap as
-- the user table grows, or the answer gets guessed instead of checked.
create index if not exists vendors_pepper_version_idx
  on public.vendors (pepper_version);
create index if not exists customers_pepper_version_idx
  on public.customers (pepper_version);

-- ---------------------------------------------------------------------------
-- Retirement safety.
--
-- A pepper may only be removed from the environment once no row references its
-- version. Deleting one early does not fail loudly — it silently makes those
-- users' PINs unverifiable, which looks like "wrong PIN" to them and is
-- indistinguishable from a forgotten credential. This function is what the
-- README's retirement procedure is checked against, so the answer is read out
-- of the database rather than assumed.
-- ---------------------------------------------------------------------------
create or replace function public.pepper_version_usage()
  returns table (
    pepper_version integer,
    vendors        bigint,
    customers      bigint,
    total          bigint
  )
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  with v as (
    select pepper_version, count(*) as n from public.vendors group by pepper_version
  ),
  c as (
    select pepper_version, count(*) as n from public.customers group by pepper_version
  ),
  all_versions as (
    select pepper_version from v
    union
    select pepper_version from c
  )
  select
    a.pepper_version,
    coalesce(v.n, 0) as vendors,
    coalesce(c.n, 0) as customers,
    coalesce(v.n, 0) + coalesce(c.n, 0) as total
  from all_versions a
  left join v on v.pepper_version = a.pepper_version
  left join c on c.pepper_version = a.pepper_version
  order by a.pepper_version
$$;

-- Operational query, not a client-facing one.
revoke all on function public.pepper_version_usage() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Record a completed pepper upgrade.
--
-- Called by the login Edge Function after it has successfully re-derived the
-- credential under the current pepper. Refuses to move a version backwards:
-- a stale function instance running an older SIKA_PIN_PEPPER_CURRENT must not
-- be able to downgrade a row that a newer one already migrated, which would
-- leave the credential unverifiable by either.
-- ---------------------------------------------------------------------------
create or replace function public.record_pepper_upgrade(
  p_auth_user_id  uuid,
  p_new_version   integer,
  p_role          text
)
  returns integer
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $fn$
declare
  v_current integer;
begin
  if p_role not in ('vendor', 'customer') then
    raise exception 'SIKA_INVALID_ROLE' using errcode = 'SW007';
  end if;

  if p_new_version is null or p_new_version < 1 then
    raise exception 'SIKA_INVALID_PEPPER_VERSION' using errcode = 'SW007';
  end if;

  if p_role = 'vendor' then
    select pepper_version into v_current
    from public.vendors where auth_user_id = p_auth_user_id for update;
  else
    select pepper_version into v_current
    from public.customers where auth_user_id = p_auth_user_id for update;
  end if;

  if not found then
    raise exception 'SIKA_USER_NOT_FOUND' using errcode = 'SW008';
  end if;

  if p_new_version < v_current then
    raise exception 'SIKA_PEPPER_VERSION_REGRESSION'
      using errcode = 'SW007',
            detail = format('stored=%s attempted=%s', v_current, p_new_version);
  end if;

  if p_role = 'vendor' then
    update public.vendors set pepper_version = p_new_version
    where auth_user_id = p_auth_user_id;
  else
    update public.customers set pepper_version = p_new_version
    where auth_user_id = p_auth_user_id;
  end if;

  return p_new_version;
end
$fn$;

revoke all on function public.record_pepper_upgrade(uuid, integer, text)
  from public, anon, authenticated;
