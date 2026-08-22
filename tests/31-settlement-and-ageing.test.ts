// Settlement recourse, and the ageing arithmetic.
//
// ============================================================================
// THE EXPOSURE INVERTS TWICE.
//
// Change: the vendor holds the cash, the customer walks away exposed afterwards.
// Debt:   the customer HANDS OVER cash and must trust it was recorded. They are
//         exposed at the moment of payment, with nothing to point at later.
//
// And the common case is not theft — it is an honest vendor at a busy counter
// forgetting to type it in, and two people disagreeing about 2 000 F a month
// later. Settlement stays an unconfirmed vendor write, because gating it would
// trap debts open whenever the customer has no phone. The recourse is built
// around it instead, and this file is the proof that the recourse exists.
// ============================================================================

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import {
  connect, reset, actAs, actAsAdmin, seedVendor, seedCustomer,
  declareDebt, settleDebt, reviewDebt, debtOf, sqlstateOf, randomUUID,
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

/** Post a debt dated `joursAvant` days ago. Ageing needs a past. */
async function detteAgee(montant: number, joursAvant: number) {
  await actAs(db, vendor.authUserId);
  const e = await declareDebt(db, {
    vendorId: vendor.id, customerId: client.id, amount: montant,
    actorUserId: vendor.authUserId,
  });
  // created_at is the only thing tests may rewrite, and only privileged: the
  // append-only trigger blocks it otherwise, which is itself worth knowing.
  await actAsAdmin(db);
  await db.query(
    'alter table public.debt_entries disable trigger debt_entries_no_update'
  );
  await db.query(
    `update public.debt_entries set created_at = now() - ($1 || ' days')::interval where id = $2`,
    [joursAvant, e.id]
  );
  await db.query(
    'alter table public.debt_entries enable trigger debt_entries_no_update'
  );
  return e;
}

async function ageing() {
  await actAsAdmin(db);
  const { rows } = await db.query(
    'select * from public.debt_ageing($1::uuid, $2::uuid)', [vendor.id, client.id]
  );
  return rows[0];
}

// ---------------------------------------------------------------------------
// Acknowledging a settlement
// ---------------------------------------------------------------------------

describe('a settlement is a vendor write the customer can answer', () => {
  it('the vendor records it with no confirmation, as before', async () => {
    await actAs(db, vendor.authUserId);
    await declareDebt(db, {
      vendorId: vendor.id, customerId: client.id, amount: 3000,
      actorUserId: vendor.authUserId,
    });
    const s = await settleDebt(db, {
      vendorId: vendor.id, customerId: client.id, amount: 2000,
      actorUserId: vendor.authUserId,
    });
    expect(s.confirmation_method).toBe('declared');
    expect(await debtOf(db, vendor.id, client.id)).toBe(1000);
  });

  it('it appears in the customer feed, answerable', async () => {
    await actAs(db, vendor.authUserId);
    await declareDebt(db, {
      vendorId: vendor.id, customerId: client.id, amount: 3000,
      actorUserId: vendor.authUserId,
    });
    await settleDebt(db, {
      vendorId: vendor.id, customerId: client.id, amount: 2000,
      actorUserId: vendor.authUserId,
    });

    await actAs(db, client.authUserId!);
    const { rows } = await db.query('select * from public.my_settlements($1::uuid)', [
      client.authUserId,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].amount_cfa).toBe(2000);
    expect(rows[0].state).toBe('declared');
    expect(rows[0].answerable).toBe(true);
    // The figure afterwards, so the notification says what it means.
    expect(rows[0].remaining_debt).toBe(1000);
  });

  it('acknowledging upgrades it to mutually recorded', async () => {
    await actAs(db, vendor.authUserId);
    await declareDebt(db, {
      vendorId: vendor.id, customerId: client.id, amount: 3000,
      actorUserId: vendor.authUserId,
    });
    const s = await settleDebt(db, {
      vendorId: vendor.id, customerId: client.id, amount: 2000,
      actorUserId: vendor.authUserId,
    });

    await actAs(db, client.authUserId!);
    await reviewDebt(db, s.id, 'acknowledged', client.authUserId!);

    const { rows } = await db.query('select * from public.my_settlements($1::uuid)', [
      client.authUserId,
    ]);
    expect(rows[0].state).toBe('acknowledged');
    expect(rows[0].answerable).toBe(false);
    // Optional, never blocking: the money moved when the vendor recorded it.
    expect(await debtOf(db, vendor.id, client.id)).toBe(1000);
  });

  it('a customer can DISPUTE a settlement they did not make', async () => {
    await actAs(db, vendor.authUserId);
    await declareDebt(db, {
      vendorId: vendor.id, customerId: client.id, amount: 3000,
      actorUserId: vendor.authUserId,
    });
    const s = await settleDebt(db, {
      vendorId: vendor.id, customerId: client.id, amount: 2000,
      actorUserId: vendor.authUserId,
    });

    await actAs(db, client.authUserId!);
    await reviewDebt(db, s.id, 'disputed', client.authUserId!, "Je n'ai pas payé ça");

    const { rows } = await db.query('select * from public.my_settlements($1::uuid)', [
      client.authUserId,
    ]);
    expect(rows[0].state).toBe('disputed');
  });

  it('"accepted" is refused on a repayment, and "acknowledged" on a debt', async () => {
    // The verdict has to fit the direction, or "accepted" on a repayment would
    // read as agreeing to owe money that was just paid off.
    await actAs(db, vendor.authUserId);
    const d = await declareDebt(db, {
      vendorId: vendor.id, customerId: client.id, amount: 3000,
      actorUserId: vendor.authUserId,
    });
    const s = await settleDebt(db, {
      vendorId: vendor.id, customerId: client.id, amount: 1000,
      actorUserId: vendor.authUserId,
    });

    await actAs(db, client.authUserId!);
    expect(await sqlstateOf(() => reviewDebt(db, s.id, 'accepted', client.authUserId!)))
      .toBe('SW029');
    expect(await sqlstateOf(() => reviewDebt(db, d.id, 'acknowledged', client.authUserId!)))
      .toBe('SW029');
  });

  it('the VENDOR cannot acknowledge their own settlement', async () => {
    await actAs(db, vendor.authUserId);
    await declareDebt(db, {
      vendorId: vendor.id, customerId: client.id, amount: 3000,
      actorUserId: vendor.authUserId,
    });
    const s = await settleDebt(db, {
      vendorId: vendor.id, customerId: client.id, amount: 1000,
      actorUserId: vendor.authUserId,
    });
    expect(await sqlstateOf(() => reviewDebt(db, s.id, 'acknowledged', vendor.authUserId)))
      .toBe('SW024');
  });
});

// ---------------------------------------------------------------------------
// Claiming a payment that was never recorded
// ---------------------------------------------------------------------------

describe('"j\'ai payé, ce n\'est pas enregistré"', () => {
  async function reclamer(montant: number, motif: string | null = null) {
    const { rows } = await db.query(
      'select * from public.claim_unrecorded_payment($1::uuid, $2::integer, $3::uuid, null, $4::text)',
      [vendor.id, montant, client.authUserId, motif]
    );
    return rows[0];
  }

  it('the customer can file one, and both sides see it', async () => {
    await actAs(db, vendor.authUserId);
    await declareDebt(db, {
      vendorId: vendor.id, customerId: client.id, amount: 3000,
      actorUserId: vendor.authUserId,
    });

    await actAs(db, client.authUserId!);
    const c = await reclamer(2000, 'Payé mardi en espèces');
    expect(c.amount_cfa).toBe(2000);
    expect(c.resolved_at).toBeNull();

    const { rows: cote_client } = await db.query(
      'select * from public.my_payment_claims($1::uuid)', [client.authUserId]
    );
    expect(cote_client).toHaveLength(1);

    await actAs(db, vendor.authUserId);
    const { rows: cote_vendeur } = await db.query(
      'select * from public.my_payment_claims($1::uuid)', [vendor.authUserId]
    );
    expect(cote_vendeur).toHaveLength(1);
    expect(cote_vendeur[0].amount_cfa).toBe(2000);
  });

  it('IT DOES NOT CHANGE THE DEBT', async () => {
    // The mirror fraud. A customer who could unilaterally reduce what they owe
    // would expose the vendor exactly as the vendor currently exposes them.
    await actAs(db, vendor.authUserId);
    await declareDebt(db, {
      vendorId: vendor.id, customerId: client.id, amount: 3000,
      actorUserId: vendor.authUserId,
    });
    await actAs(db, client.authUserId!);
    await reclamer(3000);
    expect(await debtOf(db, vendor.id, client.id)).toBe(3000);
  });

  it('cannot be filed against a shop the customer owes nothing at', async () => {
    await actAs(db, client.authUserId!);
    expect(await sqlstateOf(() => reclamer(500))).toBe('SW030');
  });

  it('only one open claim per pair, so the flag keeps meaning something', async () => {
    await actAs(db, vendor.authUserId);
    await declareDebt(db, {
      vendorId: vendor.id, customerId: client.id, amount: 3000,
      actorUserId: vendor.authUserId,
    });
    await actAs(db, client.authUserId!);
    await reclamer(1000);
    const code = await sqlstateOf(() => reclamer(500));
    expect(code).toBe('23505');
  });

  it('the vendor resolves it by recording the settlement', async () => {
    await actAs(db, vendor.authUserId);
    await declareDebt(db, {
      vendorId: vendor.id, customerId: client.id, amount: 3000,
      actorUserId: vendor.authUserId,
    });
    await actAs(db, client.authUserId!);
    const c = await reclamer(2000);

    await actAs(db, vendor.authUserId);
    const s = await settleDebt(db, {
      vendorId: vendor.id, customerId: client.id, amount: 2000,
      actorUserId: vendor.authUserId,
    });
    const { rows } = await db.query(
      'select * from public.resolve_payment_claim($1::uuid, $2::text, $3::uuid, $4::uuid)',
      [c.id, 'recorded', vendor.authUserId, s.id]
    );
    expect(rows[0].resolution).toBe('recorded');
    expect(rows[0].settled_entry_id).toBe(s.id);
    expect(await debtOf(db, vendor.id, client.id)).toBe(1000);
  });

  it('a REJECTED claim stays visible, because the disagreement is the record', async () => {
    await actAs(db, vendor.authUserId);
    await declareDebt(db, {
      vendorId: vendor.id, customerId: client.id, amount: 3000,
      actorUserId: vendor.authUserId,
    });
    await actAs(db, client.authUserId!);
    const c = await reclamer(2000);

    await actAs(db, vendor.authUserId);
    await db.query(
      'select * from public.resolve_payment_claim($1::uuid, $2::text, $3::uuid, null)',
      [c.id, 'rejected', vendor.authUserId]
    );

    await actAs(db, client.authUserId!);
    const { rows } = await db.query(
      'select * from public.my_payment_claims($1::uuid)', [client.authUserId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].resolution).toBe('rejected');
  });

  it('a vendor cannot WITHDRAW a customer claim', async () => {
    // That would be deleting the complaint against them.
    await actAs(db, vendor.authUserId);
    await declareDebt(db, {
      vendorId: vendor.id, customerId: client.id, amount: 3000,
      actorUserId: vendor.authUserId,
    });
    await actAs(db, client.authUserId!);
    const c = await reclamer(2000);

    await actAs(db, vendor.authUserId);
    const code = await sqlstateOf(() =>
      db.query('select public.resolve_payment_claim($1::uuid, $2::text, $3::uuid, null)', [
        c.id, 'withdrawn', vendor.authUserId,
      ])
    );
    expect(code).toBe('SW032');
  });

  it('a customer cannot REJECT their own claim into the vendor’s favour', async () => {
    await actAs(db, vendor.authUserId);
    await declareDebt(db, {
      vendorId: vendor.id, customerId: client.id, amount: 3000,
      actorUserId: vendor.authUserId,
    });
    await actAs(db, client.authUserId!);
    const c = await reclamer(2000);
    const code = await sqlstateOf(() =>
      db.query('select public.resolve_payment_claim($1::uuid, $2::text, $3::uuid, null)', [
        c.id, 'rejected', client.authUserId,
      ])
    );
    expect(code).toBe('SW032');
  });

  it('an unrelated party sees nothing', async () => {
    const autre = await seedCustomer(db);
    await actAs(db, vendor.authUserId);
    await declareDebt(db, {
      vendorId: vendor.id, customerId: client.id, amount: 3000,
      actorUserId: vendor.authUserId,
    });
    await actAs(db, client.authUserId!);
    await reclamer(2000);

    await actAs(db, autre.authUserId!);
    const { rows } = await db.query('select * from public.payment_claims');
    expect(rows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Ageing, and the FIFO arithmetic
// ---------------------------------------------------------------------------

describe('ageing allocates repayments oldest-first', () => {
  it('buckets an untouched debt by its own age', async () => {
    await detteAgee(1000, 3);
    await detteAgee(2000, 15);
    await detteAgee(4000, 45);
    await detteAgee(500, 200);

    const a = await ageing();
    expect(a.bucket_0_7).toBe(1000);
    expect(a.bucket_8_30).toBe(2000);
    expect(a.bucket_31_90).toBe(4000);
    expect(a.bucket_90).toBe(500);
    expect(a.over_30_cfa).toBe(4500);
    expect(a.oldest_days).toBe(200);
  });

  it('a repayment clears the OLDEST debt first', async () => {
    await detteAgee(1000, 100);
    await detteAgee(2000, 5);

    await actAs(db, vendor.authUserId);
    await settleDebt(db, {
      vendorId: vendor.id, customerId: client.id, amount: 1000,
      actorUserId: vendor.authUserId,
    });

    const a = await ageing();
    // The 100-day debt is gone, not the recent one.
    expect(a.bucket_90).toBe(0);
    expect(a.bucket_0_7).toBe(2000);
    expect(a.oldest_days).toBeLessThanOrEqual(7);
  });

  it('a partial repayment splits one entry across the boundary correctly', async () => {
    await detteAgee(5000, 60);
    await actAs(db, vendor.authUserId);
    await settleDebt(db, {
      vendorId: vendor.id, customerId: client.id, amount: 2000,
      actorUserId: vendor.authUserId,
    });

    const a = await ageing();
    // 3 000 of the 5 000 is still unpaid, and it is still 60 days old.
    expect(a.bucket_31_90).toBe(3000);
    expect(a.over_30_cfa).toBe(3000);
  });

  it('a repayment spanning two debts consumes them in order', async () => {
    await detteAgee(1000, 120);
    await detteAgee(1000, 60);
    await detteAgee(1000, 2);

    await actAs(db, vendor.authUserId);
    await settleDebt(db, {
      vendorId: vendor.id, customerId: client.id, amount: 1500,
      actorUserId: vendor.authUserId,
    });

    const a = await ageing();
    expect(a.bucket_90).toBe(0);        // the 120-day one, fully paid
    expect(a.bucket_31_90).toBe(500);   // the 60-day one, half paid
    expect(a.bucket_0_7).toBe(1000);    // untouched
  });

  it('a fully repaid debt ages to nothing', async () => {
    await detteAgee(2000, 300);
    await actAs(db, vendor.authUserId);
    await settleDebt(db, {
      vendorId: vendor.id, customerId: client.id, amount: 2000,
      actorUserId: vendor.authUserId,
    });

    const a = await ageing();
    expect(a.bucket_90).toBe(0);
    expect(a.oldest_days).toBe(0);
    expect(a.over_30_cfa).toBe(0);
  });

  it('the buckets always sum to the outstanding debt', async () => {
    // The property that matters: ageing is a decomposition, not an estimate. If
    // these ever disagree, one of the two figures on the vendor's screen is
    // wrong and there is no way to tell which.
    await detteAgee(1234, 2);
    await detteAgee(5678, 40);
    await detteAgee(999, 100);
    await actAs(db, vendor.authUserId);
    await settleDebt(db, {
      vendorId: vendor.id, customerId: client.id, amount: 1500,
      actorUserId: vendor.authUserId,
    });

    const a = await ageing();
    const somme = a.bucket_0_7 + a.bucket_8_30 + a.bucket_31_90 + a.bucket_90;
    expect(somme).toBe(await debtOf(db, vendor.id, client.id));
  });
});

describe('the vendor sees age beside the amount', () => {
  it('the debtor list carries the buckets', async () => {
    await detteAgee(3000, 45);
    await actAs(db, vendor.authUserId);
    const { rows } = await db.query(
      'select * from public.vendor_debtors($1::uuid, $2::uuid)', [vendor.id, vendor.authUserId]
    );
    expect(rows[0].debt_cfa).toBe(3000);
    expect(rows[0].bucket_31_90).toBe(3000);
    expect(rows[0].over_30_cfa).toBe(3000);
    expect(rows[0].oldest_days).toBe(45);
  });

  it('it can be sorted by age instead of amount', async () => {
    const gros = await seedCustomer(db);
    const vieux = await seedCustomer(db);

    await actAs(db, vendor.authUserId);
    await declareDebt(db, {
      vendorId: vendor.id, customerId: gros.id, amount: 9000,
      actorUserId: vendor.authUserId,
    });
    const e = await declareDebt(db, {
      vendorId: vendor.id, customerId: vieux.id, amount: 500,
      actorUserId: vendor.authUserId,
    });
    await actAsAdmin(db);
    await db.query('alter table public.debt_entries disable trigger debt_entries_no_update');
    await db.query(
      "update public.debt_entries set created_at = now() - interval '200 days' where id = $1",
      [e.id]
    );
    await db.query('alter table public.debt_entries enable trigger debt_entries_no_update');

    await actAs(db, vendor.authUserId);
    const { rows: parMontant } = await db.query(
      'select * from public.vendor_debtors($1::uuid, $2::uuid, 200, $3::text)',
      [vendor.id, vendor.authUserId, 'amount']
    );
    expect(parMontant[0].customer_id).toBe(gros.id);

    const { rows: parAge } = await db.query(
      'select * from public.vendor_debtors($1::uuid, $2::uuid, 200, $3::text)',
      [vendor.id, vendor.authUserId, 'age']
    );
    expect(parAge[0].customer_id).toBe(vieux.id);
  });

  it('an unknown sort key falls back to amount rather than failing', async () => {
    // The key comes from a client. Whitelisted, not interpolated.
    await detteAgee(1000, 5);
    await actAs(db, vendor.authUserId);
    const { rows } = await db.query(
      'select * from public.vendor_debtors($1::uuid, $2::uuid, 200, $3::text)',
      [vendor.id, vendor.authUserId, "age'; drop table public.debt_entries; --"]
    );
    expect(rows).toHaveLength(1);
    await actAsAdmin(db);
    const { rows: encore } = await db.query('select count(*)::int as n from public.debt_entries');
    expect(encore[0].n).toBeGreaterThan(0);
  });

  it('the summary reports the over-30 share beside the total', async () => {
    await detteAgee(1000, 3);
    await detteAgee(4000, 60);

    await actAs(db, vendor.authUserId);
    const { rows } = await db.query(
      'select * from public.vendor_debt_summary($1::uuid, $2::uuid)', [vendor.id, vendor.authUserId]
    );
    expect(rows[0].debt_cfa).toBe(5000);
    expect(rows[0].over_30_cfa).toBe(4000);
    expect(rows[0].oldest_days).toBe(60);
  });

  it('the summary separates books that turn over from books that only grow', async () => {
    const paye = await seedCustomer(db);
    await actAs(db, vendor.authUserId);
    await declareDebt(db, {
      vendorId: vendor.id, customerId: paye.id, amount: 1000,
      actorUserId: vendor.authUserId,
    });
    await settleDebt(db, {
      vendorId: vendor.id, customerId: paye.id, amount: 400,
      actorUserId: vendor.authUserId,
    });
    await detteAgee(2000, 90);

    await actAs(db, vendor.authUserId);
    const { rows } = await db.query(
      'select * from public.vendor_debt_summary($1::uuid, $2::uuid)', [vendor.id, vendor.authUserId]
    );
    expect(rows[0].settled_count).toBe(1);
    // The other customer: over 30 days and never repaid anything.
    expect(rows[0].ageing_count).toBe(1);
  });
});

describe('the customer sees the age of what they owe', () => {
  it('per shop, with the over-30 share', async () => {
    await detteAgee(2500, 55);
    await actAs(db, client.authUserId!);
    const { rows } = await db.query(
      'select * from public.customer_shop_positions($1::uuid)', [client.authUserId]
    );
    expect(rows[0].debt_cfa).toBe(2500);
    expect(rows[0].debt_oldest_days).toBe(55);
    expect(rows[0].debt_over_30_cfa).toBe(2500);
  });

  it('an open claim is visible on the shop card', async () => {
    await detteAgee(2500, 10);
    await actAs(db, client.authUserId!);
    await db.query(
      'select * from public.claim_unrecorded_payment($1::uuid, $2::integer, $3::uuid, null, null)',
      [vendor.id, 1000, client.authUserId]
    );
    const { rows } = await db.query(
      'select * from public.customer_shop_positions($1::uuid)', [client.authUserId]
    );
    expect(rows[0].open_claim).toBe(true);
  });

  it('still reports no negative column', async () => {
    await detteAgee(2500, 55);
    await actAs(db, client.authUserId!);
    const { rows } = await db.query(
      'select * from public.customer_shop_positions($1::uuid)', [client.authUserId]
    );
    for (const [k, v] of Object.entries(rows[0])) {
      if (typeof v === 'number') expect(v, `${k} is negative`).toBeGreaterThanOrEqual(0);
    }
  });
});
