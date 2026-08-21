// Acceptance test 14 — a vendor_device debit records the correct
// confirmation_method and appears flagged in the customer's history.
// (Amendment I)
//
// The fallback exists because customers without a smartphone still have to be
// able to spend their change, and rule 9 says they can always demand cash back.
// But it is genuinely weaker: the vendor sees the PIN. So the requirement is not
// that it be prevented — it is that it be recorded, visible to the customer, and
// countable as a fraud signal. This file checks all three.

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
  balanceOf,
  customerFlags,
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
  await giveCredit(db, vendor, customer, 2000);
});

describe('acceptance test 14 — vendor_device provenance', () => {
  it('records confirmation_method = vendor_device', async () => {
    await actAsAdmin(db);

    const entry = await postEntry(db, {
      vendorId: vendor.id,
      customerId: customer.id,
      direction: 'debit',
      kind: 'purchase',
      amount: 500,
      actorUserId: vendor.authUserId,
      customerConfirmed: true,
      confirmationMethod: 'vendor_device',
    });

    expect(entry.confirmation_method).toBe('vendor_device');
    expect(entry.customer_confirmed_at).not.toBeNull();
    expect(await balanceOf(db, vendor.id, customer.id)).toBe(1500);
  });

  it('defaults to own_device when the method is not stated', async () => {
    // The safe value is the default. A caller that forgets the argument cannot
    // silently produce a vendor_device entry — the weaker path must be chosen
    // on purpose, which is what makes the fraud signal meaningful.
    await actAsAdmin(db);

    const entry = await postEntry(db, {
      vendorId: vendor.id,
      customerId: customer.id,
      direction: 'debit',
      kind: 'purchase',
      amount: 500,
      actorUserId: vendor.authUserId,
      customerConfirmed: true,
    });

    expect(entry.confirmation_method).toBe('own_device');
  });

  it("appears flagged in the CUSTOMER's own history, not just the vendor's", async () => {
    // own_device FIRST, deliberately. A vendor_device debit sets
    // pin_change_required, which then blocks any own_device purchase until the
    // PIN is changed — so the reverse order trips that gate and never reaches
    // the assertions. Ordering it this way leaves both entries in history.
    await actAsAdmin(db);
    await postEntry(db, {
      vendorId: vendor.id, customerId: customer.id,
      direction: 'debit', kind: 'purchase', amount: 200,
      actorUserId: vendor.authUserId, customerConfirmed: true,
      confirmationMethod: 'own_device',
    });
    await postEntry(db, {
      vendorId: vendor.id, customerId: customer.id,
      direction: 'debit', kind: 'purchase', amount: 500,
      actorUserId: vendor.authUserId, customerConfirmed: true,
      confirmationMethod: 'vendor_device',
    });

    // Read as the customer, through RLS, exactly as their app would.
    await actAs(db, customer.authUserId!);
    const { rows } = await db.query(
      `select amount_cfa, confirmation_method
         from public.ledger_entries
        where direction = 'debit'
        order by amount_cfa desc`
    );

    expect(rows).toHaveLength(2);
    expect(rows[0].confirmation_method).toBe('vendor_device');
    expect(rows[1].confirmation_method).toBe('own_device');

    // The customer can therefore single out the weaker entries themselves.
    const flagged = rows.filter((r) => r.confirmation_method === 'vendor_device');
    expect(flagged).toHaveLength(1);
    expect(flagged[0].amount_cfa).toBe(500);
  });

  it('marks the PIN as needing a change, because the vendor has now seen it', async () => {
    expect((await customerFlags(db, customer.id)).pin_change_required).toBe(false);

    await actAsAdmin(db);
    await postEntry(db, {
      vendorId: vendor.id, customerId: customer.id,
      direction: 'debit', kind: 'purchase', amount: 500,
      actorUserId: vendor.authUserId, customerConfirmed: true,
      confirmationMethod: 'vendor_device',
    });

    expect((await customerFlags(db, customer.id)).pin_change_required).toBe(true);
  });

  it('an own_device debit does NOT mark the PIN compromised', async () => {
    await actAsAdmin(db);
    await postEntry(db, {
      vendorId: vendor.id, customerId: customer.id,
      direction: 'debit', kind: 'purchase', amount: 500,
      actorUserId: vendor.authUserId, customerConfirmed: true,
      confirmationMethod: 'own_device',
    });

    expect((await customerFlags(db, customer.id)).pin_change_required).toBe(false);
  });

  it('blocks a later own_device PURCHASE until the PIN is changed', async () => {
    // The customer is holding their own phone at this point, so they can change
    // the PIN immediately. This is the moment to insist.
    await actAsAdmin(db);
    await postEntry(db, {
      vendorId: vendor.id, customerId: customer.id,
      direction: 'debit', kind: 'purchase', amount: 100,
      actorUserId: vendor.authUserId, customerConfirmed: true,
      confirmationMethod: 'vendor_device',
    });

    const code = await sqlstateOf(() =>
      postEntry(db, {
        vendorId: vendor.id, customerId: customer.id,
        direction: 'debit', kind: 'purchase', amount: 100,
        actorUserId: vendor.authUserId, customerConfirmed: true,
        confirmationMethod: 'own_device',
      })
    );
    expect(code).toBe('SW010'); // SIKA_PIN_CHANGE_REQUIRED
  });

  it('a REFUND succeeds while pin_change_required is true — the escape valve', async () => {
    // Ratified explicitly: the refund path must never be blocked by the
    // stale-PIN gate. It is what keeps the recorded change a plain commercial
    // debt the customer can always call in, rather than something the product
    // can trap. If this test ever fails, a phone-less customer has lost access
    // to their own money.
    await actAsAdmin(db);
    await postEntry(db, {
      vendorId: vendor.id, customerId: customer.id,
      direction: 'debit', kind: 'purchase', amount: 100,
      actorUserId: vendor.authUserId, customerConfirmed: true,
      confirmationMethod: 'vendor_device',
    });

    const flags = await customerFlags(db, customer.id);
    expect(flags.pin_change_required).toBe(true);

    // Both confirmation methods must work for a refund under a stale PIN.
    await actAsAdmin(db);
    const ownDevice = await postEntry(db, {
      vendorId: vendor.id, customerId: customer.id,
      direction: 'debit', kind: 'refund', amount: 700,
      actorUserId: vendor.authUserId, customerConfirmed: true,
      confirmationMethod: 'own_device',
    });
    expect(ownDevice.kind).toBe('refund');
    expect(ownDevice.confirmation_method).toBe('own_device');

    await actAsAdmin(db);
    const vendorDevice = await postEntry(db, {
      vendorId: vendor.id, customerId: customer.id,
      direction: 'debit', kind: 'refund', amount: 1200,
      actorUserId: vendor.authUserId, customerConfirmed: true,
      confirmationMethod: 'vendor_device',
    });
    expect(vendorDevice.kind).toBe('refund');

    // The whole balance came back out as cash.
    expect(await balanceOf(db, vendor.id, customer.id)).toBe(0);
  });

  it('still allows a REFUND with a stale PIN — money must never be stranded', async () => {
    // Deliberate interpretation of amendment I, flagged for review. A customer
    // with no smartphone has no own-device login at which to clear the flag, so
    // blocking their refund would trap their change at the vendor and
    // contradict rule 9.
    await actAsAdmin(db);
    await postEntry(db, {
      vendorId: vendor.id, customerId: customer.id,
      direction: 'debit', kind: 'purchase', amount: 100,
      actorUserId: vendor.authUserId, customerConfirmed: true,
      confirmationMethod: 'vendor_device',
    });
    expect((await customerFlags(db, customer.id)).pin_change_required).toBe(true);

    await actAsAdmin(db);
    const refund = await postEntry(db, {
      vendorId: vendor.id, customerId: customer.id,
      direction: 'debit', kind: 'refund', amount: 400,
      actorUserId: vendor.authUserId, customerConfirmed: true,
      confirmationMethod: 'own_device',
    });
    expect(refund.kind).toBe('refund');
  });

  it('still allows a further vendor_device debit — same reason', async () => {
    await actAsAdmin(db);
    await postEntry(db, {
      vendorId: vendor.id, customerId: customer.id,
      direction: 'debit', kind: 'purchase', amount: 100,
      actorUserId: vendor.authUserId, customerConfirmed: true,
      confirmationMethod: 'vendor_device',
    });

    await actAsAdmin(db);
    const second = await postEntry(db, {
      vendorId: vendor.id, customerId: customer.id,
      direction: 'debit', kind: 'purchase', amount: 100,
      actorUserId: vendor.authUserId, customerConfirmed: true,
      confirmationMethod: 'vendor_device',
    });
    expect(second.confirmation_method).toBe('vendor_device');
  });

  it('rejects a nonsense confirmation method rather than coercing it', async () => {
    await actAsAdmin(db);
    const code = await sqlstateOf(() =>
      db.query(
        `select * from public.post_ledger_entry(
           $1::uuid, $2::uuid, 'debit', 'purchase', 100, $3::text,
           $4::uuid, true, null::uuid, null::text, 'sms')`,
        [vendor.id, customer.id, 'k-bad', vendor.authUserId]
      )
    );
    expect(code).toBe('SW007');
  });

  it('a credit carries no confirmation method at all', async () => {
    await actAsAdmin(db);
    const credit = await postEntry(db, {
      vendorId: vendor.id, customerId: customer.id,
      direction: 'credit', kind: 'change', amount: 100,
      actorUserId: vendor.authUserId,
    });
    expect(credit.confirmation_method).toBeNull();
  });

  it('surfaces the mix as a per-vendor fraud signal', async () => {
    await actAsAdmin(db);
    for (const method of ['vendor_device', 'vendor_device', 'own_device'] as const) {
      await postEntry(db, {
        vendorId: vendor.id, customerId: customer.id,
        direction: 'debit', kind: 'refund', amount: 100,
        actorUserId: vendor.authUserId, customerConfirmed: true,
        confirmationMethod: method,
      });
    }

    await actAs(db, vendor.authUserId);
    const { rows } = await db.query(
      'select debits, vendor_device_debits, vendor_device_pct, customers_affected ' +
        'from public.v_vendor_confirmation_mix'
    );

    expect(rows).toHaveLength(1);
    expect(Number(rows[0].debits)).toBe(3);
    expect(Number(rows[0].vendor_device_debits)).toBe(2);
    expect(Number(rows[0].vendor_device_pct)).toBeCloseTo(66.7, 1);
    expect(Number(rows[0].customers_affected)).toBe(1);
  });

  it('the fraud signal does not leak across vendors', async () => {
    const other = await seedVendor(db);
    const otherCustomer = await seedCustomer(db);
    await giveCredit(db, other, otherCustomer, 1000);
    await actAsAdmin(db);
    await postEntry(db, {
      vendorId: other.id, customerId: otherCustomer.id,
      direction: 'debit', kind: 'purchase', amount: 100,
      actorUserId: other.authUserId, customerConfirmed: true,
      confirmationMethod: 'vendor_device',
    });

    await actAs(db, vendor.authUserId);
    const { rows } = await db.query(
      'select vendor_id from public.v_vendor_confirmation_mix'
    );
    // security_invoker on the view means RLS still applies underneath.
    expect(rows).toHaveLength(0); // this vendor has no debits yet
  });
});
