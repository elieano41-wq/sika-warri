-- 0033 — Teach post_ledger_entry about 'compensation', and name the review
--        queue's columns.
--
-- TWO BUGS CI CAUGHT, both worth recording.
--
-- 1. SIKA_INVALID_KIND on every compensation. Migration 0029 added
--    'compensation' to the ledger_entries CHECK constraint, and
--    post_ledger_entry keeps its OWN copy of the same list. The function is the
--    one that runs, so the constraint was widened and the door stayed shut.
--
--    One rule, two places, and the copy that mattered was the one I did not
--    edit. The body below is not retyped from memory — it was extracted with
--    pg_get_functiondef from the migrations as they actually apply, so every
--    guard added in 0011, 0013 and 0014 survives, and exactly one line differs.
--    tests/30 now asserts the function's accepted kinds equal the constraint's,
--    so the two cannot drift again.
--
-- 2. "column q.register does not exist". my_review_queue wrapped a UNION ALL in
--    a subquery and then ordered by q.register, but the inner selects had no
--    column aliases — 'debt'::text names nothing. Fixed by naming them.

CREATE OR REPLACE FUNCTION public.post_ledger_entry(p_vendor_id uuid, p_customer_id uuid, p_direction text, p_kind text, p_amount_cfa integer, p_idempotency_key text, p_actor_user_id uuid, p_customer_confirmed boolean DEFAULT false, p_reverses_entry_id uuid DEFAULT NULL::uuid, p_note text DEFAULT NULL::text, p_confirmation_method text DEFAULT 'own_device'::text)
 RETURNS ledger_entries
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_caller        uuid;
  v_max           integer;
  v_balance       integer;
  v_existing      public.ledger_entries;
  v_reversed      public.ledger_entries;
  v_new           public.ledger_entries;
  v_confirmed_at  timestamptz;
  v_method        text;
  v_pin_stale     boolean;
  v_is_correction boolean;
begin
  if p_amount_cfa is null or p_amount_cfa <= 0 then
    raise exception 'SIKA_INVALID_AMOUNT' using errcode = 'SW007';
  end if;

  if p_direction is null or p_direction not in ('credit','debit') then
    raise exception 'SIKA_INVALID_DIRECTION' using errcode = 'SW007';
  end if;

  if p_kind is null or p_kind not in ('change','purchase','refund','reversal','compensation') then
    raise exception 'SIKA_INVALID_KIND' using errcode = 'SW007';
  end if;

  if p_idempotency_key is null or length(btrim(p_idempotency_key)) = 0 then
    raise exception 'SIKA_IDEMPOTENCY_KEY_REQUIRED' using errcode = 'SW007';
  end if;

  if p_actor_user_id is null then
    raise exception 'SIKA_ACTOR_REQUIRED' using errcode = 'SW003';
  end if;

  v_caller := public.app_current_user_id();
  if v_caller is not null and v_caller <> p_actor_user_id then
    raise exception 'SIKA_ACTOR_MISMATCH' using errcode = 'SW002';
  end if;

  select v.max_balance_per_customer into v_max
  from public.vendors v
  where v.id = p_vendor_id
    and v.auth_user_id = p_actor_user_id
    and v.is_active;

  if not found then
    raise exception 'SIKA_VENDOR_FORBIDDEN' using errcode = 'SW001';
  end if;

  select c.pin_change_required into v_pin_stale
  from public.customers c where c.id = p_customer_id;

  if not found then
    raise exception 'SIKA_CUSTOMER_NOT_FOUND' using errcode = 'SW008';
  end if;

  v_is_correction := (p_direction = 'debit' and p_confirmation_method = 'vendor_correction');

  if p_direction = 'debit' then
    if v_is_correction then
      if p_kind <> 'reversal' then
        raise exception 'SIKA_CORRECTION_MUST_BE_REVERSAL' using errcode = 'SW007';
      end if;
      if p_customer_confirmed is true then
        raise exception 'SIKA_CORRECTION_NOT_CUSTOMER_CONFIRMED' using errcode = 'SW007';
      end if;
      v_method       := 'vendor_correction';
      v_confirmed_at := null;
    else
      -----------------------------------------------------------------------
      -- FIX 1. A session-bound caller may not assert a customer confirmation.
      --
      -- v_caller is non-null exactly when the call arrives with a real user
      -- session (a vendor's app, via PostgREST). It is null for service role.
      -- A genuine confirmed debit is always written by an Edge Function that
      -- has verified a PIN, and that function runs as service role — so this
      -- refusal costs the legitimate path nothing and closes the forged one
      -- completely.
      -----------------------------------------------------------------------
      if v_caller is not null then
        raise exception 'SIKA_CONFIRMED_DEBIT_REQUIRES_FUNCTION'
          using errcode = 'SW014',
                detail = 'a confirmed debit must be posted by the confirm-debit '
                         'function, which verifies the customer PIN';
      end if;

      if p_customer_confirmed is not true then
        raise exception 'SIKA_CUSTOMER_CONFIRMATION_REQUIRED' using errcode = 'SW004';
      end if;

      if p_confirmation_method is null
         or p_confirmation_method not in ('own_device','vendor_device') then
        raise exception 'SIKA_INVALID_CONFIRMATION_METHOD' using errcode = 'SW007';
      end if;

      v_method       := p_confirmation_method;
      v_confirmed_at := now();

      if v_pin_stale and v_method = 'own_device' and p_kind = 'purchase' then
        raise exception 'SIKA_PIN_CHANGE_REQUIRED' using errcode = 'SW010';
      end if;
    end if;
  else
    if p_customer_confirmed is true then
      raise exception 'SIKA_CONFIRMATION_NOT_APPLICABLE' using errcode = 'SW007';
    end if;
    if p_confirmation_method = 'vendor_correction' then
      raise exception 'SIKA_CORRECTION_IS_DEBIT_ONLY' using errcode = 'SW007';
    end if;
    v_method       := null;
    v_confirmed_at := null;
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(p_vendor_id::text || ':' || p_customer_id::text, 0)
  );

  select * into v_existing
  from public.ledger_entries
  where vendor_id = p_vendor_id
    and idempotency_key = p_idempotency_key;

  if found then
    return v_existing;
  end if;

  if p_kind = 'reversal' then
    if p_reverses_entry_id is null then
      raise exception 'SIKA_REVERSAL_TARGET_REQUIRED' using errcode = 'SW007';
    end if;

    select * into v_reversed
    from public.ledger_entries
    where id = p_reverses_entry_id
      and vendor_id = p_vendor_id
      and customer_id = p_customer_id;

    if not found then
      raise exception 'SIKA_REVERSAL_TARGET_INVALID' using errcode = 'SW008';
    end if;

    if v_reversed.kind = 'reversal' then
      raise exception 'SIKA_CANNOT_REVERSE_A_REVERSAL' using errcode = 'SW008';
    end if;

    if v_reversed.amount_cfa <> p_amount_cfa then
      raise exception 'SIKA_REVERSAL_AMOUNT_MISMATCH' using errcode = 'SW008';
    end if;

    if v_reversed.direction = p_direction then
      raise exception 'SIKA_REVERSAL_DIRECTION_INVALID' using errcode = 'SW008';
    end if;

    if v_is_correction
       and v_reversed.created_at < now() - public.vendor_correction_window() then
      raise exception 'SIKA_CORRECTION_WINDOW_CLOSED'
        using errcode = 'SW013',
              detail = format('entry_created_at=%s window=%s',
                              v_reversed.created_at, public.vendor_correction_window());
    end if;
  elsif p_reverses_entry_id is not null then
    raise exception 'SIKA_ONLY_REVERSAL_MAY_REFERENCE' using errcode = 'SW007';
  end if;

  select coalesce(
           sum(case when direction = 'credit' then amount_cfa else -amount_cfa end),
           0
         )::integer
    into v_balance
  from public.ledger_entries
  where vendor_id = p_vendor_id
    and customer_id = p_customer_id;

  if p_direction = 'credit' then
    if v_balance + p_amount_cfa > v_max then
      raise exception 'SIKA_CAP_EXCEEDED'
        using errcode = 'SW005',
              detail  = format('balance=%s amount=%s cap=%s', v_balance, p_amount_cfa, v_max);
    end if;
  else
    if p_amount_cfa > v_balance then
      raise exception 'SIKA_INSUFFICIENT_BALANCE'
        using errcode = 'SW006',
              detail  = format('balance=%s amount=%s', v_balance, p_amount_cfa);
    end if;
  end if;

  begin
    insert into public.ledger_entries (
      vendor_id, customer_id, direction, kind, amount_cfa,
      idempotency_key, reverses_entry_id, note, customer_confirmed_at,
      confirmation_method, created_by
    ) values (
      p_vendor_id, p_customer_id, p_direction, p_kind, p_amount_cfa,
      p_idempotency_key, p_reverses_entry_id, p_note, v_confirmed_at,
      v_method, p_actor_user_id
    )
    returning * into v_new;
  exception
    when unique_violation then
      select * into v_existing
      from public.ledger_entries
      where vendor_id = p_vendor_id
        and idempotency_key = p_idempotency_key;

      if found then
        return v_existing;
      end if;
      raise;
  end;

  if v_method = 'vendor_device' then
    update public.customers
       set pin_change_required = true
     where id = p_customer_id
       and pin_change_required = false;
  end if;

  return v_new;
end
$function$;


-- ---------------------------------------------------------------------------
-- my_review_queue, with its inner columns named
-- ---------------------------------------------------------------------------
drop function if exists public.my_review_queue(uuid, integer);

create function public.my_review_queue(
  p_actor_user_id uuid,
  p_limit         integer default 100
)
  returns table (
    register       text,
    entry_id       uuid,
    vendor_id      uuid,
    business_name  text,
    quartier       text,
    kind           text,
    amount_cfa     integer,
    note           text,
    created_at     timestamptz,
    total_count    integer
  )
  language plpgsql
  stable
  security definer
  set search_path = public, pg_temp
as $fn$
declare
  v_caller      uuid;
  v_customer_id uuid;
  v_total       integer;
begin
  if p_actor_user_id is null then
    raise exception 'SIKA_ACTOR_REQUIRED' using errcode = 'SW003';
  end if;
  v_caller := public.app_current_user_id();
  if v_caller is not null and v_caller <> p_actor_user_id then
    raise exception 'SIKA_ACTOR_MISMATCH' using errcode = 'SW002';
  end if;

  select c.id into v_customer_id from public.customers c
   where c.auth_user_id = p_actor_user_id;
  if not found then
    raise exception 'SIKA_CUSTOMER_NOT_FOUND' using errcode = 'SW008';
  end if;

  select count(*)::integer into v_total from (
    select d.id from public.debt_entries d
     left join public.debt_reviews r on r.debt_entry_id = d.id
     where d.customer_id = v_customer_id
       and d.direction = 'owed'
       and d.customer_confirmed_at is null
       and r.id is null
    union all
    select e.id from public.ledger_entries e
     left join public.ledger_reviews lr on lr.ledger_entry_id = e.id
     where e.customer_id = v_customer_id
       and e.direction = 'credit'
       and e.customer_confirmed_at is null
       and lr.id is null
  ) t;

  return query
  select
    q.registre, q.entree, q.boutique, q.nom, q.secteur,
    q.genre, q.montant, q.remarque, q.quand, v_total
  from (
    -- The half that matters: a claim that the customer owes money.
    select
      'debt'::text     as registre,
      d.id             as entree,
      d.vendor_id      as boutique,
      v.business_name  as nom,
      v.quartier       as secteur,
      d.kind           as genre,
      d.amount_cfa     as montant,
      d.note           as remarque,
      d.created_at     as quand
    from public.debt_entries d
    join public.vendors v on v.id = d.vendor_id
    left join public.debt_reviews r on r.debt_entry_id = d.id
    where d.customer_id = v_customer_id
      and d.direction = 'owed'
      and d.customer_confirmed_at is null
      and r.id is null

    union all

    -- Included for consistency: someone reviewing what was recorded in their
    -- name before they had an account should see all of it. Disputing one of
    -- these argues the customer is owed LESS, which is against their own
    -- interest, so the risk is nil — but both ledgers behaving alike is worth
    -- more than the saved rows.
    select
      'change'::text   as registre,
      e.id             as entree,
      e.vendor_id      as boutique,
      v.business_name  as nom,
      v.quartier       as secteur,
      e.kind           as genre,
      e.amount_cfa     as montant,
      e.note           as remarque,
      e.created_at     as quand
    from public.ledger_entries e
    join public.vendors v on v.id = e.vendor_id
    left join public.ledger_reviews lr on lr.ledger_entry_id = e.id
    where e.customer_id = v_customer_id
      and e.direction = 'credit'
      and e.customer_confirmed_at is null
      and lr.id is null
  ) q
  -- Debts before change within a day: they are the ones that cost the reader
  -- money if wrong.
  order by q.quand desc, (q.registre = 'change')
  limit greatest(1, least(coalesce(p_limit, 100), 500));
end
$fn$;

revoke all on function public.my_review_queue(uuid, integer) from public, anon;
grant execute on function public.my_review_queue(uuid, integer) to authenticated;
