-- 0040 — What a vendor needs to correct their own typo.
--
-- ============================================================================
-- THE GAP THIS CLOSES. Migration 0013 gave a vendor 15 minutes to reverse their
-- own mistake unilaterally, and built v_correctable_entries to drive a screen
-- that was never written. So a vendor who typed 5000 instead of 500 in front of
-- a customer had no way out of the app: only the two-device handshake, which
-- needs the customer to still be there and to agree, or the support desk.
--
-- Mistyping an amount at a counter is the most likely thing to go wrong on day
-- one. The mechanism existed; the button did not.
-- ============================================================================
--
-- WHY THIS IS NOT JUST v_correctable_entries. That view answers "is this still
-- inside the window and unreversed". It does NOT answer the question the screen
-- actually has, which is "can this be corrected RIGHT NOW, and if not, why not".
--
-- The difference is the balance. Reversing a 5 000 F credit means posting a
-- 5 000 F debit, and post_ledger_entry refuses that if the customer has already
-- spent some of it — correctly, because clawing back change that has been used
-- would drive the balance negative. A screen that offered the button anyway
-- would fail in front of the customer, which is the exact moment this feature
-- exists to avoid.
--
-- So the reason travels with the row, and the screen can say it before anyone
-- taps anything.

drop function if exists public.vendor_recent_entries(uuid, uuid, integer);

create function public.vendor_recent_entries(
  p_vendor_id     uuid,
  p_actor_user_id uuid,
  p_limit         integer default 20
)
  returns table (
    id                uuid,
    customer_id       uuid,
    customer_phone    text,
    customer_label    text,
    direction         text,
    kind              text,
    amount_cfa        integer,
    created_at        timestamptz,
    receipt_code      text,
    -- Can it be corrected unilaterally, right now?
    correctable       boolean,
    seconds_left      integer,
    -- When it cannot: which of the four reasons, so the screen explains rather
    -- than just greying a button out.
    --   'ok'        — go ahead
    --   'expired'   — outside the 15-minute window
    --   'reversed'  — already corrected once
    --   'spent'     — the customer has used some of it; the balance no longer
    --                 covers the reversal
    --   'not_yours' — belongs to another vendor (filtered out, listed for
    --                 completeness)
    blocked_reason    text,
    total_count       integer
  )
  language plpgsql
  stable
  security definer
  set search_path = public, pg_temp
as $fn$
declare
  v_caller uuid;
  v_total  integer;
begin
  if p_actor_user_id is null then
    raise exception 'SIKA_ACTOR_REQUIRED' using errcode = 'SW003';
  end if;

  v_caller := public.app_current_user_id();
  if v_caller is not null and v_caller <> p_actor_user_id then
    raise exception 'SIKA_ACTOR_MISMATCH' using errcode = 'SW002';
  end if;

  perform 1 from public.vendors v
   where v.id = p_vendor_id and v.auth_user_id = p_actor_user_id;
  if not found then
    raise exception 'SIKA_VENDOR_FORBIDDEN' using errcode = 'SW001';
  end if;

  select count(*)::integer into v_total
  from public.ledger_entries e where e.vendor_id = p_vendor_id;

  return query
  select
    e.id, e.customer_id, c.phone, l.display_name,
    e.direction, e.kind, e.amount_cfa, e.created_at,
    public.entry_receipt_code(e.id),
    -- Correctable only when every condition holds. Computed here rather than in
    -- the screen so the button and the write agree by construction.
    (e.kind <> 'reversal'
      and r.deja is null
      and e.created_at >= now() - public.vendor_correction_window()
      and (e.direction = 'debit' or b.solde >= e.amount_cfa)),
    greatest(0, ceil(extract(epoch from (
      e.created_at + public.vendor_correction_window() - now()
    )))::integer),
    case
      when e.kind = 'reversal' then 'reversed'
      when r.deja is not null then 'reversed'
      when e.created_at < now() - public.vendor_correction_window() then 'expired'
      -- Only a CREDIT can be blocked by spending: reversing a credit posts a
      -- debit, and that debit needs the money to still be there. Reversing a
      -- debit posts a credit, which always fits.
      when e.direction = 'credit' and b.solde < e.amount_cfa then 'spent'
      else 'ok'
    end,
    v_total
  from public.ledger_entries e
  join public.customers c on c.id = e.customer_id
  left join public.vendor_customer_labels l
    on l.vendor_id = p_vendor_id and l.customer_id = e.customer_id
  left join lateral (
    select 1 as deja from public.ledger_entries x
     where x.reverses_entry_id = e.id limit 1
  ) r on true
  cross join lateral (
    select coalesce(sum(case when x.direction = 'credit'
                             then x.amount_cfa else -x.amount_cfa end), 0)::integer as solde
    from public.ledger_entries x
    where x.vendor_id = p_vendor_id and x.customer_id = e.customer_id
  ) b
  where e.vendor_id = p_vendor_id
  order by e.created_at desc, e.id desc
  limit greatest(1, least(coalesce(p_limit, 20), 100));
end
$fn$;

revoke all on function public.vendor_recent_entries(uuid, uuid, integer)
  from public, anon;
grant execute on function public.vendor_recent_entries(uuid, uuid, integer)
  to authenticated;

-- ---------------------------------------------------------------------------
-- The correction itself.
--
-- Thin on purpose: every guard already lives in post_ledger_entry, and this
-- exists so the API surface says out loud which of the reversal paths is being
-- taken. A caller cannot accidentally post a customer-confirmed reversal through
-- it, because the arguments are fixed here rather than passed in.
-- ---------------------------------------------------------------------------
create or replace function public.correct_own_entry(
  p_entry_id        uuid,
  p_actor_user_id   uuid,
  p_idempotency_key text,
  p_note            text default null
)
  returns public.ledger_entries
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $fn$
declare
  v_caller  uuid;
  v_entree  public.ledger_entries;
  v_vendeur public.vendors;
begin
  if p_actor_user_id is null then
    raise exception 'SIKA_ACTOR_REQUIRED' using errcode = 'SW003';
  end if;

  v_caller := public.app_current_user_id();
  if v_caller is not null and v_caller <> p_actor_user_id then
    raise exception 'SIKA_ACTOR_MISMATCH' using errcode = 'SW002';
  end if;

  select * into v_entree from public.ledger_entries where id = p_entry_id;
  if not found then
    raise exception 'SIKA_ENTRY_NOT_FOUND' using errcode = 'SW008';
  end if;

  -- The vendor must own the entry they are correcting. Checked here as well as
  -- by post_ledger_entry, because "correct someone else's entry" is a request
  -- worth refusing by name.
  select * into v_vendeur from public.vendors
   where id = v_entree.vendor_id and auth_user_id = p_actor_user_id;
  if not found then
    raise exception 'SIKA_VENDOR_FORBIDDEN' using errcode = 'SW001';
  end if;

  -- The reversal inverts the original: same amount, opposite direction. The
  -- exact-amount rule is what makes the unilateral window safe — if the customer
  -- has spent even one franc of a credit, the balance no longer covers this and
  -- post_ledger_entry refuses it.
  return public.post_ledger_entry(
    v_entree.vendor_id,
    v_entree.customer_id,
    case when v_entree.direction = 'credit' then 'debit' else 'credit' end,
    'reversal',
    v_entree.amount_cfa,
    p_idempotency_key,
    p_actor_user_id,
    false,
    v_entree.id,
    coalesce(p_note, 'Correction du commerçant'),
    'vendor_correction'
  );
end
$fn$;

revoke all on function public.correct_own_entry(uuid, uuid, text, text)
  from public, anon;
grant execute on function public.correct_own_entry(uuid, uuid, text, text)
  to authenticated;
