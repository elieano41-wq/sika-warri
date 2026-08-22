// A write whose response is lost, retried, produces ONE entry.
//
// ============================================================================
// THE BUG THIS PROVES FIXED, and the reason 482 tests never touched it.
//
// Standing rule 8 says every write carries an idempotency key. Every write did.
// The key was generated with crypto.randomUUID() INSIDE each submit handler, so
// it was fresh on every attempt — satisfying the rule in letter and defeating it
// exactly where it exists to help:
//
//   1. The vendor taps Enregistrer.
//   2. The request reaches the server. The entry is written. The response is lost
//      on the way back — a market signal dropping for two seconds, which is the
//      normal case at a stall, not an edge case.
//   3. The app says "Pas de connexion". True, and it cannot know whether the
//      write landed, because it never heard.
//   4. The vendor taps again. New key. SECOND entry.
//
// The customer ends up holding 1 000 F where 500 F was recorded, and nothing on
// either side reports a problem.
//
// Every existing test called the write once, or called it twice with the same
// key deliberately. Neither shape is the failure. The failure is a RETRY OF THE
// SAME USER ACTION, and to test it you have to lose the response — not assume
// what losing it would have done.
// ============================================================================
//
// So these tests wrap post_ledger_entry and post_debt_entry in a transport that
// really does throw AFTER the statement has committed, then retry the way the
// screen retries, and count rows.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import {
  connect, reset, actAs, actAsAdmin, seedVendor, seedCustomer,
  balanceOf, debtOf, entryCount, debtEntryCount, randomUUID,
  type SeededVendor, type SeededCustomer,
} from './helpers/db';

let db: pg.Client;
let vendor: SeededVendor;
let client: SeededCustomer;

beforeAll(async () => { db = await connect(); });
afterAll(async () => { await actAsAdmin(db); await db.end(); });

beforeEach(async () => {
  await reset(db);
  vendor = await seedVendor(db, { cap: 100000 });
  client = await seedCustomer(db);
});

/**
 * A write whose response never arrives.
 *
 * The statement is sent and COMMITS. Then the caller is told the connection
 * failed — which is what a dropped response is, from the client's point of view:
 * indistinguishable from a request that never arrived, and that ambiguity is the
 * whole problem.
 */
async function ecritureReponsePerdue(sql: string, params: unknown[]): Promise<never> {
  await db.query(sql, params);
  throw Object.assign(new Error('socket hang up'), { code: 'OFFLINE' });
}

// ---------------------------------------------------------------------------
// The change ledger
// ---------------------------------------------------------------------------

describe('a change credit whose response is lost', () => {
  const SQL = `select * from public.post_ledger_entry(
    $1::uuid, $2::uuid, 'credit', 'change', $3::integer, $4::text,
    $5::uuid, false, null, null, 'own_device')`;

  it('writes ONE entry when the vendor retries with the SAME key', async () => {
    // What the screen does now: one key per transaction, reused on retry.
    await actAsAdmin(db);
    const cle = randomUUID();
    const params = [vendor.id, client.id, 500, cle, vendor.authUserId];

    // Attempt one: it lands, the vendor sees an error.
    await expect(ecritureReponsePerdue(SQL, params)).rejects.toThrow();
    // The vendor taps again. Same key, because the key belongs to the
    // transaction and not to the attempt.
    const { rows } = await db.query(SQL, params);

    expect(await entryCount(db)).toBe(1);
    expect(await balanceOf(db, vendor.id, client.id)).toBe(500);
    // And the retry returns the ORIGINAL entry, so the receipt code the vendor
    // reads out is the one that exists.
    expect(rows[0].amount_cfa).toBe(500);
  });

  it('writes TWO entries with a fresh key — the bug, demonstrated', async () => {
    // The old behaviour, reproduced deliberately. This is what a per-attempt key
    // did on exactly the same sequence of events, and it is why the fix is a fix
    // rather than a tidy-up.
    await actAsAdmin(db);
    const base = [vendor.id, client.id, 500];

    await expect(
      ecritureReponsePerdue(SQL, [...base, randomUUID(), vendor.authUserId])
    ).rejects.toThrow();
    await db.query(SQL, [...base, randomUUID(), vendor.authUserId]);

    expect(await entryCount(db)).toBe(2);
    // The customer holds double what the vendor recorded, silently.
    expect(await balanceOf(db, vendor.id, client.id)).toBe(1000);
  });

  it('survives three lost responses in a row', async () => {
    // A bad signal does not fail once politely. The key has to hold across
    // however many attempts the vendor makes.
    await actAsAdmin(db);
    const params = [vendor.id, client.id, 750, randomUUID(), vendor.authUserId];

    for (let i = 0; i < 3; i += 1) {
      await expect(ecritureReponsePerdue(SQL, params)).rejects.toThrow();
    }
    await db.query(SQL, params);

    expect(await entryCount(db)).toBe(1);
    expect(await balanceOf(db, vendor.id, client.id)).toBe(750);
  });

  it('a DIFFERENT amount on the same key returns the original, not a new entry', async () => {
    // The deliberate consequence, stated so nobody is surprised by it. If a
    // vendor corrects 500 to 5000 before the first attempt lands, the server
    // returns the 500 entry. That is visibly wrong on screen and correctable;
    // a silent double-write is neither.
    await actAsAdmin(db);
    const cle = randomUUID();

    await db.query(SQL, [vendor.id, client.id, 500, cle, vendor.authUserId]);
    const { rows } = await db.query(SQL, [vendor.id, client.id, 5000, cle, vendor.authUserId]);

    expect(rows[0].amount_cfa).toBe(500);
    expect(await entryCount(db)).toBe(1);
    expect(await balanceOf(db, vendor.id, client.id)).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// The debt register — where a double write earns the vendor money
// ---------------------------------------------------------------------------

describe('a declared debt whose response is lost', () => {
  const SQL = `select * from public.declare_debt(
    $1::uuid, $2::uuid, $3::integer, $4::text, $5::uuid, null)`;

  it('writes ONE debt when the vendor retries with the same key', async () => {
    await actAs(db, vendor.authUserId);
    const params = [vendor.id, client.id, 2000, randomUUID(), vendor.authUserId];

    await expect(ecritureReponsePerdue(SQL, params)).rejects.toThrow();
    await db.query(SQL, params);

    expect(await debtEntryCount(db)).toBe(1);
    expect(await debtOf(db, vendor.id, client.id)).toBe(2000);
  });

  it('would have doubled the debt with a fresh key', async () => {
    // Worse here than on the change ledger. A doubled credit means the vendor
    // owes more than they should; a doubled DEBT means the customer owes more
    // than they agreed, and the fraud model says that is the direction where a
    // mistake profits the person who made it.
    await actAs(db, vendor.authUserId);

    await expect(
      ecritureReponsePerdue(SQL, [vendor.id, client.id, 2000, randomUUID(), vendor.authUserId])
    ).rejects.toThrow();
    await db.query(SQL, [vendor.id, client.id, 2000, randomUUID(), vendor.authUserId]);

    expect(await debtOf(db, vendor.id, client.id)).toBe(4000);
  });

  it('a settlement whose response is lost is not applied twice', async () => {
    // The mirror case, and the one that costs the VENDOR: a doubled settlement
    // writes off money that was never paid.
    await actAs(db, vendor.authUserId);
    await db.query(SQL, [vendor.id, client.id, 3000, randomUUID(), vendor.authUserId]);

    const REGLE = `select * from public.settle_debt(
      $1::uuid, $2::uuid, $3::integer, $4::text, $5::uuid, null)`;
    const params = [vendor.id, client.id, 1000, randomUUID(), vendor.authUserId];

    await expect(ecritureReponsePerdue(REGLE, params)).rejects.toThrow();
    await db.query(REGLE, params);

    expect(await debtOf(db, vendor.id, client.id)).toBe(2000);
  });
});

// ---------------------------------------------------------------------------
// The screens actually behave this way
// ---------------------------------------------------------------------------

describe('no screen mints a key per attempt', () => {
  const SRC = path.join(process.cwd(), 'src');

  function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]
    );
  }

  const fichiers = walk(SRC).filter((f) => /\.tsx?$/.test(f));

  it('found source files, so the scan below is not vacuous', () => {
    // See tests/32: an empty collection satisfies every assertion made about it.
    expect(fichiers.length).toBeGreaterThan(10);
  });

  it('randomUUID is never called inline as an idempotency key', () => {
    // The exact shape of the bug. A key generated in the argument list is a key
    // that changes on retry.
    const coupables = fichiers
      .filter((f) =>
        /idempotencyKey:\s*crypto\.randomUUID\(\)/.test(
          readFileSync(f, 'utf8').replace(/\r\n/g, '\n')
        )
      )
      .map((f) => path.relative(process.cwd(), f));

    expect(coupables).toEqual([]);
  });

  it('every screen that writes uses the held key', () => {
    const ecrivains = fichiers.filter((f) =>
      /idempotencyKey:/.test(readFileSync(f, 'utf8').replace(/\r\n/g, '\n'))
    );
    expect(ecrivains.length).toBeGreaterThan(0);

    for (const f of ecrivains) {
      const src = readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
      expect(src, `${path.relative(process.cwd(), f)} does not hold a key`).toMatch(
        /useIdempotence/
      );
      expect(src).toMatch(/idempotencyKey:\s*cleIdem\(\)/);
    }
  });

  it('the key is cleared only after a confirmed write', () => {
    // Held across a SUCCESS, the next transaction would replay the previous one
    // and the vendor would be shown an old entry for a new amount. Both halves
    // matter.
    const ecrivains = fichiers.filter((f) =>
      /idempotencyKey:\s*cleIdem\(\)/.test(readFileSync(f, 'utf8').replace(/\r\n/g, '\n'))
    );
    for (const f of ecrivains) {
      const src = readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
      expect(src, `${path.relative(process.cwd(), f)} never clears its key`).toMatch(
        /idemFait\(\)/
      );
    }
  });

  it('the helper cannot be made to return a new key while one is held', () => {
    const src = readFileSync(
      path.join(SRC, 'lib', 'idempotence.ts'), 'utf8'
    ).replace(/\r\n/g, '\n');
    // A ref, not state: a re-render must not mint a new key mid-transaction.
    expect(src).toMatch(/useRef/);
    expect(src).toMatch(/if \(cleRef\.current === null\)/);
  });
});
