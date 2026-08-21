// Acceptance tests 2, 3, 4, 6 and 7 — the ledger invariants.

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
  vendor = await seedVendor(db, { cap: 3000 });
  customer = await seedCustomer(db);
});

describe('acceptance test 2 — a debit may not exceed the balance', () => {
  it('rejects and writes nothing', async () => {
    await giveCredit(db, vendor, customer, 500);
    await actAsAdmin(db);

    const code = await sqlstateOf(() =>
      postEntry(db, {
        vendorId: vendor.id,
        customerId: customer.id,
        direction: 'debit',
        kind: 'purchase',
        amount: 501, // one franc too far
        actorUserId: vendor.authUserId,
        customerConfirmed: true,
      })
    );

    expect(code).toBe('SW006'); // SIKA_INSUFFICIENT_BALANCE
    expect(await entryCount(db)).toBe(1);
    expect(await balanceOf(db, vendor.id, customer.id)).toBe(500);
  });

  it('allows spending the balance down to exactly zero', async () => {
    await giveCredit(db, vendor, customer, 500);
    await actAsAdmin(db);

    await postEntry(db, {
      vendorId: vendor.id,
      customerId: customer.id,
      direction: 'debit',
      kind: 'purchase',
      amount: 500,
      actorUserId: vendor.authUserId,
      customerConfirmed: true,
    });

    // Zero is fine. Negative is what rule 2 forbids, because a negative
    // balance is credit extension and a different regulatory regime.
    expect(await balanceOf(db, vendor.id, customer.id)).toBe(0);
  });

  it('rejects a debit against no balance at all', async () => {
    await actAsAdmin(db);
    const code = await sqlstateOf(() =>
      postEntry(db, {
        vendorId: vendor.id,
        customerId: customer.id,
        direction: 'debit',
        kind: 'purchase',
        amount: 100,
        actorUserId: vendor.authUserId,
        customerConfirmed: true,
      })
    );
    expect(code).toBe('SW006');
  });
});

describe('acceptance test 3 — a credit may not breach the per-customer cap', () => {
  it('rejects a credit that would exceed the cap', async () => {
    await giveCredit(db, vendor, customer, 2800);
    await actAsAdmin(db);

    const code = await sqlstateOf(() =>
      postEntry(db, {
        vendorId: vendor.id,
        customerId: customer.id,
        direction: 'credit',
        kind: 'change',
        amount: 300, // 3100 > 3000
        actorUserId: vendor.authUserId,
      })
    );

    expect(code).toBe('SW005'); // SIKA_CAP_EXCEEDED
    expect(await balanceOf(db, vendor.id, customer.id)).toBe(2800);
  });

  it('allows a credit landing exactly on the cap', async () => {
    await giveCredit(db, vendor, customer, 2800);
    await actAsAdmin(db);

    await postEntry(db, {
      vendorId: vendor.id,
      customerId: customer.id,
      direction: 'credit',
      kind: 'change',
      amount: 200,
      actorUserId: vendor.authUserId,
    });

    expect(await balanceOf(db, vendor.id, customer.id)).toBe(3000);
  });

  it('respects a vendor-specific cap, not a hardcoded 3000', async () => {
    const strict = await seedVendor(db, { cap: 1000 });
    await giveCredit(db, strict, customer, 1000);
    await actAsAdmin(db);

    const code = await sqlstateOf(() =>
      postEntry(db, {
        vendorId: strict.id,
        customerId: customer.id,
        direction: 'credit',
        kind: 'change',
        amount: 1,
        actorUserId: strict.authUserId,
      })
    );
    expect(code).toBe('SW005');
  });

  it('caps per customer, not per vendor in total', async () => {
    // Two customers may each hold up to the cap at the same vendor. The limit
    // bounds one relationship's exposure, not the shop's whole book.
    const other = await seedCustomer(db);
    await giveCredit(db, vendor, customer, 3000);
    await giveCredit(db, vendor, other, 3000);

    expect(await balanceOf(db, vendor.id, customer.id)).toBe(3000);
    expect(await balanceOf(db, vendor.id, other.id)).toBe(3000);
  });
});

describe('acceptance test 4 — idempotent replay', () => {
  it('returns the original entry and creates no duplicate', async () => {
    await actAsAdmin(db);
    const key = randomUUID();

    const first = await postEntry(db, {
      vendorId: vendor.id,
      customerId: customer.id,
      direction: 'credit',
      kind: 'change',
      amount: 500,
      actorUserId: vendor.authUserId,
      idempotencyKey: key,
    });

    const replay = await postEntry(db, {
      vendorId: vendor.id,
      customerId: customer.id,
      direction: 'credit',
      kind: 'change',
      amount: 500,
      actorUserId: vendor.authUserId,
      idempotencyKey: key,
    });

    expect(replay.id).toBe(first.id);
    expect(replay.created_at).toEqual(first.created_at);
    expect(await entryCount(db)).toBe(1);
    expect(await balanceOf(db, vendor.id, customer.id)).toBe(500);
  });

  it('stays a no-op even when the amount differs on resend', async () => {
    // The key identifies the intent. A queue resending with mutated content
    // must not be able to overwrite or append; the original stands.
    await actAsAdmin(db);
    const key = randomUUID();

    const first = await postEntry(db, {
      vendorId: vendor.id, customerId: customer.id,
      direction: 'credit', kind: 'change', amount: 500,
      actorUserId: vendor.authUserId, idempotencyKey: key,
    });

    const replay = await postEntry(db, {
      vendorId: vendor.id, customerId: customer.id,
      direction: 'credit', kind: 'change', amount: 999,
      actorUserId: vendor.authUserId, idempotencyKey: key,
    });

    expect(replay.id).toBe(first.id);
    expect(replay.amount_cfa).toBe(500);
    expect(await entryCount(db)).toBe(1);
  });

  it('replays even once the cap would now reject a fresh credit', async () => {
    // Why idempotency is checked before the balance guards. An offline credit
    // that already synced must keep replaying cleanly, or the vendor sees a
    // phantom "plafond dépassé" for an entry that is already recorded.
    await actAsAdmin(db);
    const key = randomUUID();

    const first = await postEntry(db, {
      vendorId: vendor.id, customerId: customer.id,
      direction: 'credit', kind: 'change', amount: 3000,
      actorUserId: vendor.authUserId, idempotencyKey: key,
    });

    const replay = await postEntry(db, {
      vendorId: vendor.id, customerId: customer.id,
      direction: 'credit', kind: 'change', amount: 3000,
      actorUserId: vendor.authUserId, idempotencyKey: key,
    });

    expect(replay.id).toBe(first.id);
    expect(await entryCount(db)).toBe(1);
  });

  it('scopes keys per vendor — the same key at two vendors is two entries', async () => {
    const second = await seedVendor(db);
    await actAsAdmin(db);
    const key = 'shared-key-abc';

    const a = await postEntry(db, {
      vendorId: vendor.id, customerId: customer.id,
      direction: 'credit', kind: 'change', amount: 100,
      actorUserId: vendor.authUserId, idempotencyKey: key,
    });
    const b = await postEntry(db, {
      vendorId: second.id, customerId: customer.id,
      direction: 'credit', kind: 'change', amount: 100,
      actorUserId: second.authUserId, idempotencyKey: key,
    });

    expect(a.id).not.toBe(b.id);
    expect(await entryCount(db)).toBe(2);
  });
});

describe('acceptance test 6 — the ledger is append-only', () => {
  it('UPDATE fails for the authenticated role', async () => {
    const entry = await giveCredit(db, vendor, customer, 500);
    await actAs(db, vendor.authUserId);

    const code = await sqlstateOf(() =>
      db.query('update public.ledger_entries set amount_cfa = 1 where id = $1', [
        entry.id,
      ])
    );
    expect(code).toBe('42501'); // insufficient_privilege
  });

  it('DELETE fails for the authenticated role', async () => {
    const entry = await giveCredit(db, vendor, customer, 500);
    await actAs(db, vendor.authUserId);

    const code = await sqlstateOf(() =>
      db.query('delete from public.ledger_entries where id = $1', [entry.id])
    );
    expect(code).toBe('42501');
  });

  it('TRUNCATE fails for the authenticated role', async () => {
    await actAs(db, vendor.authUserId);
    const code = await sqlstateOf(() =>
      db.query('truncate public.ledger_entries')
    );
    expect(code).toBe('42501');
  });

  it('the privilege is absent from the catalog, not merely unpoliced', async () => {
    await actAsAdmin(db);
    const { rows } = await db.query(
      `select privilege_type from information_schema.table_privileges
        where grantee = 'authenticated'
          and table_schema = 'public'
          and table_name = 'ledger_entries'
        order by privilege_type`
    );
    const granted = rows.map((r) => r.privilege_type);

    expect(granted).toContain('SELECT');
    expect(granted).not.toContain('UPDATE');
    expect(granted).not.toContain('DELETE');
    expect(granted).not.toContain('INSERT');
    expect(granted).not.toContain('TRUNCATE');
  });
});

describe('acceptance test 7 — reversal restores the balance exactly', () => {
  it('returns the balance to its prior value with both entries retained', async () => {
    await actAsAdmin(db);
    const credit = await giveCredit(db, vendor, customer, 500);
    const before = await balanceOf(db, vendor.id, customer.id);
    expect(before).toBe(500);

    await actAsAdmin(db);
    const reversal = await postEntry(db, {
      vendorId: vendor.id,
      customerId: customer.id,
      direction: 'debit', // inverts the credit
      kind: 'reversal',
      amount: 500,
      actorUserId: vendor.authUserId,
      reversesEntryId: credit.id,
      customerConfirmed: true,
    });

    expect(await balanceOf(db, vendor.id, customer.id)).toBe(0);
    expect(reversal.reverses_entry_id).toBe(credit.id);

    // Rule 3: the correction is a new entry and history keeps both.
    await actAs(db, vendor.authUserId);
    const { rows } = await db.query(
      'select id, kind from public.ledger_entries order by created_at'
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.kind)).toEqual(['change', 'reversal']);
  });

  it('refuses a reversal whose amount does not match its target', async () => {
    const credit = await giveCredit(db, vendor, customer, 500);
    await actAsAdmin(db);

    const code = await sqlstateOf(() =>
      postEntry(db, {
        vendorId: vendor.id, customerId: customer.id,
        direction: 'debit', kind: 'reversal', amount: 400,
        actorUserId: vendor.authUserId, reversesEntryId: credit.id,
        customerConfirmed: true,
      })
    );
    expect(code).toBe('SW008');
  });

  it('refuses to reverse the same entry twice', async () => {
    const credit = await giveCredit(db, vendor, customer, 500);

    // Extra headroom, deliberately. Reversing the 500 credit takes the balance
    // to zero, and a second reversal would then be refused for insufficient
    // balance — which would pass the test while proving nothing about double
    // reversal. This second credit keeps the balance sufficient so the
    // one-reversal-per-entry index is what actually rejects it.
    await giveCredit(db, vendor, customer, 500);

    await actAsAdmin(db);
    await postEntry(db, {
      vendorId: vendor.id, customerId: customer.id,
      direction: 'debit', kind: 'reversal', amount: 500,
      actorUserId: vendor.authUserId, reversesEntryId: credit.id,
      customerConfirmed: true,
    });

    // Otherwise repeated corrections against one credit would drain a balance
    // the customer never spent.
    const code = await sqlstateOf(() =>
      postEntry(db, {
        vendorId: vendor.id, customerId: customer.id,
        direction: 'debit', kind: 'reversal', amount: 500,
        actorUserId: vendor.authUserId, reversesEntryId: credit.id,
        customerConfirmed: true,
      })
    );
    expect(code).toBe('23505'); // unique_violation on the partial index
  });

  it("refuses to reverse another vendor's entry", async () => {
    const other = await seedVendor(db);
    const credit = await giveCredit(db, other, customer, 500);
    await actAsAdmin(db);

    const code = await sqlstateOf(() =>
      postEntry(db, {
        vendorId: vendor.id, customerId: customer.id,
        direction: 'debit', kind: 'reversal', amount: 500,
        actorUserId: vendor.authUserId, reversesEntryId: credit.id,
        customerConfirmed: true,
      })
    );
    expect(code).toBe('SW008');
  });

  it('a non-reversal may not reference another entry', async () => {
    const credit = await giveCredit(db, vendor, customer, 500);
    await actAsAdmin(db);

    const code = await sqlstateOf(() =>
      postEntry(db, {
        vendorId: vendor.id, customerId: customer.id,
        direction: 'credit', kind: 'change', amount: 100,
        actorUserId: vendor.authUserId, reversesEntryId: credit.id,
      })
    );
    expect(code).toBe('SW007');
  });
});

describe('receipt code — display only', () => {
  it('is four digits and stable for a given entry', async () => {
    const entry = await giveCredit(db, vendor, customer, 500);
    await actAsAdmin(db);

    const { rows } = await db.query(
      'select public.entry_receipt_code($1) as a, public.entry_receipt_code($1) as b',
      [entry.id]
    );
    expect(rows[0].a).toMatch(/^\d{4}$/);
    expect(rows[0].a).toBe(rows[0].b);
  });

  it('has no function anywhere that resolves an entry FROM a receipt code', async () => {
    // Judgment call 3: display only, never an input, never authorises anything.
    // Guards against a later convenience helper quietly turning a 4-digit
    // non-unique display string into a lookup key.
    await actAsAdmin(db);
    const { rows } = await db.query(
      `select p.proname, pg_get_function_arguments(p.oid) as args
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'`
    );
    const offenders = rows.filter(
      (r) =>
        /receipt/i.test(r.args ?? '') &&
        r.proname !== 'entry_receipt_code'
    );
    expect(offenders).toEqual([]);
  });
});
