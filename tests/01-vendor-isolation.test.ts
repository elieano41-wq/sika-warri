// Acceptance test 1 — vendor A cannot read, write, or infer any ledger entry
// belonging to vendor B.
//
// Written first and treated as the most important test in the suite. Standing
// rule 1 is not a preference: a balance exists for a (customer, vendor) pair,
// and if one vendor can observe another's entries the product is no longer a
// per-vendor commercial debt record. "Infer" is included deliberately — a
// COUNT or an aggregate that leaks the existence of another vendor's rows
// fails this test just as a SELECT of them would.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import {
  connect,
  reset,
  actAs,
  actAsAdmin,
  seedVendor,
  seedCustomer,
  giveCredit,
  postEntry,
  sqlstateOf,
  entryCount,
  randomUUID,
  type SeededVendor,
  type SeededCustomer,
} from './helpers/db';

let db: pg.Client;
let vendorA: SeededVendor;
let vendorB: SeededVendor;
let shared: SeededCustomer;
let entryA: { id: string };
let entryB: { id: string };

beforeAll(async () => {
  db = await connect();
});

afterAll(async () => {
  await actAsAdmin(db);
  await db.end();
});

beforeEach(async () => {
  await reset(db);

  vendorA = await seedVendor(db, { businessName: 'Chez Awa' });
  vendorB = await seedVendor(db, { businessName: 'Kiosque Bamba' });

  // One customer holding change at BOTH vendors. This is the sharpest case:
  // the rows differ only by vendor_id, so nothing but the policy separates them.
  shared = await seedCustomer(db);

  entryA = await giveCredit(db, vendorA, shared, 500);
  entryB = await giveCredit(db, vendorB, shared, 700);
});

describe('acceptance test 1 — cross-vendor isolation', () => {
  it('vendor A reads only its own entries', async () => {
    await actAs(db, vendorA.authUserId);
    const { rows } = await db.query('select id, vendor_id from public.ledger_entries');

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(entryA.id);
    expect(rows[0].vendor_id).toBe(vendorA.id);
  });

  it("vendor A cannot fetch vendor B's entry even knowing its exact id", async () => {
    await actAs(db, vendorA.authUserId);
    const { rows } = await db.query(
      'select id from public.ledger_entries where id = $1',
      [entryB.id]
    );

    // Not an error — simply invisible. RLS filters rather than rejecting.
    expect(rows).toHaveLength(0);
  });

  it('vendor A cannot INFER vendor B rows through an aggregate', async () => {
    await actAs(db, vendorA.authUserId);

    const { rows: counted } = await db.query(
      'select count(*)::integer as n, coalesce(sum(amount_cfa), 0)::integer as total ' +
        'from public.ledger_entries'
    );
    expect(counted[0].n).toBe(1);
    expect(counted[0].total).toBe(500); // 700 would mean B leaked in

    // And the table genuinely holds two rows, so the filtering above is the
    // policy at work and not an empty database.
    expect(await entryCount(db)).toBe(2);
  });

  it('v_balances is filtered too — the view does not bypass the policy', async () => {
    await actAs(db, vendorA.authUserId);
    const { rows } = await db.query(
      'select vendor_id, balance_cfa from public.v_balances'
    );

    // Regression guard for security_invoker on the view. Without it this
    // returns both vendors' balances while every direct query still looks
    // correct, which is the failure mode most likely to ship unnoticed.
    expect(rows).toHaveLength(1);
    expect(rows[0].vendor_id).toBe(vendorA.id);
    expect(rows[0].balance_cfa).toBe(500);
  });

  it("vendor A cannot read vendor B's vendor record", async () => {
    await actAs(db, vendorA.authUserId);
    const { rows } = await db.query('select id, business_name from public.vendors');

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(vendorA.id);
  });

  it("vendor A cannot WRITE against vendor B's id", async () => {
    await actAs(db, vendorA.authUserId);

    const code = await sqlstateOf(() =>
      postEntry(db, {
        vendorId: vendorB.id, // not theirs
        customerId: shared.id,
        direction: 'credit',
        kind: 'change',
        amount: 100,
        actorUserId: vendorA.authUserId,
      })
    );

    expect(code).toBe('SW001'); // SIKA_VENDOR_FORBIDDEN
    expect(await entryCount(db)).toBe(2); // nothing appended
  });

  it('no vendor may INSERT into the ledger directly, bypassing the RPC', async () => {
    await actAs(db, vendorA.authUserId);

    const code = await sqlstateOf(() =>
      db.query(
        `insert into public.ledger_entries
           (vendor_id, customer_id, direction, kind, amount_cfa,
            idempotency_key, created_by)
         values ($1, $2, 'credit', 'change', 100, $3, $4)`,
        [vendorA.id, shared.id, randomUUID(), vendorA.authUserId]
      )
    );

    expect(code).toBe('42501'); // insufficient_privilege
    expect(await entryCount(db)).toBe(2);
  });

  it('an anonymous caller sees nothing at all', async () => {
    await actAsAdmin(db);
    await db.query('set role anon');

    // anon holds no privilege on the table, so this is a hard rejection
    // rather than an empty result.
    const code = await sqlstateOf(() =>
      db.query('select count(*) from public.ledger_entries')
    );
    expect(code).toBe('42501');

    await actAsAdmin(db);
  });

  it('the customer sees both sides, because both debts are genuinely theirs', async () => {
    // The mirror of isolation: the constraint is per vendor, not a blanket
    // denial. The customer party to both entries must see both — while still
    // never being offered them as one spendable sum (test 8).
    await actAs(db, shared.authUserId!);
    const { rows } = await db.query(
      'select vendor_id, balance_cfa from public.v_balances order by balance_cfa'
    );

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.balance_cfa)).toEqual([500, 700]);
  });
});
