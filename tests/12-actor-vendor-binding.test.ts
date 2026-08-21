// Acceptance test 12 — a call carrying vendor A's identity with vendor B's id
// in the payload is rejected and writes nothing.  (Amendment C)
//
// Why this test exists. The debit path reaches post_ledger_entry as SERVICE
// ROLE, because the Edge Function must verify the customer's PIN out-of-band
// without disturbing the vendor's session. Service role bypasses RLS entirely,
// so none of the policies proven in test 1 are protecting this path. The
// vendor_id is supplied by the caller, and the only thing standing between a
// vendor and someone else's ledger is the ownership check inside the function.
//
// These tests run PRIVILEGED on purpose. Dropping to `authenticated` here
// would let RLS mask a missing check and give a false pass.

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
let customer: SeededCustomer;

beforeAll(async () => {
  db = await connect();
});

afterAll(async () => {
  await actAsAdmin(db);
  await db.end();
});

beforeEach(async () => {
  await reset(db);
  vendorA = await seedVendor(db);
  vendorB = await seedVendor(db);
  customer = await seedCustomer(db);
});

describe('acceptance test 12 — actor is bound to vendor_id', () => {
  it("rejects vendor A's actor with vendor B's id, as service role", async () => {
    await actAsAdmin(db); // simulates the Edge Function: RLS does not apply

    const code = await sqlstateOf(() =>
      postEntry(db, {
        vendorId: vendorB.id,
        customerId: customer.id,
        direction: 'credit',
        kind: 'change',
        amount: 500,
        actorUserId: vendorA.authUserId, // verified JWT belongs to A
      })
    );

    expect(code).toBe('SW001'); // SIKA_VENDOR_FORBIDDEN
    expect(await entryCount(db)).toBe(0);
  });

  it('rejects a debit against another vendor even when fully confirmed', async () => {
    // Give the customer real balance at B, so the only thing wrong with the
    // call is who is making it. Everything else would succeed.
    await giveCredit(db, vendorB, customer, 1000);
    await actAsAdmin(db);

    const code = await sqlstateOf(() =>
      postEntry(db, {
        vendorId: vendorB.id,
        customerId: customer.id,
        direction: 'debit',
        kind: 'purchase',
        amount: 400,
        actorUserId: vendorA.authUserId,
        customerConfirmed: true,
      })
    );

    expect(code).toBe('SW001');
    expect(await entryCount(db)).toBe(1); // only the seeded credit
  });

  it('rejects an actor that is not a vendor at all', async () => {
    await actAsAdmin(db);

    const code = await sqlstateOf(() =>
      postEntry(db, {
        vendorId: vendorA.id,
        customerId: customer.id,
        direction: 'credit',
        kind: 'change',
        amount: 500,
        actorUserId: randomUUID(), // no vendor record
      })
    );

    expect(code).toBe('SW001');
    expect(await entryCount(db)).toBe(0);
  });

  it('rejects a null actor rather than falling back to anything', async () => {
    await actAsAdmin(db);

    const code = await sqlstateOf(() =>
      db.query(
        `select * from public.post_ledger_entry(
           $1::uuid, $2::uuid, 'credit', 'change', 500, $3::text,
           null::uuid, false, null::uuid, null::text)`,
        [vendorA.id, customer.id, randomUUID()]
      )
    );

    expect(code).toBe('SW003'); // SIKA_ACTOR_REQUIRED — never a silent default
    expect(await entryCount(db)).toBe(0);
  });

  it('a session-bound caller cannot assert a different actor', async () => {
    // The other half of the guard. Service role may assert an actor freely
    // because it has no session identity of its own; a real logged-in session
    // may not, or any vendor could act as any other by passing a different id.
    await actAs(db, vendorA.authUserId);

    const code = await sqlstateOf(() =>
      postEntry(db, {
        vendorId: vendorB.id,
        customerId: customer.id,
        direction: 'credit',
        kind: 'change',
        amount: 500,
        actorUserId: vendorB.authUserId, // claiming to be B while logged in as A
      })
    );

    expect(code).toBe('SW002'); // SIKA_ACTOR_MISMATCH
    expect(await entryCount(db)).toBe(0);
  });

  it('an inactive vendor cannot post even with a correct actor', async () => {
    const dormant = await seedVendor(db, { active: false });
    await actAsAdmin(db);

    const code = await sqlstateOf(() =>
      postEntry(db, {
        vendorId: dormant.id,
        customerId: customer.id,
        direction: 'credit',
        kind: 'change',
        amount: 500,
        actorUserId: dormant.authUserId,
      })
    );

    expect(code).toBe('SW001');
    expect(await entryCount(db)).toBe(0);
  });

  it('the matching actor and vendor DOES succeed — the guard is not blanket denial', async () => {
    await actAsAdmin(db);

    const entry = await postEntry(db, {
      vendorId: vendorA.id,
      customerId: customer.id,
      direction: 'credit',
      kind: 'change',
      amount: 500,
      actorUserId: vendorA.authUserId,
    });

    expect(entry.vendor_id).toBe(vendorA.id);
    expect(entry.created_by).toBe(vendorA.authUserId);
    expect(entry.amount_cfa).toBe(500);
    expect(await entryCount(db)).toBe(1);
  });
});
