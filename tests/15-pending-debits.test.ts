// Acceptance test 15 — an expired pending_debits row cannot become a ledger
// entry.  (Amendment H)
//
// The pending row is a proposal, not a reservation: it holds no money and moves
// no balance. Its only power is to be convertible once, by the right customer,
// within 180 seconds. Everything below tests the boundaries of that power.

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
  createPendingDebit,
  confirmPendingDebit,
  expirePendingDebit,
  sqlstateOf,
  entryCount,
  balanceOf,
  type SeededVendor,
  type SeededCustomer,
} from './helpers/db';

let db: pg.Client;
let vendor: SeededVendor;
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
  vendor = await seedVendor(db);
  customer = await seedCustomer(db);
  await giveCredit(db, vendor, customer, 1000);
});

describe('acceptance test 15 — expired proposals are never convertible', () => {
  it('refuses to convert an expired proposal and writes nothing', async () => {
    await actAsAdmin(db);
    const pending = await createPendingDebit(db, {
      vendorId: vendor.id,
      customerId: customer.id,
      kind: 'purchase',
      amount: 400,
      actorUserId: vendor.authUserId,
    });

    await expirePendingDebit(db, pending.id);
    await actAsAdmin(db);

    const code = await sqlstateOf(() =>
      confirmPendingDebit(db, pending.id, customer.authUserId!)
    );

    expect(code).toBe('SW012'); // SIKA_PENDING_EXPIRED
    expect(await entryCount(db)).toBe(1); // the seeded credit only
    expect(await balanceOf(db, vendor.id, customer.id)).toBe(1000);
  });

  it('stays unconvertible on a retry — expiry is not a transient error', async () => {
    await actAsAdmin(db);
    const pending = await createPendingDebit(db, {
      vendorId: vendor.id, customerId: customer.id,
      kind: 'purchase', amount: 400, actorUserId: vendor.authUserId,
    });
    await expirePendingDebit(db, pending.id);

    for (let i = 0; i < 3; i += 1) {
      await actAsAdmin(db);
      const code = await sqlstateOf(() =>
        confirmPendingDebit(db, pending.id, customer.authUserId!)
      );
      expect(code).toBe('SW012');
    }
    expect(await entryCount(db)).toBe(1);
  });

  it('converts a live proposal into exactly one own_device debit', async () => {
    await actAsAdmin(db);
    const pending = await createPendingDebit(db, {
      vendorId: vendor.id, customerId: customer.id,
      kind: 'purchase', amount: 400, actorUserId: vendor.authUserId,
    });

    const entry = await confirmPendingDebit(db, pending.id, customer.authUserId!);

    expect(entry.direction).toBe('debit');
    expect(entry.amount_cfa).toBe(400);
    // The whole point of amendment H: the customer confirmed on their own device.
    expect(entry.confirmation_method).toBe('own_device');
    expect(entry.customer_confirmed_at).not.toBeNull();
    // created_by remains the vendor, who performed the transaction; consent is
    // recorded separately.
    expect(entry.created_by).toBe(vendor.authUserId);
    expect(await balanceOf(db, vendor.id, customer.id)).toBe(600);
  });

  it('a second confirmation returns the same entry, not a second debit', async () => {
    await actAsAdmin(db);
    const pending = await createPendingDebit(db, {
      vendorId: vendor.id, customerId: customer.id,
      kind: 'purchase', amount: 400, actorUserId: vendor.authUserId,
    });

    const first = await confirmPendingDebit(db, pending.id, customer.authUserId!);
    const again = await confirmPendingDebit(db, pending.id, customer.authUserId!);

    // A dropped response must not read as a second debit.
    expect(again.id).toBe(first.id);
    expect(await balanceOf(db, vendor.id, customer.id)).toBe(600);
    expect(await entryCount(db)).toBe(2);
  });

  it('only the addressed customer may confirm', async () => {
    const bystander = await seedCustomer(db);
    await actAsAdmin(db);
    const pending = await createPendingDebit(db, {
      vendorId: vendor.id, customerId: customer.id,
      kind: 'purchase', amount: 400, actorUserId: vendor.authUserId,
    });

    const code = await sqlstateOf(() =>
      confirmPendingDebit(db, pending.id, bystander.authUserId!)
    );

    expect(code).toBe('SW001'); // SIKA_PENDING_NOT_YOURS
    expect(await entryCount(db)).toBe(1);
  });

  it('a cancelled proposal cannot be confirmed', async () => {
    await actAsAdmin(db);
    const pending = await createPendingDebit(db, {
      vendorId: vendor.id, customerId: customer.id,
      kind: 'purchase', amount: 400, actorUserId: vendor.authUserId,
    });

    await db.query('select * from public.cancel_pending_debit($1::uuid, $2::uuid)', [
      pending.id,
      vendor.authUserId,
    ]);

    const code = await sqlstateOf(() =>
      confirmPendingDebit(db, pending.id, customer.authUserId!)
    );
    expect(code).toBe('SW011');
    expect(await entryCount(db)).toBe(1);
  });

  it('a landed debit cannot be cancelled afterwards', async () => {
    await actAsAdmin(db);
    const pending = await createPendingDebit(db, {
      vendorId: vendor.id, customerId: customer.id,
      kind: 'purchase', amount: 400, actorUserId: vendor.authUserId,
    });
    await confirmPendingDebit(db, pending.id, customer.authUserId!);

    // Rule 3: correcting history means a reversal, never an erasure.
    const code = await sqlstateOf(() =>
      db.query('select * from public.cancel_pending_debit($1::uuid, $2::uuid)', [
        pending.id,
        vendor.authUserId,
      ])
    );
    expect(code).toBe('SW011');
  });

  it('refuses to propose more than the balance covers', async () => {
    await actAsAdmin(db);
    const code = await sqlstateOf(() =>
      createPendingDebit(db, {
        vendorId: vendor.id, customerId: customer.id,
        kind: 'purchase', amount: 1001, actorUserId: vendor.authUserId,
      })
    );
    // Fails at proposal time so the customer is never asked to authorise
    // something that cannot succeed.
    expect(code).toBe('SW006');
  });

  it('re-proposing with the same key returns the original proposal', async () => {
    await actAsAdmin(db);
    const key = 'vendor-retry-key';
    const a = await createPendingDebit(db, {
      vendorId: vendor.id, customerId: customer.id, kind: 'purchase',
      amount: 400, actorUserId: vendor.authUserId, idempotencyKey: key,
    });
    const b = await createPendingDebit(db, {
      vendorId: vendor.id, customerId: customer.id, kind: 'purchase',
      amount: 400, actorUserId: vendor.authUserId, idempotencyKey: key,
    });

    // A flaky vendor connection must not stack two requests at the customer.
    expect(b.id).toBe(a.id);
  });

  it("a vendor cannot propose against another vendor's ledger", async () => {
    const other = await seedVendor(db);
    await actAsAdmin(db);

    const code = await sqlstateOf(() =>
      createPendingDebit(db, {
        vendorId: other.id, customerId: customer.id,
        kind: 'purchase', amount: 100, actorUserId: vendor.authUserId,
      })
    );
    expect(code).toBe('SW001');
  });

  it('the customer sees the proposal with shop name and resulting balance', async () => {
    await actAsAdmin(db);
    const pending = await createPendingDebit(db, {
      vendorId: vendor.id, customerId: customer.id,
      kind: 'purchase', amount: 400, actorUserId: vendor.authUserId,
    });

    await actAs(db, customer.authUserId!);
    const { rows } = await db.query(
      'select * from public.pending_debits_for_customer($1::uuid)',
      [customer.authUserId]
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(pending.id);
    // You cannot ask someone to authorise paying a shop without naming it.
    expect(rows[0].business_name).toBe(vendor.businessName);
    expect(rows[0].amount_cfa).toBe(400);
    expect(rows[0].current_balance).toBe(1000);
    expect(rows[0].resulting_balance).toBe(600);
    expect(rows[0].seconds_left).toBeGreaterThan(0);
    expect(rows[0].seconds_left).toBeLessThanOrEqual(180);
  });

  it('an expired proposal disappears from the customer list', async () => {
    await actAsAdmin(db);
    const pending = await createPendingDebit(db, {
      vendorId: vendor.id, customerId: customer.id,
      kind: 'purchase', amount: 400, actorUserId: vendor.authUserId,
    });
    await expirePendingDebit(db, pending.id);

    await actAs(db, customer.authUserId!);
    const { rows } = await db.query(
      'select * from public.pending_debits_for_customer($1::uuid)',
      [customer.authUserId]
    );
    expect(rows).toHaveLength(0);
  });

  it('one customer never sees another customer\'s proposal', async () => {
    const other = await seedCustomer(db);
    await actAsAdmin(db);
    await createPendingDebit(db, {
      vendorId: vendor.id, customerId: customer.id,
      kind: 'purchase', amount: 400, actorUserId: vendor.authUserId,
    });

    await actAs(db, other.authUserId!);
    const { rows } = await db.query(
      'select * from public.pending_debits_for_customer($1::uuid)',
      [other.authUserId]
    );
    expect(rows).toHaveLength(0);
  });

  it('confirm_pending_debit is not directly callable by a client', async () => {
    // It cannot verify a PIN, so it must only ever be reachable by the Edge
    // Function that already did. Execute is withheld from `authenticated`.
    await actAsAdmin(db);
    const pending = await createPendingDebit(db, {
      vendorId: vendor.id, customerId: customer.id,
      kind: 'purchase', amount: 400, actorUserId: vendor.authUserId,
    });

    await actAs(db, customer.authUserId!);
    const code = await sqlstateOf(() =>
      db.query('select * from public.confirm_pending_debit($1::uuid, $2::uuid)', [
        pending.id,
        customer.authUserId,
      ])
    );

    expect(code).toBe('42501'); // insufficient_privilege
    expect(await entryCount(db)).toBe(1);
  });
});
