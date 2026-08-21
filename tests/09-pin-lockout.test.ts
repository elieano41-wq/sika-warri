// Acceptance test 9 — the 5th consecutive failed PIN attempt locks the account
// and the 4th warns.
//
// Revised from the spec's wording, which said six attempts lock and the fifth
// warns. Section 3 says "lock after 5 consecutive failed attempts" and is
// normative, so the two could not both hold. The off-by-one is resolved in
// favour of section 3.
//
// Two layers are covered here: the SQL that counts attempts, and the pure
// decision function the Edge Function uses to phrase the response. The HTTP
// handler that joins them cannot be run in CI — there is no Docker for
// `supabase functions serve` — so it is NOT claimed as tested.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { connect, reset, actAsAdmin, sqlstateOf } from './helpers/db';
import { lockoutDecision, MAX_FAILURES, LOCK_MINUTES } from '../supabase/functions/_shared/identity.ts';

let db: pg.Client;

const PHONE = '2250701020304';
const OTHER = '2250509080706';

/** Record an attempt, optionally backdated, as the Edge Function would. */
async function attempt(
  succeeded: boolean,
  opts: { phone?: string; minutesAgo?: number; ip?: string } = {}
) {
  await actAsAdmin(db);
  await db.query(
    `insert into public.auth_attempts (phone, ip, succeeded, attempted_at)
     values ($1, $2, $3, now() - make_interval(mins => $4))`,
    [opts.phone ?? PHONE, opts.ip ?? null, succeeded, opts.minutesAgo ?? 0]
  );
}

async function lockState(phone = PHONE) {
  await actAsAdmin(db);
  const { rows } = await db.query(
    'select * from public.auth_lock_state($1)',
    [phone]
  );
  return rows[0] as {
    recent_failures: number;
    is_locked: boolean;
    locked_until: Date | null;
    warn_next_locks: boolean;
  };
}

beforeAll(async () => {
  db = await connect();
});

afterAll(async () => {
  await actAsAdmin(db);
  await db.end();
});

beforeEach(async () => {
  await reset(db);
});

describe('acceptance test 9 — lockout counting in SQL', () => {
  it('a clean account is neither locked nor warned', async () => {
    const s = await lockState();
    expect(s.recent_failures).toBe(0);
    expect(s.is_locked).toBe(false);
    expect(s.warn_next_locks).toBe(false);
    expect(s.locked_until).toBeNull();
  });

  it('failures 1 to 3 neither lock nor warn', async () => {
    for (let i = 1; i <= 3; i += 1) {
      await attempt(false);
      const s = await lockState();
      expect(s.recent_failures).toBe(i);
      expect(s.is_locked).toBe(false);
      expect(s.warn_next_locks).toBe(false);
    }
  });

  it('the 4th failure WARNS but does not lock', async () => {
    for (let i = 0; i < 4; i += 1) await attempt(false);

    const s = await lockState();
    expect(s.recent_failures).toBe(4);
    expect(s.warn_next_locks).toBe(true);
    expect(s.is_locked).toBe(false);
  });

  it('the 5th failure LOCKS', async () => {
    for (let i = 0; i < 5; i += 1) await attempt(false);

    const s = await lockState();
    expect(s.recent_failures).toBe(5);
    expect(s.is_locked).toBe(true);
    expect(s.warn_next_locks).toBe(false);
    expect(s.locked_until).not.toBeNull();
  });

  it('stays locked on a 6th attempt', async () => {
    for (let i = 0; i < 6; i += 1) await attempt(false);
    const s = await lockState();
    expect(s.is_locked).toBe(true);
  });

  it('a successful login clears the slate', async () => {
    for (let i = 0; i < 4; i += 1) await attempt(false);
    expect((await lockState()).warn_next_locks).toBe(true);

    await attempt(true);
    const s = await lockState();

    // Getting the PIN right must not leave the account one slip from a lock.
    expect(s.recent_failures).toBe(0);
    expect(s.is_locked).toBe(false);
    expect(s.warn_next_locks).toBe(false);
  });

  it('one failure after a success counts as one, not five', async () => {
    for (let i = 0; i < 4; i += 1) await attempt(false);
    await attempt(true);
    await attempt(false);

    expect((await lockState()).recent_failures).toBe(1);
  });

  it('the lock lifts as failures age past the window', async () => {
    // All five failures happened over 15 minutes ago.
    for (let i = 0; i < 5; i += 1) {
      await attempt(false, { minutesAgo: LOCK_MINUTES + 5 });
    }

    const s = await lockState();
    // No unlock job and no stored flag that could get stuck: the window simply
    // slides, so the lock expires by arithmetic.
    expect(s.recent_failures).toBe(0);
    expect(s.is_locked).toBe(false);
  });

  it('still locked when the 5 failures are recent', async () => {
    for (let i = 0; i < 5; i += 1) await attempt(false, { minutesAgo: 2 });
    expect((await lockState()).is_locked).toBe(true);
  });

  it('locks per phone number, not globally', async () => {
    for (let i = 0; i < 5; i += 1) await attempt(false);

    expect((await lockState(PHONE)).is_locked).toBe(true);
    // One customer being locked out must not lock the whole market.
    expect((await lockState(OTHER)).is_locked).toBe(false);
  });

  it('counts failures per IP across different phones', async () => {
    // Per-phone counting cannot see one host working through a list of
    // numbers; this is what catches that.
    for (let i = 0; i < 12; i += 1) {
      await attempt(false, { phone: `225070000${String(i).padStart(4, '0')}`, ip: '41.66.1.1' });
    }
    await actAsAdmin(db);
    const { rows } = await db.query(
      'select public.auth_ip_failure_count($1::inet) as n',
      ['41.66.1.1']
    );
    expect(rows[0].n).toBe(12);

    const { rows: other } = await db.query(
      'select public.auth_ip_failure_count($1::inet) as n',
      ['41.66.9.9']
    );
    expect(other[0].n).toBe(0);
  });

  it('no client role may read or write the attempt log', async () => {
    // A caller who could read it could enumerate valid phone numbers; one who
    // could write it could erase evidence of a brute-force attempt.
    await actAsAdmin(db);
    await db.query('set role authenticated');

    expect(await sqlstateOf(() => db.query('select * from public.auth_attempts'))).toBe('42501');
    expect(
      await sqlstateOf(() =>
        db.query(
          `insert into public.auth_attempts (phone, succeeded) values ('225', true)`
        )
      )
    ).toBe('42501');
    expect(
      await sqlstateOf(() => db.query('select * from public.auth_lock_state($1)', [PHONE]))
    ).toBe('42501');

    await actAsAdmin(db);
  });
});

describe('acceptance test 9 — the decision the Edge Function reports', () => {
  it('locks at exactly 5, warns at exactly 4', () => {
    expect(lockoutDecision(0).locked).toBe(false);
    expect(lockoutDecision(3).warn).toBe(false);

    expect(lockoutDecision(4).warn).toBe(true);
    expect(lockoutDecision(4).locked).toBe(false);
    expect(lockoutDecision(4).attemptsLeft).toBe(1);

    expect(lockoutDecision(5).locked).toBe(true);
    expect(lockoutDecision(5).attemptsLeft).toBe(0);
  });

  it('reports the remaining attempts honestly', () => {
    expect(lockoutDecision(0).attemptsLeft).toBe(MAX_FAILURES);
    expect(lockoutDecision(2).attemptsLeft).toBe(3);
  });

  it('stays locked above the threshold rather than wrapping around', () => {
    // A negative attemptsLeft would read as "attempts remaining" to any
    // caller doing a > 0 check.
    expect(lockoutDecision(99).locked).toBe(true);
    expect(lockoutDecision(99).attemptsLeft).toBe(0);
  });

  it('tolerates nonsense input without unlocking anything', () => {
    expect(lockoutDecision(-3).locked).toBe(false);
    expect(lockoutDecision(-3).attemptsLeft).toBe(MAX_FAILURES);
    expect(lockoutDecision(4.7).warn).toBe(true); // truncates to 4
  });

  it('never mentions the PIN in any message it produces', () => {
    // Standing rule 11: a PIN never appears in a message, log or payload.
    for (const n of [0, 1, 3, 4, 5, 9]) {
      const msg = lockoutDecision(n).message ?? '';
      expect(msg).not.toMatch(/\d{4,}/); // no digit run that could be a PIN
    }
  });

  it('speaks French, as all user-facing copy must', () => {
    expect(lockoutDecision(4).message).toContain('essai');
    expect(lockoutDecision(5).message).toContain('bloqué');
  });
});
