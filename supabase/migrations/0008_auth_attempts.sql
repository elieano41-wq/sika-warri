-- 0008 — Login attempt tracking.  (Approved addition)
--
-- Section 3 requires lockout after consecutive failures plus rate limiting per
-- phone and per IP. The original data model had nowhere to record an attempt.
--
-- Standing rule 11: a PIN never appears here. This table records THAT an
-- attempt happened and whether it succeeded, never what was tried.

create table if not exists public.auth_attempts (
  id           bigserial primary key,
  phone        text not null,
  ip           inet,
  succeeded    boolean not null,
  attempted_at timestamptz not null default now()
);

create index if not exists auth_attempts_phone_at_idx
  on public.auth_attempts (phone, attempted_at desc);

create index if not exists auth_attempts_ip_at_idx
  on public.auth_attempts (ip, attempted_at desc)
  where ip is not null;

-- Only Edge Functions touch this table, as service role. No client role gets
-- any privilege on it: a caller able to read it could enumerate valid phones,
-- and one able to write it could erase evidence of a brute-force attempt.
alter table public.auth_attempts enable row level security;
revoke all on public.auth_attempts from anon, authenticated;
revoke all on sequence public.auth_attempts_id_seq from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Lock state for a phone number.
--
-- Resolution of the spec contradiction: section 3 is normative, so the lock
-- lands on the 5th consecutive failure and the 4th failure warns. Acceptance
-- test 9 said six, which was an off-by-one; the test follows section 3.
--
-- The window slides. Counting only failures inside the last 15 minutes means
-- the lock expires on its own as attempts age out, with no unlock job and no
-- stored lock flag that could get stuck. Failures before the last successful
-- login never count, so a correct PIN always clears the slate.
-- ---------------------------------------------------------------------------
create or replace function public.auth_lock_state(p_phone text)
  returns table (
    recent_failures    integer,
    is_locked          boolean,
    locked_until       timestamptz,
    warn_next_locks    boolean
  )
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  with recent as (
    select a.attempted_at
    from public.auth_attempts a
    where a.phone = p_phone
      and not a.succeeded
      and a.attempted_at > now() - interval '15 minutes'
      and a.attempted_at > (
        select coalesce(max(s.attempted_at), '-infinity'::timestamptz)
        from public.auth_attempts s
        where s.phone = p_phone and s.succeeded
      )
    order by a.attempted_at desc
    limit 5
  )
  select
    count(*)::integer,
    count(*) >= 5,
    case when count(*) >= 5 then min(attempted_at) + interval '15 minutes' end,
    count(*) = 4
  from recent
$$;

-- Per-IP velocity, independent of which phone was targeted. Stops one host
-- working through a list of numbers, which per-phone counting cannot see.
create or replace function public.auth_ip_failure_count(
  p_ip     inet,
  p_window interval default interval '15 minutes'
)
  returns integer
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select count(*)::integer
  from public.auth_attempts a
  where a.ip = p_ip
    and not a.succeeded
    and a.attempted_at > now() - p_window
$$;

revoke all on function public.auth_lock_state(text) from public, anon, authenticated;
revoke all on function public.auth_ip_failure_count(inet, interval) from public, anon, authenticated;
