// A vendor corrects their own mistake.
//
// The case: a shopkeeper types 5000 F instead of 500 F. Before this existed,
// reversing that credit was a debit, every debit needed customer confirmation,
// and so undoing the vendor's typo depended on the one person who profits from
// it. An absent or dishonest customer never confirms and the vendor is out
// 4500 F they never received.
//
// The counter-risk is worse if unbounded: a vendor able to reverse freely could
// hand over change, record it, then erase it. So the tests below check the
// limits as hard as they check the capability — a correction must be impossible
// once the money has been touched or the moment has passed.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import {
  connect, reset, actAs, actAsAdmin, seedVendor, seedCustomer, giveCredit,
  postEntry, sqlstateOf, entryCount, balanceOf,
  type SeededVendor, type SeededCustomer,
} from './helpers/db';

let db: pg.Client;
let vendor: SeededVendor;
let customer: SeededCustomer;

/** Backdate an entry so the correction window can be tested without waiting. */
async function ageEntry(entryId: string, minutes: number) {
  await actAsAdmin(db);
  await db.query(
    `update public.ledger_entries
        set created_at = now() - make_interval(mins => $2)
      where id = $1`,
    [entryId, minutes]
  );
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
  vendor = await seedVendor(db);
  customer = await seedCustomer(db);
});

describe('a vendor reverses their own mistaken entry', () => {
  it('restores the balance exactly and keeps both entries in history', async () => {
    // The scenario from the spec: 5000 intended as 500. Cap is 3000, so use
    // 2500-for-250 to stay inside it — same mistake, same shape.
    await actAsAdmin(db);
    const mistake = await postEntry(db, {
      vendorId: vendor.id, customerId: customer.id,
      direction: 'credit', kind: 'change', amount: 2500,
      actorUserId: vendor.authUserId,
    });
    expect(await balanceOf(db, vendor.id, customer.id)).toBe(2500);

    await actAsAdmin(db);
    const correction = await postEntry(db, {
      vendorId: vendor.id, customerId: customer.id,
      direction: 'debit', kind: 'reversal', amount: 2500,
      actorUserId: vendor.authUserId,
      reversesEntryId: mistake.id,
      customerConfirmed: false, // no customer involved, and none claimed
      confirmationMethod: 'vendor_correction',
    });

    expect(correction.confirmation_method).toBe('vendor_correction');
    // No timestamp claiming the customer confirmed something they never saw.
    expect(correction.customer_confirmed_at).toBeNull();
    expect(correction.reverses_entry_id).toBe(mistake.id);

    // Balance returns exactly, not approximately.
    expect(await balanceOf(db, vendor.id, customer.id)).toBe(0);

    // Rule 3: nothing edited, nothing deleted, both entries stand.
    await actAs(db, vendor.authUserId);
    const { rows } = await db.query(
      `select kind, direction, amount_cfa, confirmation_method
         from public.ledger_entries order by created_at`
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].kind).toBe('change');
    expect(rows[1].kind).toBe('reversal');
    expect(Number(rows[0].amount_cfa)).toBe(2500);
    expect(Number(rows[1].amount_cfa)).toBe(2500);
  });

  it('the correction is visible in the CUSTOMER history too', async () => {
    await actAsAdmin(db);
    const mistake = await giveCredit(db, vendor, customer, 800);
    await actAsAdmin(db);
    await postEntry(db, {
      vendorId: vendor.id, customerId: customer.id,
      direction: 'debit', kind: 'reversal', amount: 800,
      actorUserId: vendor.authUserId, reversesEntryId: mistake.id,
      confirmationMethod: 'vendor_correction',
    });

    // A correction is adverse to the customer, so they must be able to see it
    // happened and that no confirmation of theirs was involved.
    await actAs(db, customer.authUserId!);
    const { rows } = await db.query(
      `select kind, confirmation_method from public.ledger_entries
        order by created_at`
    );
    expect(rows).toHaveLength(2);
    expect(rows[1].confirmation_method).toBe('vendor_correction');
  });

  it('a vendor can already reverse a mistaken DEBIT with no correction flag', async () => {
    // This path always worked: reversing a debit hands money back, which is
    // favourable to the customer, so it needs no confirmation and no window.
    await giveCredit(db, vendor, customer, 1000);
    await actAsAdmin(db);
    const debit = await postEntry(db, {
      vendorId: vendor.id, customerId: customer.id,
      direction: 'debit', kind: 'purchase', amount: 400,
      actorUserId: vendor.authUserId, customerConfirmed: true,
      confirmationMethod: 'own_device',
    });

    await actAsAdmin(db);
    const back = await postEntry(db, {
      vendorId: vendor.id, customerId: customer.id,
      direction: 'credit', kind: 'reversal', amount: 400,
      actorUserId: vendor.authUserId, reversesEntryId: debit.id,
    });

    expect(back.direction).toBe('credit');
    expect(back.confirmation_method).toBeNull();
    expect(await balanceOf(db, vendor.id, customer.id)).toBe(1000);
  });
});

describe('the limits on that power', () => {
  it('refuses once the correction window has closed', async () => {
    await actAsAdmin(db);
    const mistake = await giveCredit(db, vendor, customer, 900);
    await ageEntry(mistake.id, 20); // window is 15 minutes

    await actAsAdmin(db);
    const code = await sqlstateOf(() =>
      postEntry(db, {
        vendorId: vendor.id, customerId: customer.id,
        direction: 'debit', kind: 'reversal', amount: 900,
        actorUserId: vendor.authUserId, reversesEntryId: mistake.id,
        confirmationMethod: 'vendor_correction',
      })
    );

    expect(code).toBe('SW013'); // SIKA_CORRECTION_WINDOW_CLOSED
    expect(await balanceOf(db, vendor.id, customer.id)).toBe(900);
  });

  it('still allows it just inside the window', async () => {
    await actAsAdmin(db);
    const mistake = await giveCredit(db, vendor, customer, 900);
    await ageEntry(mistake.id, 14);

    await actAsAdmin(db);
    const correction = await postEntry(db, {
      vendorId: vendor.id, customerId: customer.id,
      direction: 'debit', kind: 'reversal', amount: 900,
      actorUserId: vendor.authUserId, reversesEntryId: mistake.id,
      confirmationMethod: 'vendor_correction',
    });
    expect(correction.confirmation_method).toBe('vendor_correction');
  });

  it('refuses if the customer has ALREADY SPENT any of it', async () => {
    // The real protection. A vendor cannot claw back change that has already
    // bought something, because the reversal must match the original amount
    // exactly and the balance no longer covers it.
    await actAsAdmin(db);
    const credit = await giveCredit(db, vendor, customer, 1000);
    await actAsAdmin(db);
    await postEntry(db, {
      vendorId: vendor.id, customerId: customer.id,
      direction: 'debit', kind: 'purchase', amount: 1,
      actorUserId: vendor.authUserId, customerConfirmed: true,
      confirmationMethod: 'own_device',
    });

    await actAsAdmin(db);
    const code = await sqlstateOf(() =>
      postEntry(db, {
        vendorId: vendor.id, customerId: customer.id,
        direction: 'debit', kind: 'reversal', amount: 1000,
        actorUserId: vendor.authUserId, reversesEntryId: credit.id,
        confirmationMethod: 'vendor_correction',
      })
    );

    expect(code).toBe('SW006'); // insufficient balance — one franc was spent
    expect(await balanceOf(db, vendor.id, customer.id)).toBe(999);
  });

  it('cannot be used for an ordinary purchase', async () => {
    // Otherwise it becomes a general-purpose way to debit without consent.
    await giveCredit(db, vendor, customer, 1000);
    await actAsAdmin(db);

    const code = await sqlstateOf(() =>
      postEntry(db, {
        vendorId: vendor.id, customerId: customer.id,
        direction: 'debit', kind: 'purchase', amount: 400,
        actorUserId: vendor.authUserId,
        confirmationMethod: 'vendor_correction',
      })
    );
    expect(code).toBe('SW007');
    expect(await balanceOf(db, vendor.id, customer.id)).toBe(1000);
  });

  it('cannot be used for a refund either', async () => {
    await giveCredit(db, vendor, customer, 1000);
    await actAsAdmin(db);
    const code = await sqlstateOf(() =>
      postEntry(db, {
        vendorId: vendor.id, customerId: customer.id,
        direction: 'debit', kind: 'refund', amount: 400,
        actorUserId: vendor.authUserId,
        confirmationMethod: 'vendor_correction',
      })
    );
    expect(code).toBe('SW007');
  });

  it("cannot correct ANOTHER vendor's entry", async () => {
    const other = await seedVendor(db);
    const mistake = await giveCredit(db, other, customer, 900);
    await actAsAdmin(db);

    const code = await sqlstateOf(() =>
      postEntry(db, {
        vendorId: vendor.id, customerId: customer.id,
        direction: 'debit', kind: 'reversal', amount: 900,
        actorUserId: vendor.authUserId, reversesEntryId: mistake.id,
        confirmationMethod: 'vendor_correction',
      })
    );
    expect(code).toBe('SW008');
  });

  it('cannot claim customer confirmation while correcting', async () => {
    // The flag would be a lie in the ledger: no customer saw this.
    await actAsAdmin(db);
    const mistake = await giveCredit(db, vendor, customer, 900);
    await actAsAdmin(db);

    const code = await sqlstateOf(() =>
      postEntry(db, {
        vendorId: vendor.id, customerId: customer.id,
        direction: 'debit', kind: 'reversal', amount: 900,
        actorUserId: vendor.authUserId, reversesEntryId: mistake.id,
        customerConfirmed: true,
        confirmationMethod: 'vendor_correction',
      })
    );
    expect(code).toBe('SW007');
  });

  it('cannot correct the same entry twice', async () => {
    await actAsAdmin(db);
    const mistake = await giveCredit(db, vendor, customer, 900);
    await giveCredit(db, vendor, customer, 900); // headroom
    await actAsAdmin(db);
    await postEntry(db, {
      vendorId: vendor.id, customerId: customer.id,
      direction: 'debit', kind: 'reversal', amount: 900,
      actorUserId: vendor.authUserId, reversesEntryId: mistake.id,
      confirmationMethod: 'vendor_correction',
    });

    const code = await sqlstateOf(() =>
      postEntry(db, {
        vendorId: vendor.id, customerId: customer.id,
        direction: 'debit', kind: 'reversal', amount: 900,
        actorUserId: vendor.authUserId, reversesEntryId: mistake.id,
        confirmationMethod: 'vendor_correction',
      })
    );
    expect(code).toBe('23505'); // one reversal per entry
  });

  it('a customer-confirmed reversal has NO time limit', async () => {
    // The window exists only because the vendor is acting alone. With the
    // customer's agreement there is nothing to bound.
    await actAsAdmin(db);
    const mistake = await giveCredit(db, vendor, customer, 900);
    await ageEntry(mistake.id, 600); // ten hours old

    await actAsAdmin(db);
    const reversal = await postEntry(db, {
      vendorId: vendor.id, customerId: customer.id,
      direction: 'debit', kind: 'reversal', amount: 900,
      actorUserId: vendor.authUserId, reversesEntryId: mistake.id,
      customerConfirmed: true,
      confirmationMethod: 'own_device',
    });
    expect(reversal.customer_confirmed_at).not.toBeNull();
    expect(await balanceOf(db, vendor.id, customer.id)).toBe(0);
  });
});

describe('what the vendor app shows', () => {
  it('lists a fresh entry as correctable with a countdown', async () => {
    await actAsAdmin(db);
    const entry = await giveCredit(db, vendor, customer, 500);

    await actAs(db, vendor.authUserId);
    const { rows } = await db.query(
      'select id, seconds_left from public.v_correctable_entries'
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(entry.id);
    // A countdown, so the shopkeeper sees the limit rather than discovering it
    // by being refused.
    expect(rows[0].seconds_left).toBeGreaterThan(0);
    expect(rows[0].seconds_left).toBeLessThanOrEqual(15 * 60);
  });

  it('drops an entry once its window closes', async () => {
    await actAsAdmin(db);
    const entry = await giveCredit(db, vendor, customer, 500);
    await ageEntry(entry.id, 20);

    await actAs(db, vendor.authUserId);
    const { rows } = await db.query('select id from public.v_correctable_entries');
    expect(rows).toHaveLength(0);
  });

  it('drops an entry that has already been corrected', async () => {
    await actAsAdmin(db);
    const entry = await giveCredit(db, vendor, customer, 500);
    await actAsAdmin(db);
    await postEntry(db, {
      vendorId: vendor.id, customerId: customer.id,
      direction: 'debit', kind: 'reversal', amount: 500,
      actorUserId: vendor.authUserId, reversesEntryId: entry.id,
      confirmationMethod: 'vendor_correction',
    });

    await actAs(db, vendor.authUserId);
    const { rows } = await db.query('select id from public.v_correctable_entries');
    expect(rows).toHaveLength(0);
  });

  it("never lists another vendor's entries", async () => {
    const other = await seedVendor(db);
    const otherCustomer = await seedCustomer(db);
    await giveCredit(db, other, otherCustomer, 500);

    await actAs(db, vendor.authUserId);
    const { rows } = await db.query('select id from public.v_correctable_entries');
    expect(rows).toHaveLength(0);
  });

  it('counts corrections as a fraud signal alongside the other methods', async () => {
    await actAsAdmin(db);
    const a = await giveCredit(db, vendor, customer, 500);
    await actAsAdmin(db);
    await postEntry(db, {
      vendorId: vendor.id, customerId: customer.id,
      direction: 'debit', kind: 'reversal', amount: 500,
      actorUserId: vendor.authUserId, reversesEntryId: a.id,
      confirmationMethod: 'vendor_correction',
    });

    await actAs(db, vendor.authUserId);
    const { rows } = await db.query(
      'select vendor_corrections, debits from public.v_vendor_confirmation_mix'
    );
    // A vendor correcting constantly should be as visible as one harvesting
    // PINs on their own device.
    expect(Number(rows[0].vendor_corrections)).toBe(1);
  });
});
