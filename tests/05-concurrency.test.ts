// Acceptance test 5 — two concurrent debits against the same balance cannot
// both succeed.
//
// This is the test that justifies amendment A. Without the advisory lock both
// transactions read the same pre-debit balance, both find it sufficient, and
// both commit — the balance goes negative and the vendor has handed over goods
// twice for change held once. Postgres READ COMMITTED does not prevent this on
// its own, because there is no row being updated for it to detect a conflict
// on: the balance is an aggregate over rows that are only ever inserted.
//
// Each call runs inside an explicit transaction. That matters — the lock is
// transaction-scoped, so in autocommit the two statements would serialise
// naturally and the test would pass without proving anything.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import {
  connect,
  reset,
  actAsAdmin,
  seedVendor,
  seedCustomer,
  giveCredit,
  entryCount,
  balanceOf,
  randomUUID,
  type SeededVendor,
  type SeededCustomer,
} from './helpers/db';

let db: pg.Client;
let c1: pg.Client;
let c2: pg.Client;
let vendor: SeededVendor;
let customer: SeededCustomer;

/** Call the RPC on a specific connection, returning either the row or the code. */
async function tryDebit(
  client: pg.Client,
  vendorId: string,
  customerId: string,
  amount: number,
  actorUserId: string
): Promise<{ ok: true; id: string } | { ok: false; code: string }> {
  try {
    const { rows } = await client.query(
      `select * from public.post_ledger_entry(
         $1::uuid, $2::uuid, 'debit', 'purchase', $3::integer, $4::text,
         $5::uuid, true, null::uuid, null::text)`,
      [vendorId, customerId, amount, randomUUID(), actorUserId]
    );
    return { ok: true, id: rows[0].id };
  } catch (err) {
    return { ok: false, code: (err as { code?: string }).code ?? 'UNKNOWN' };
  }
}

beforeAll(async () => {
  db = await connect();
  c1 = await connect();
  c2 = await connect();
});

afterAll(async () => {
  await actAsAdmin(db);
  await db.end();
  await c1.end();
  await c2.end();
});

beforeEach(async () => {
  await reset(db);
  vendor = await seedVendor(db);
  customer = await seedCustomer(db);
  await giveCredit(db, vendor, customer, 1000);
});

describe('acceptance test 5 — concurrent debits serialise', () => {
  it('two overlapping debits of 700 against 1000: exactly one succeeds', async () => {
    await c1.query('begin');
    await c2.query('begin');

    // c1 takes the pair lock and holds it for the rest of its transaction.
    const first = await tryDebit(c1, vendor.id, customer.id, 700, vendor.authUserId);
    expect(first.ok).toBe(true);

    // c2 now blocks inside pg_advisory_xact_lock. Do not await it yet.
    const secondPromise = tryDebit(c2, vendor.id, customer.id, 700, vendor.authUserId);

    // Give the second connection a moment to actually reach the lock, so this
    // is a real contention window rather than a sequence.
    await new Promise((r) => setTimeout(r, 250));

    await c1.query('commit');

    // Released, c2 recomputes against the committed balance of 300 and refuses.
    const second = await secondPromise;
    await c2.query('commit');

    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe('SW006'); // insufficient balance

    expect(await balanceOf(db, vendor.id, customer.id)).toBe(300);
    expect(await entryCount(db)).toBe(2); // the credit and one debit
  });

  it('the balance never goes negative under contention', async () => {
    // Ten connections each trying to take 200 from 1000. At most five can
    // succeed, and the balance must land on exactly zero or above — never below.
    const clients = await Promise.all(Array.from({ length: 10 }, () => connect()));

    try {
      const results = await Promise.all(
        clients.map((c) =>
          tryDebit(c, vendor.id, customer.id, 200, vendor.authUserId)
        )
      );

      const succeeded = results.filter((r) => r.ok).length;
      const balance = await balanceOf(db, vendor.id, customer.id);

      expect(succeeded).toBe(5);
      expect(balance).toBe(0);
      expect(balance).toBeGreaterThanOrEqual(0); // rule 2, stated explicitly

      // Every rejection must be the specific named error, not a deadlock or a
      // serialisation failure surfacing as something generic.
      for (const r of results) {
        if (!r.ok) expect(r.code).toBe('SW006');
      }
    } finally {
      await Promise.all(clients.map((c) => c.end()));
    }
  });

  it('debits to different customers do not block each other', async () => {
    // The lock is per (vendor, customer). One customer's transaction must not
    // stall the queue at a busy stall — that would make the app unusable.
    const other = await seedCustomer(db);
    await giveCredit(db, vendor, other, 1000);

    await c1.query('begin');
    const a = await tryDebit(c1, vendor.id, customer.id, 500, vendor.authUserId);
    expect(a.ok).toBe(true);

    // Different pair, so this must complete while c1 still holds its lock.
    await c2.query('begin');
    const b = await tryDebit(c2, vendor.id, other.id, 500, vendor.authUserId);
    expect(b.ok).toBe(true);

    await c1.query('commit');
    await c2.query('commit');

    expect(await balanceOf(db, vendor.id, customer.id)).toBe(500);
    expect(await balanceOf(db, vendor.id, other.id)).toBe(500);
  });

  it('a concurrent replay of one key yields one entry, not two', async () => {
    // The offline queue resending the same key from two tabs at once.
    const key = randomUUID();
    const call = (c: pg.Client) =>
      c.query(
        `select * from public.post_ledger_entry(
           $1::uuid, $2::uuid, 'credit', 'change', 100, $3::text,
           $4::uuid, false, null::uuid, null::text)`,
        [vendor.id, customer.id, key, vendor.authUserId]
      );

    const [r1, r2] = await Promise.all([call(c1), call(c2)]);

    expect(r1.rows[0].id).toBe(r2.rows[0].id);
    expect(await entryCount(db)).toBe(2); // seeded credit + this one, once
  });
});
