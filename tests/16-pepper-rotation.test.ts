// Acceptance test 16 — a user created under V1 logs in after V2 becomes
// current, and their pepper_version is 2 afterwards.  (Amendment J)
//
// SCOPE, STATED HONESTLY. This covers the two halves that can be tested here:
//
//   1. The derivation and version-selection logic (pure functions).
//   2. The database bookkeeping that records a completed upgrade.
//
// The middle step — actually re-writing the credential through Supabase Auth's
// admin API — cannot be exercised in CI. It needs a live Supabase project, and
// Edge Functions cannot be served locally without Docker. So the full
// login-triggers-rehash round trip is NOT proven by this file. What is proven is
// that the inputs and the outputs of that step behave correctly.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import {
  connect,
  reset,
  actAsAdmin,
  seedVendor,
  seedCustomer,
  sqlstateOf,
  randomUUID,
} from './helpers/db';
import {
  derivePassword,
  readPepperSet,
  pepperFor,
  needsPepperUpgrade,
} from '../supabase/functions/_shared/identity.ts';

let db: pg.Client;

const ENV_V1_ONLY = {
  SIKA_PIN_PEPPER_CURRENT: 'V1',
  SIKA_PIN_PEPPER_V1: 'pepper-one-aaaaaaaaaaaaaaaaaaaa',
};

const ENV_V2_CURRENT = {
  SIKA_PIN_PEPPER_CURRENT: 'V2',
  SIKA_PIN_PEPPER_V1: 'pepper-one-aaaaaaaaaaaaaaaaaaaa',
  SIKA_PIN_PEPPER_V2: 'pepper-two-bbbbbbbbbbbbbbbbbbbb',
};

async function versionOf(role: 'vendor' | 'customer', authUserId: string) {
  await actAsAdmin(db);
  const table = role === 'vendor' ? 'vendors' : 'customers';
  const { rows } = await db.query(
    `select pepper_version from public.${table} where auth_user_id = $1`,
    [authUserId]
  );
  return rows[0]?.pepper_version as number | undefined;
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

describe('acceptance test 16 — pepper rotation, database bookkeeping', () => {
  it('a customer starts on version 1', async () => {
    const c = await seedCustomer(db);
    expect(await versionOf('customer', c.authUserId!)).toBe(1);
  });

  it('records the upgrade to version 2', async () => {
    const c = await seedCustomer(db);
    await actAsAdmin(db);

    const { rows } = await db.query(
      'select public.record_pepper_upgrade($1::uuid, $2::integer, $3::text) as v',
      [c.authUserId, 2, 'customer']
    );

    expect(rows[0].v).toBe(2);
    // This is the assertion acceptance test 16 asks for.
    expect(await versionOf('customer', c.authUserId!)).toBe(2);
  });

  it('records the upgrade for a vendor too', async () => {
    const v = await seedVendor(db);
    await actAsAdmin(db);
    await db.query(
      'select public.record_pepper_upgrade($1::uuid, $2::integer, $3::text)',
      [v.authUserId, 3, 'vendor']
    );
    expect(await versionOf('vendor', v.authUserId)).toBe(3);
  });

  it('refuses to move a version BACKWARDS', async () => {
    const c = await seedCustomer(db);
    await actAsAdmin(db);
    await db.query(
      'select public.record_pepper_upgrade($1::uuid, 2, $2::text)',
      [c.authUserId, 'customer']
    );

    // A stale function instance still running an older CURRENT must not
    // downgrade a row a newer one already migrated — that would leave the
    // credential unverifiable by either version.
    const code = await sqlstateOf(() =>
      db.query('select public.record_pepper_upgrade($1::uuid, 1, $2::text)', [
        c.authUserId,
        'customer',
      ])
    );

    expect(code).toBe('SW007');
    expect(await versionOf('customer', c.authUserId!)).toBe(2);
  });

  it('re-recording the same version is harmless', async () => {
    const c = await seedCustomer(db);
    await actAsAdmin(db);
    await db.query('select public.record_pepper_upgrade($1::uuid, 2, $2::text)', [
      c.authUserId, 'customer',
    ]);
    await db.query('select public.record_pepper_upgrade($1::uuid, 2, $2::text)', [
      c.authUserId, 'customer',
    ]);
    expect(await versionOf('customer', c.authUserId!)).toBe(2);
  });

  it('rejects an unknown user rather than silently doing nothing', async () => {
    await actAsAdmin(db);
    const code = await sqlstateOf(() =>
      db.query('select public.record_pepper_upgrade($1::uuid, 2, $2::text)', [
        randomUUID(),
        'customer',
      ])
    );
    expect(code).toBe('SW008');
  });

  it('rejects a bad role and a bad version', async () => {
    const c = await seedCustomer(db);
    await actAsAdmin(db);

    expect(
      await sqlstateOf(() =>
        db.query('select public.record_pepper_upgrade($1::uuid, 2, $2::text)', [
          c.authUserId, 'admin',
        ])
      )
    ).toBe('SW007');

    expect(
      await sqlstateOf(() =>
        db.query('select public.record_pepper_upgrade($1::uuid, 0, $2::text)', [
          c.authUserId, 'customer',
        ])
      )
    ).toBe('SW007');
  });

  it('no client role may call it', async () => {
    const c = await seedCustomer(db);
    await actAsAdmin(db);
    await db.query('set role authenticated');

    const code = await sqlstateOf(() =>
      db.query('select public.record_pepper_upgrade($1::uuid, 2, $2::text)', [
        c.authUserId, 'customer',
      ])
    );
    expect(code).toBe('42501');
    await actAsAdmin(db);
  });

  it('reports which versions are still in use, for safe retirement', async () => {
    const a = await seedCustomer(db);
    await seedCustomer(db);
    const v = await seedVendor(db);
    await actAsAdmin(db);
    await db.query('select public.record_pepper_upgrade($1::uuid, 2, $2::text)', [
      a.authUserId, 'customer',
    ]);
    await db.query('select public.record_pepper_upgrade($1::uuid, 2, $2::text)', [
      v.authUserId, 'vendor',
    ]);

    const { rows } = await db.query('select * from public.pepper_version_usage()');
    const byVersion = new Map(rows.map((r) => [r.pepper_version, r]));

    // V1 still has one customer, so V1 may NOT be retired yet.
    expect(Number(byVersion.get(1)!.total)).toBe(1);
    expect(Number(byVersion.get(2)!.total)).toBe(2);
  });
});

describe('acceptance test 16 — derivation and version selection', () => {
  it('reads a single-version environment', () => {
    const set = readPepperSet(ENV_V1_ONLY);
    expect(set.current).toBe(1);
    expect(pepperFor(set, 1)).toBe(ENV_V1_ONLY.SIKA_PIN_PEPPER_V1);
  });

  it('reads a rotated environment and keeps the OLD pepper available', () => {
    const set = readPepperSet(ENV_V2_CURRENT);
    expect(set.current).toBe(2);
    // Keeping V1 is the whole mechanism: users still on it must be able to log
    // in, which is the only moment their credential can be upgraded.
    expect(pepperFor(set, 1)).toBe(ENV_V2_CURRENT.SIKA_PIN_PEPPER_V1);
    expect(pepperFor(set, 2)).toBe(ENV_V2_CURRENT.SIKA_PIN_PEPPER_V2);
  });

  it('accepts V1, v1 and 1 for CURRENT, since a human types it', () => {
    for (const raw of ['V1', 'v1', '1']) {
      expect(readPepperSet({ ...ENV_V1_ONLY, SIKA_PIN_PEPPER_CURRENT: raw }).current).toBe(1);
    }
  });

  it('fails loudly when CURRENT names a pepper that is not set', () => {
    // Standing rule 6. Silently falling back to V1 here would quietly issue
    // credentials under a pepper the operator believes is retired.
    expect(() =>
      readPepperSet({ SIKA_PIN_PEPPER_CURRENT: 'V2', SIKA_PIN_PEPPER_V1: 'x' })
    ).toThrow(/SIKA_PIN_PEPPER_V2 is not set/);
  });

  it('fails loudly when CURRENT is missing or nonsense', () => {
    expect(() => readPepperSet({ SIKA_PIN_PEPPER_V1: 'x' })).toThrow(
      /Missing SIKA_PIN_PEPPER_CURRENT/
    );
    expect(() =>
      readPepperSet({ SIKA_PIN_PEPPER_CURRENT: 'latest', SIKA_PIN_PEPPER_V1: 'x' })
    ).toThrow(/must name a version/);
  });

  it('names the problem when a still-referenced pepper was retired', () => {
    const set = readPepperSet(ENV_V2_CURRENT);
    // Must never surface as "wrong PIN", which is indistinguishable from a
    // forgotten one and would send the user to re-register for nothing.
    expect(() => pepperFor(set, 7)).toThrow(/No pepper configured for version 7/);
    expect(() => pepperFor(set, 7)).toThrow(/pepper_version_usage/);
  });

  it('knows who needs upgrading', () => {
    const set = readPepperSet(ENV_V2_CURRENT);
    expect(needsPepperUpgrade(set, 1)).toBe(true);
    expect(needsPepperUpgrade(set, 2)).toBe(false);
    expect(needsPepperUpgrade(set, 3)).toBe(false);
  });

  it('the same PIN yields DIFFERENT credentials under V1 and V2', async () => {
    const set = readPepperSet(ENV_V2_CURRENT);
    const under1 = await derivePassword('4821', pepperFor(set, 1), 1);
    const under2 = await derivePassword('4821', pepperFor(set, 2), 2);

    // If these matched, rotation would be a relabelling rather than a genuine
    // change of credential, and a leaked pepper would stay useful forever.
    expect(under1).not.toBe(under2);
    expect(under1.startsWith('sw1_')).toBe(true);
    expect(under2.startsWith('sw2_')).toBe(true);
  });

  it('is deterministic — the same inputs always give the same credential', async () => {
    const a = await derivePassword('4821', 'pep', 1);
    const b = await derivePassword('4821', 'pep', 1);
    expect(a).toBe(b);
  });

  it('never contains the PIN', async () => {
    // Standing rule 11.
    const pin = '481623';
    const pw = await derivePassword(pin, 'pepper-value-here', 1);
    expect(pw).not.toContain(pin);
    expect(pw).toMatch(/^sw1_[0-9a-f]{64}$/);
  });

  it('different PINs give different credentials', async () => {
    expect(await derivePassword('1357', 'pep', 1)).not.toBe(
      await derivePassword('1358', 'pep', 1)
    );
  });

  it('refuses to derive without a pepper', async () => {
    // An empty pepper would produce a valid-looking credential derived from
    // nothing, making every account trivially forgeable.
    await expect(derivePassword('4821', '', 1)).rejects.toThrow(/Missing pepper/);
    await expect(derivePassword('4821', '   ', 1)).rejects.toThrow(/Missing pepper/);
  });

  it('refuses a nonsense version', async () => {
    await expect(derivePassword('4821', 'pep', 0)).rejects.toThrow(/Invalid pepper version/);
    await expect(derivePassword('4821', 'pep', 1.5)).rejects.toThrow(/Invalid pepper version/);
  });
});
