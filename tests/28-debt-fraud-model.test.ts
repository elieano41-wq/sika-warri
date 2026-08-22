// The debt register, and the inverted fraud model that shapes it.
//
// ============================================================================
// THE INVERSION. Everything in ledger_entries assumes the vendor LOSES money by
// lying: a fabricated change credit means they owe someone money they never
// held. That is why credits need no confirmation.
//
// A fabricated DEBT earns the vendor money. So debt creation is the highest-risk
// write in the system and needs the strongest confirmation, not the weakest.
// These tests are the proof that it has it.
// ============================================================================
//
// The three attacks worth naming, each with its test below:
//
//   1. A vendor posts a debt marked as confirmed without the customer agreeing.
//   2. A vendor types the customer's PIN on the vendor's own phone.
//   3. A vendor pre-loads debts against phone numbers, and signup turns them
//      into established fact.
//
// If any of these works, the register is worse than the paper carnet it
// replaces — because it looks authoritative.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import {
  connect, reset, actAs, actAsAdmin, seedVendor, seedCustomer, postEntry,
  postDebt, declareDebt, settleDebt, createPendingDebt, confirmPendingDebt,
  reviewDebt, debtOf, claimCustomer, debtEntryCount, sqlstateOf, randomUUID,
  type SeededVendor, type SeededCustomer,
} from './helpers/db';

let db: pg.Client;
let vendor: SeededVendor;
let client: SeededCustomer;

beforeAll(async () => { db = await connect(); });
afterAll(async () => { await actAsAdmin(db); await db.end(); });

beforeEach(async () => {
  await reset(db);
  vendor = await seedVendor(db);
  client = await seedCustomer(db);
});

// ---------------------------------------------------------------------------
// Attack 1 — forging the confirmation
// ---------------------------------------------------------------------------

describe('a vendor cannot mark a debt as confirmed', () => {
  it('a vendor session posting own_device is REFUSED', async () => {
    // The single most important test in this file. If a session-bound caller
    // could assert own_device, the two-device handshake would be decoration and
    // every déclarée debt could be laundered into a confirmée one.
    await actAs(db, vendor.authUserId);
    const code = await sqlstateOf(() =>
      postDebt(db, {
        vendorId: vendor.id, customerId: client.id, direction: 'owed',
        kind: 'debt', amount: 1000, actorUserId: vendor.authUserId,
        confirmation: 'own_device',
      })
    );
    expect(code).toBe('SW027');
    expect(await debtEntryCount(db)).toBe(0);
  });

  it('a vendor session CAN post a declared debt, so the refusal is specific', async () => {
    await actAs(db, vendor.authUserId);
    const e = await postDebt(db, {
      vendorId: vendor.id, customerId: client.id, direction: 'owed',
      kind: 'debt', amount: 1000, actorUserId: vendor.authUserId,
    });
    expect(e.confirmation_method).toBe('declared');
    expect(e.customer_confirmed_at).toBeNull();
  });

  it('confirm_pending_debt is not reachable from any client session', async () => {
    await actAs(db, vendor.authUserId);
    const code = await sqlstateOf(() =>
      db.query('select public.confirm_pending_debt($1::uuid, $2::uuid)', [
        randomUUID(), vendor.authUserId,
      ])
    );
    // Not granted to authenticated at all, so privilege is refused before the
    // function's own guard is even reached.
    expect(code).toBe('42501');
  });

  it('only the NAMED customer can confirm a proposal', async () => {
    const autre = await seedCustomer(db);
    await actAs(db, vendor.authUserId);
    const p = await createPendingDebt(db, {
      vendorId: vendor.id, customerId: client.id, amount: 800,
      actorUserId: vendor.authUserId,
    });

    await actAsAdmin(db);
    const code = await sqlstateOf(() =>
      db.query('select public.confirm_pending_debt($1::uuid, $2::uuid)', [
        p.id, autre.authUserId,
      ])
    );
    expect(code).toBe('SW001');
    expect(await debtEntryCount(db)).toBe(0);
  });

  it('the vendor cannot confirm their own proposal even privileged', async () => {
    await actAs(db, vendor.authUserId);
    const p = await createPendingDebt(db, {
      vendorId: vendor.id, customerId: client.id, amount: 800,
      actorUserId: vendor.authUserId,
    });

    await actAsAdmin(db);
    const code = await sqlstateOf(() =>
      db.query('select public.confirm_pending_debt($1::uuid, $2::uuid)', [
        p.id, vendor.authUserId,
      ])
    );
    expect(code).toBe('SW001');
  });

  it('the customer CAN confirm, and the entry is then own_device', async () => {
    await actAs(db, vendor.authUserId);
    const p = await createPendingDebt(db, {
      vendorId: vendor.id, customerId: client.id, amount: 800,
      actorUserId: vendor.authUserId,
    });

    const e = await confirmPendingDebt(db, p.id, client.authUserId!);
    expect(e.confirmation_method).toBe('own_device');
    expect(e.customer_confirmed_at).not.toBeNull();
    expect(await debtOf(db, vendor.id, client.id)).toBe(800);
  });

  it('confirming twice returns the SAME entry, not a second debt', async () => {
    await actAs(db, vendor.authUserId);
    const p = await createPendingDebt(db, {
      vendorId: vendor.id, customerId: client.id, amount: 800,
      actorUserId: vendor.authUserId,
    });
    const a = await confirmPendingDebt(db, p.id, client.authUserId!);
    const b = await confirmPendingDebt(db, p.id, client.authUserId!);
    expect(b.id).toBe(a.id);
    expect(await debtEntryCount(db)).toBe(1);
    expect(await debtOf(db, vendor.id, client.id)).toBe(800);
  });
});

// ---------------------------------------------------------------------------
// Attack 2 — the vendor-device PIN fallback
// ---------------------------------------------------------------------------

describe('vendor_device is forbidden for debt, structurally', () => {
  it('passing it is refused BY NAME', async () => {
    await actAs(db, vendor.authUserId);
    const code = await sqlstateOf(() =>
      db.query(
        `select public.post_debt_entry($1::uuid,$2::uuid,'owed','debt',500,$3::text,$4::uuid,'vendor_device',null,null)`,
        [vendor.id, client.id, randomUUID(), vendor.authUserId]
      )
    );
    expect(code).toBe('SW023');
  });

  it('it cannot be stored even by a privileged direct insert', async () => {
    // The column's check constraint is the real guard: not a rule the
    // application remembers, a value the database has no room for.
    await actAsAdmin(db);
    const code = await sqlstateOf(() =>
      db.query(
        `insert into public.debt_entries
           (vendor_id, customer_id, direction, kind, amount_cfa, idempotency_key,
            confirmation_method, customer_confirmed_at, created_by)
         values ($1,$2,'owed','debt',500,$3,'vendor_device', now(), $4)`,
        [vendor.id, client.id, randomUUID(), vendor.authUserId]
      )
    );
    expect(code).toBe('23514'); // check_violation
  });

  it("'vendor_device' is absent from the column's allowed values", async () => {
    await actAsAdmin(db);
    const { rows } = await db.query(
      `select pg_get_constraintdef(oid) as def
         from pg_constraint
        where conrelid = 'public.debt_entries'::regclass
          and pg_get_constraintdef(oid) like '%confirmation_method%'
          and pg_get_constraintdef(oid) like '%own_device%'`
    );
    expect(rows.length).toBeGreaterThan(0);
    const def = rows.map((r) => r.def).join(' ');
    expect(def).toContain('own_device');
    expect(def).toContain('declared');
    expect(def).not.toContain('vendor_device');
  });

  it('the ledger still allows it, so this is a debt-specific rule', async () => {
    // Proves the test above is about debt, not about the value being gone
    // everywhere. Amendment I's degraded path still exists for change.
    await actAsAdmin(db);
    await postEntry(db, {
      vendorId: vendor.id, customerId: client.id, direction: 'credit',
      kind: 'change', amount: 500, actorUserId: vendor.authUserId,
    });
    const e = await postEntry(db, {
      vendorId: vendor.id, customerId: client.id, direction: 'debit',
      kind: 'purchase', amount: 100, actorUserId: vendor.authUserId,
      customerConfirmed: true, confirmationMethod: 'vendor_device',
    });
    expect(e.confirmation_method).toBe('vendor_device');
  });
});

// ---------------------------------------------------------------------------
// Attack 3 — pre-loading debts against phone numbers
// ---------------------------------------------------------------------------

describe('registering never turns a claim into a fact', () => {
  it('a debt CAN be declared against an unregistered number', async () => {
    // Required: this is how the paper carnet works and what makes the register
    // usable on day one.
    const inconnu = await seedCustomer(db, { registered: false });
    await actAs(db, vendor.authUserId);
    const e = await declareDebt(db, {
      vendorId: vendor.id, customerId: inconnu.id, amount: 2000,
      actorUserId: vendor.authUserId,
    });
    expect(e.confirmation_method).toBe('declared');
    expect(await debtOf(db, vendor.id, inconnu.id)).toBe(2000);
  });

  it('a proposal cannot be made to an unregistered number', async () => {
    // There is no device to confirm on, so the caller is told which situation it
    // is in rather than being handed a proposal nobody can answer.
    const inconnu = await seedCustomer(db, { registered: false });
    await actAs(db, vendor.authUserId);
    const code = await sqlstateOf(() =>
      createPendingDebt(db, {
        vendorId: vendor.id, customerId: inconnu.id, amount: 2000,
        actorUserId: vendor.authUserId,
      })
    );
    expect(code).toBe('SW008');
  });

  it('pre-loaded debts SURFACE FOR REVIEW after registration', async () => {
    // The attack: a vendor writes claims against a list of numbers and waits.
    const inconnu = await seedCustomer(db, { registered: false });
    await actAs(db, vendor.authUserId);
    await declareDebt(db, {
      vendorId: vendor.id, customerId: inconnu.id, amount: 2000,
      actorUserId: vendor.authUserId, note: 'pré-chargée',
    });

    // They register with that number.
    const authId = await claimCustomer(db, inconnu.id);

    await actAs(db, authId);
    const { rows } = await db.query(
      'select * from public.my_review_queue($1::uuid)', [authId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].register).toBe('debt');
    expect(rows[0].amount_cfa).toBe(2000);
  });

  it('registering does NOT confirm anything', async () => {
    const inconnu = await seedCustomer(db, { registered: false });
    await actAs(db, vendor.authUserId);
    const e = await declareDebt(db, {
      vendorId: vendor.id, customerId: inconnu.id, amount: 2000,
      actorUserId: vendor.authUserId,
    });
    const authId = await claimCustomer(db, inconnu.id);

    await actAsAdmin(db);
    const { rows } = await db.query(
      'select customer_confirmed_at from public.debt_entries where id = $1', [e.id]
    );
    // Still a claim. Signup is not agreement.
    expect(rows[0].customer_confirmed_at).toBeNull();

    await actAs(db, authId);
    const { rows: h } = await db.query(
      'select * from public.customer_debt_history($1::uuid, $2::uuid)', [authId, vendor.id]
    );
    expect(h[0].state).toBe('declared');
    expect(h[0].reviewable).toBe(true);
  });

  it('unconfirmed CHANGE entries surface too, so both ledgers behave alike', async () => {
    const inconnu = await seedCustomer(db, { registered: false });
    await actAsAdmin(db);
    await postEntry(db, {
      vendorId: vendor.id, customerId: inconnu.id, direction: 'credit',
      kind: 'change', amount: 700, actorUserId: vendor.authUserId,
    });
    await actAs(db, vendor.authUserId);
    await declareDebt(db, {
      vendorId: vendor.id, customerId: inconnu.id, amount: 300,
      actorUserId: vendor.authUserId,
    });

    const authId = await claimCustomer(db, inconnu.id);
    await actAs(db, authId);
    const { rows } = await db.query(
      'select * from public.my_review_queue($1::uuid)', [authId]
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.register).sort()).toEqual(['change', 'debt']);
  });

  it('a reviewed entry leaves the queue', async () => {
    const inconnu = await seedCustomer(db, { registered: false });
    await actAs(db, vendor.authUserId);
    const e = await declareDebt(db, {
      vendorId: vendor.id, customerId: inconnu.id, amount: 2000,
      actorUserId: vendor.authUserId,
    });
    const authId = await claimCustomer(db, inconnu.id);

    await actAs(db, authId);
    await reviewDebt(db, e.id, 'accepted', authId);
    const { rows } = await db.query(
      'select * from public.my_review_queue($1::uuid)', [authId]
    );
    expect(rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Confirmée / déclarée / contestée
// ---------------------------------------------------------------------------

describe('the three states are derived, never stored as mutable flags', () => {
  it('accepting a claim makes it confirmed WITHOUT touching the entry', async () => {
    await actAs(db, vendor.authUserId);
    const e = await declareDebt(db, {
      vendorId: vendor.id, customerId: client.id, amount: 1000,
      actorUserId: vendor.authUserId,
    });

    await actAs(db, client.authUserId!);
    await reviewDebt(db, e.id, 'accepted', client.authUserId!);

    const { rows } = await db.query(
      'select * from public.customer_debt_history($1::uuid, $2::uuid)',
      [client.authUserId, vendor.id]
    );
    expect(rows[0].state).toBe('confirmed');
    expect(rows[0].reviewable).toBe(false);

    // The entry itself is untouched: append-only holds.
    await actAsAdmin(db);
    const { rows: brut } = await db.query(
      'select confirmation_method, customer_confirmed_at from public.debt_entries where id = $1',
      [e.id]
    );
    expect(brut[0].confirmation_method).toBe('declared');
    expect(brut[0].customer_confirmed_at).toBeNull();
  });

  it('disputing flags it and does NOT delete it', async () => {
    await actAs(db, vendor.authUserId);
    const e = await declareDebt(db, {
      vendorId: vendor.id, customerId: client.id, amount: 1000,
      actorUserId: vendor.authUserId,
    });

    await actAs(db, client.authUserId!);
    await reviewDebt(db, e.id, 'disputed', client.authUserId!, "Je n'ai rien pris");

    // The debt still stands as a figure — a dispute is not a write-off.
    expect(await debtOf(db, vendor.id, client.id)).toBe(1000);

    const { rows } = await db.query(
      'select * from public.customer_debt_history($1::uuid, $2::uuid)',
      [client.authUserId, vendor.id]
    );
    expect(rows[0].state).toBe('disputed');
    expect(rows[0].dispute_reason).toBe("Je n'ai rien pris");
  });

  it('the VENDOR sees the dispute and its reason', async () => {
    await actAs(db, vendor.authUserId);
    const e = await declareDebt(db, {
      vendorId: vendor.id, customerId: client.id, amount: 1000,
      actorUserId: vendor.authUserId,
    });
    await actAs(db, client.authUserId!);
    await reviewDebt(db, e.id, 'disputed', client.authUserId!, 'Montant faux');

    await actAs(db, vendor.authUserId);
    const { rows } = await db.query(
      'select * from public.vendor_debt_history($1::uuid, $2::uuid, $3::uuid)',
      [vendor.id, client.id, vendor.authUserId]
    );
    expect(rows[0].state).toBe('disputed');
    expect(rows[0].dispute_reason).toBe('Montant faux');
  });

  it('a VENDOR cannot review a claim they made', async () => {
    // Accepting your own claim on the debtor's behalf is the fraud with an
    // extra step.
    await actAs(db, vendor.authUserId);
    const e = await declareDebt(db, {
      vendorId: vendor.id, customerId: client.id, amount: 1000,
      actorUserId: vendor.authUserId,
    });
    const code = await sqlstateOf(() =>
      reviewDebt(db, e.id, 'accepted', vendor.authUserId)
    );
    expect(code).toBe('SW024');
  });

  it('another customer cannot review it either', async () => {
    const autre = await seedCustomer(db);
    await actAs(db, vendor.authUserId);
    const e = await declareDebt(db, {
      vendorId: vendor.id, customerId: client.id, amount: 1000,
      actorUserId: vendor.authUserId,
    });
    await actAs(db, autre.authUserId!);
    const code = await sqlstateOf(() =>
      reviewDebt(db, e.id, 'accepted', autre.authUserId!)
    );
    expect(code).toBe('SW024');
  });

  it('an entry can be reviewed ONCE, so a dispute cannot be pressured away', async () => {
    await actAs(db, vendor.authUserId);
    const e = await declareDebt(db, {
      vendorId: vendor.id, customerId: client.id, amount: 1000,
      actorUserId: vendor.authUserId,
    });
    await actAs(db, client.authUserId!);
    await reviewDebt(db, e.id, 'disputed', client.authUserId!);
    const code = await sqlstateOf(() =>
      reviewDebt(db, e.id, 'accepted', client.authUserId!)
    );
    expect(code).toBe('SW025');
  });

  it('an already-confirmed debt cannot be reviewed', async () => {
    await actAs(db, vendor.authUserId);
    const p = await createPendingDebt(db, {
      vendorId: vendor.id, customerId: client.id, amount: 800,
      actorUserId: vendor.authUserId,
    });
    const e = await confirmPendingDebt(db, p.id, client.authUserId!);

    await actAs(db, client.authUserId!);
    const code = await sqlstateOf(() =>
      reviewDebt(db, e.id, 'disputed', client.authUserId!)
    );
    // A customer must not be able to walk back what they agreed to on their own
    // device.
    expect(code).toBe('SW025');
  });
});

// ---------------------------------------------------------------------------
// Caps, limits, and rule 2 on this register
// ---------------------------------------------------------------------------

describe('the debt cap and the floor', () => {
  it('defaults to 10 000 F', async () => {
    await actAsAdmin(db);
    const { rows } = await db.query(
      'select max_debt_per_customer from public.vendors where id = $1', [vendor.id]
    );
    expect(rows[0].max_debt_per_customer).toBe(10000);
  });

  it('a debt over the cap is refused and nothing is written', async () => {
    await actAs(db, vendor.authUserId);
    const code = await sqlstateOf(() =>
      declareDebt(db, {
        vendorId: vendor.id, customerId: client.id, amount: 10001,
        actorUserId: vendor.authUserId,
      })
    );
    expect(code).toBe('SW020');
    expect(await debtEntryCount(db)).toBe(0);
  });

  it('the cap is cumulative, not per entry', async () => {
    await actAs(db, vendor.authUserId);
    await declareDebt(db, {
      vendorId: vendor.id, customerId: client.id, amount: 9000,
      actorUserId: vendor.authUserId,
    });
    const code = await sqlstateOf(() =>
      declareDebt(db, {
        vendorId: vendor.id, customerId: client.id, amount: 1500,
        actorUserId: vendor.authUserId,
      })
    );
    expect(code).toBe('SW020');
    expect(await debtOf(db, vendor.id, client.id)).toBe(9000);
  });

  it('a proposal is refused at the cap too, before the customer is asked', async () => {
    await actAs(db, vendor.authUserId);
    await declareDebt(db, {
      vendorId: vendor.id, customerId: client.id, amount: 9500,
      actorUserId: vendor.authUserId,
    });
    const code = await sqlstateOf(() =>
      createPendingDebt(db, {
        vendorId: vendor.id, customerId: client.id, amount: 1000,
        actorUserId: vendor.authUserId,
      })
    );
    expect(code).toBe('SW020');
  });

  it('a debt cannot be repaid below zero', async () => {
    // Rule 2 on this register. A customer who has paid everything owes nothing;
    // they do not owe less than nothing.
    await actAs(db, vendor.authUserId);
    await declareDebt(db, {
      vendorId: vendor.id, customerId: client.id, amount: 1000,
      actorUserId: vendor.authUserId,
    });
    const code = await sqlstateOf(() =>
      settleDebt(db, {
        vendorId: vendor.id, customerId: client.id, amount: 1500,
        actorUserId: vendor.authUserId,
      })
    );
    expect(code).toBe('SW021');
    expect(await debtOf(db, vendor.id, client.id)).toBe(1000);
  });

  it('settling exactly clears it', async () => {
    await actAs(db, vendor.authUserId);
    await declareDebt(db, {
      vendorId: vendor.id, customerId: client.id, amount: 1000,
      actorUserId: vendor.authUserId,
    });
    await settleDebt(db, {
      vendorId: vendor.id, customerId: client.id, amount: 1000,
      actorUserId: vendor.authUserId,
    });
    expect(await debtOf(db, vendor.id, client.id)).toBe(0);
    // Both rows survive: settlement is an entry, not a deletion.
    expect(await debtEntryCount(db)).toBe(2);
  });

  it('creating debt is rate-limited per vendor', async () => {
    // A vendor bulk-loading claims against a list of numbers is the abuse this
    // register makes possible, so the dangerous direction is throttled.
    await actAs(db, vendor.authUserId);
    for (let i = 0; i < 30; i += 1) {
      const c = await seedCustomer(db, { registered: false });
      await actAs(db, vendor.authUserId);
      await declareDebt(db, {
        vendorId: vendor.id, customerId: c.id, amount: 100,
        actorUserId: vendor.authUserId,
      });
    }
    const c = await seedCustomer(db, { registered: false });
    await actAs(db, vendor.authUserId);
    const code = await sqlstateOf(() =>
      declareDebt(db, {
        vendorId: vendor.id, customerId: c.id, amount: 100,
        actorUserId: vendor.authUserId,
      })
    );
    expect(code).toBe('SW022');
  });

  it('repayments are NOT rate-limited, because they favour the customer', async () => {
    await actAs(db, vendor.authUserId);
    await declareDebt(db, {
      vendorId: vendor.id, customerId: client.id, amount: 3000,
      actorUserId: vendor.authUserId,
    });
    for (let i = 0; i < 40; i += 1) {
      await settleDebt(db, {
        vendorId: vendor.id, customerId: client.id, amount: 50,
        actorUserId: vendor.authUserId,
      });
    }
    expect(await debtOf(db, vendor.id, client.id)).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// Append-only
// ---------------------------------------------------------------------------

describe('the debt ledger is append-only', () => {
  it('UPDATE is refused', async () => {
    await actAs(db, vendor.authUserId);
    const e = await declareDebt(db, {
      vendorId: vendor.id, customerId: client.id, amount: 1000,
      actorUserId: vendor.authUserId,
    });
    await actAsAdmin(db);
    const code = await sqlstateOf(() =>
      db.query('update public.debt_entries set amount_cfa = 5000 where id = $1', [e.id])
    );
    expect(code).toBe('SW019');
  });

  it('DELETE is refused', async () => {
    await actAs(db, vendor.authUserId);
    const e = await declareDebt(db, {
      vendorId: vendor.id, customerId: client.id, amount: 1000,
      actorUserId: vendor.authUserId,
    });
    await actAsAdmin(db);
    const code = await sqlstateOf(() =>
      db.query('delete from public.debt_entries where id = $1', [e.id])
    );
    expect(code).toBe('SW019');
  });

  it('authenticated has no write privilege at all', async () => {
    await actAsAdmin(db);
    const { rows } = await db.query(
      `select
         has_table_privilege('authenticated','public.debt_entries','insert') as i,
         has_table_privilege('authenticated','public.debt_entries','update') as u,
         has_table_privilege('authenticated','public.debt_entries','delete') as d,
         has_table_privilege('authenticated','public.debt_entries','select') as s`
    );
    expect(rows[0].i).toBe(false);
    expect(rows[0].u).toBe(false);
    expect(rows[0].d).toBe(false);
    expect(rows[0].s).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Isolation — the credit-bureau rule
// ---------------------------------------------------------------------------

describe('debtor information never crosses vendors', () => {
  it('vendor B cannot see vendor A debts', async () => {
    const b = await seedVendor(db);
    await actAs(db, vendor.authUserId);
    await declareDebt(db, {
      vendorId: vendor.id, customerId: client.id, amount: 4000,
      actorUserId: vendor.authUserId,
    });

    await actAs(db, b.authUserId);
    const { rows } = await db.query('select * from public.debt_entries');
    expect(rows).toEqual([]);
  });

  it('vendor B asking for vendor A debtor list is refused', async () => {
    const b = await seedVendor(db);
    await actAs(db, b.authUserId);
    const code = await sqlstateOf(() =>
      db.query('select * from public.vendor_debtors($1::uuid, $2::uuid)', [
        vendor.id, b.authUserId,
      ])
    );
    expect(code).toBe('SW001');
  });

  it("a vendor's debtor list shows only their OWN debts", async () => {
    // The rule that keeps this from being a credit reference agency: a vendor
    // learns what is owed to THEM, never what someone owes elsewhere.
    const b = await seedVendor(db);
    await actAs(db, vendor.authUserId);
    await declareDebt(db, {
      vendorId: vendor.id, customerId: client.id, amount: 4000,
      actorUserId: vendor.authUserId,
    });
    await actAs(db, b.authUserId);
    await declareDebt(db, {
      vendorId: b.id, customerId: client.id, amount: 1500,
      actorUserId: b.authUserId,
    });

    await actAs(db, vendor.authUserId);
    const { rows } = await db.query(
      'select * from public.vendor_debtors($1::uuid, $2::uuid)', [vendor.id, vendor.authUserId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].debt_cfa).toBe(4000);
    // Not 5500. The other vendor's claim is invisible and uncountable.
    expect(rows.some((r) => r.debt_cfa === 5500)).toBe(false);
  });

  it('a customer cannot see another customer debts', async () => {
    const autre = await seedCustomer(db);
    await actAs(db, vendor.authUserId);
    await declareDebt(db, {
      vendorId: vendor.id, customerId: client.id, amount: 4000,
      actorUserId: vendor.authUserId,
    });

    await actAs(db, autre.authUserId!);
    const { rows } = await db.query('select * from public.debt_entries');
    expect(rows).toEqual([]);
  });

  it('no function returns a debt total across vendors', async () => {
    // A single "total debt" figure would be exactly the credit-bureau product
    // the hard rules forbid, so no such function exists. The customer's own view
    // is per shop.
    await actAsAdmin(db);
    const { rows } = await db.query(
      `select p.proname, pg_get_function_result(p.oid) as res
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname like '%debt%'`
    );
    const noms = rows.map((r) => r.proname);
    expect(noms).not.toContain('customer_debt_total');
    expect(noms).not.toContain('total_debt');
    expect(noms).not.toContain('debt_score');
  });
});
