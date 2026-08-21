// Acceptance test 13 — a refund without valid customer PIN confirmation is
// rejected.  (Amendment D)
//
// The fraud this closes: "Rembourser en espèces" records a debit that says the
// vendor handed cash back. If the vendor alone can record it, they can clear
// every balance they owe without paying anyone. The customer's own PIN on the
// vendor's device is the only evidence the cash actually moved.
//
// So confirmation is required for EVERY debit, not just purchases — and it is
// enforced twice: the RPC refuses, and a CHECK constraint makes an unconfirmed
// debit unrepresentable even to a privileged writer that skips the RPC.

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
  createPendingDebit,
  confirmPendingDebit,
  sqlstateOf,
  entryCount,
  balanceOf,
  randomUUID,
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

describe('acceptance test 13 — every debit needs customer confirmation', () => {
  it('rejects a REFUND with no confirmation', async () => {
    await actAsAdmin(db);

    const code = await sqlstateOf(() =>
      postEntry(db, {
        vendorId: vendor.id,
        customerId: customer.id,
        direction: 'debit',
        kind: 'refund',
        amount: 1000,
        actorUserId: vendor.authUserId,
        customerConfirmed: false,
      })
    );

    expect(code).toBe('SW004'); // SIKA_CUSTOMER_CONFIRMATION_REQUIRED
    expect(await entryCount(db)).toBe(1); // the credit only
    expect(await balanceOf(db, vendor.id, customer.id)).toBe(1000); // untouched
  });

  it('rejects a PURCHASE with no confirmation', async () => {
    await actAsAdmin(db);

    const code = await sqlstateOf(() =>
      postEntry(db, {
        vendorId: vendor.id,
        customerId: customer.id,
        direction: 'debit',
        kind: 'purchase',
        amount: 300,
        actorUserId: vendor.authUserId,
        customerConfirmed: false,
      })
    );

    expect(code).toBe('SW004');
    expect(await balanceOf(db, vendor.id, customer.id)).toBe(1000);
  });

  it('rejects a debit-direction REVERSAL with no confirmation', async () => {
    // A reversal that runs as a debit reduces what the customer holds, so it
    // is adverse to them in exactly the same way a purchase is.
    const credit = await giveCredit(db, vendor, customer, 200);
    await actAsAdmin(db);

    const code = await sqlstateOf(() =>
      postEntry(db, {
        vendorId: vendor.id,
        customerId: customer.id,
        direction: 'debit',
        kind: 'reversal',
        amount: 200,
        actorUserId: vendor.authUserId,
        reversesEntryId: credit.id,
        customerConfirmed: false,
      })
    );

    expect(code).toBe('SW004');
  });

  it('accepts a confirmed refund and timestamps the confirmation', async () => {
    await actAsAdmin(db);

    const entry = await postEntry(db, {
      vendorId: vendor.id,
      customerId: customer.id,
      direction: 'debit',
      kind: 'refund',
      amount: 1000,
      actorUserId: vendor.authUserId,
      customerConfirmed: true,
    });

    expect(entry.kind).toBe('refund');
    expect(entry.customer_confirmed_at).not.toBeNull();
    expect(await balanceOf(db, vendor.id, customer.id)).toBe(0);
  });

  it('a credit must NOT claim confirmation', async () => {
    // Keeps the flag meaningful. If credits could carry it, the column would
    // stop being evidence that a customer stood there and authorised a debit.
    await actAsAdmin(db);

    const code = await sqlstateOf(() =>
      postEntry(db, {
        vendorId: vendor.id,
        customerId: customer.id,
        direction: 'credit',
        kind: 'change',
        amount: 100,
        actorUserId: vendor.authUserId,
        customerConfirmed: true,
      })
    );

    expect(code).toBe('SW007'); // SIKA_CONFIRMATION_NOT_APPLICABLE
  });

  it('a VENDOR SESSION cannot fabricate a customer confirmation', async () => {
    // The hole this closes. post_ledger_entry is granted to `authenticated` so
    // the vendor app can record credits directly — but it took
    // p_customer_confirmed as an argument and believed it. A vendor with an
    // ordinary session could therefore write a debit marked own_device with no
    // customer anywhere near it, which is exactly the fraud amendment D exists
    // to prevent and exactly what amendment H moved to the customer's phone to
    // make trustworthy.
    //
    // A genuine confirmed debit is always written by the confirm-debit function
    // AFTER it verifies a PIN, and that runs as service role with no session
    // identity. So refusing session-bound callers costs the legitimate path
    // nothing.
    await actAs(db, vendor.authUserId);

    for (const method of ['own_device', 'vendor_device'] as const) {
      const code = await sqlstateOf(() =>
        postEntry(db, {
          vendorId: vendor.id,
          customerId: customer.id,
          direction: 'debit',
          kind: 'purchase',
          amount: 100,
          actorUserId: vendor.authUserId,
          customerConfirmed: true,
          confirmationMethod: method,
        })
      );
      expect(code).toBe('SW014'); // SIKA_CONFIRMED_DEBIT_REQUIRES_FUNCTION
    }

    expect(await balanceOf(db, vendor.id, customer.id)).toBe(1000);
  });

  it('a vendor session CAN still record a credit and a correction', async () => {
    // The fix must not break the two things a vendor is entitled to do alone,
    // or the vendor app stops working and the ledger gains nothing.
    await actAs(db, vendor.authUserId);

    const credit = await postEntry(db, {
      vendorId: vendor.id, customerId: customer.id,
      direction: 'credit', kind: 'change', amount: 500,
      actorUserId: vendor.authUserId,
    });
    expect(credit.amount_cfa).toBe(500);

    await actAs(db, vendor.authUserId);
    const correction = await postEntry(db, {
      vendorId: vendor.id, customerId: customer.id,
      direction: 'debit', kind: 'reversal', amount: 500,
      actorUserId: vendor.authUserId, reversesEntryId: credit.id,
      confirmationMethod: 'vendor_correction',
    });
    expect(correction.confirmation_method).toBe('vendor_correction');
    expect(await balanceOf(db, vendor.id, customer.id)).toBe(1000);
  });

  it('the confirm_pending_debit path still works, as service role', async () => {
    // Proof that the guard distinguishes callers rather than blocking debits
    // outright.
    await actAsAdmin(db);
    const pending = await createPendingDebit(db, {
      vendorId: vendor.id, customerId: customer.id,
      kind: 'purchase', amount: 300, actorUserId: vendor.authUserId,
    });
    const entry = await confirmPendingDebit(db, pending.id, customer.authUserId!);

    expect(entry.confirmation_method).toBe('own_device');
    expect(await balanceOf(db, vendor.id, customer.id)).toBe(700);
  });

  it('the CHECK constraint blocks an unconfirmed debit even bypassing the RPC', async () => {
    // Defence in depth. A future migration, seed script, or manual fix that
    // writes the table directly still cannot produce an unconfirmed debit.
    await actAsAdmin(db);

    const code = await sqlstateOf(() =>
      db.query(
        `insert into public.ledger_entries
           (vendor_id, customer_id, direction, kind, amount_cfa,
            idempotency_key, customer_confirmed_at, created_by)
         values ($1, $2, 'debit', 'refund', 500, $3, null, $4)`,
        [vendor.id, customer.id, randomUUID(), vendor.authUserId]
      )
    );

    expect(code).toBe('23514'); // check_violation
    expect(await entryCount(db)).toBe(1);
  });
});
