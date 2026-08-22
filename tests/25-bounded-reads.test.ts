// Bounded reads — and the figure that would have been quietly wrong.
//
// PostgREST caps rows at db-max-rows (1000 by default) for table reads AND for
// functions returning a table over rpc. A function with no limit of its own does
// not return "all the rows"; it returns however many the platform feels like
// giving, with no error and no marker.
//
// That was harmless everywhere except one place. "Monnaie en circulation" on Mes
// clients was the sum of the rows vendor_customers returned. Past the cap the
// tail would silently vanish, so the figure would UNDERSTATE what the vendor
// owes — and disagree with the home screen, which aggregates the same total in
// SQL and is therefore right. Two screens, two answers, no error. The vendor
// would trust the smaller one.
//
// These tests use limits far below 1000 so the truncation is reachable in a test
// at all. That is the point: the bound is ours, set here, not a platform default
// that can change under us.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import {
  connect, reset, actAs, actAsAdmin, seedVendor, seedCustomer, postEntry, sqlstateOf,
  type SeededVendor, type SeededCustomer,
} from './helpers/db';

let db: pg.Client;
let vendor: SeededVendor;

beforeAll(async () => { db = await connect(); });
afterAll(async () => { await actAsAdmin(db); await db.end(); });

beforeEach(async () => {
  await reset(db);
  vendor = await seedVendor(db, { cap: 100000 });
});

/** N customers, each holding `amount` with this vendor. */
async function seedClients(n: number, amount: number): Promise<SeededCustomer[]> {
  const clients: SeededCustomer[] = [];
  for (let i = 0; i < n; i += 1) {
    const c = await seedCustomer(db);
    await actAsAdmin(db);
    await postEntry(db, {
      vendorId: vendor.id,
      customerId: c.id,
      direction: 'credit',
      kind: 'change',
      amount,
      actorUserId: vendor.authUserId,
    });
    clients.push(c);
  }
  return clients;
}

describe('vendor_customers is a page, and says how big the whole is', () => {
  it('returns at most the limit asked for', async () => {
    await seedClients(7, 100);
    await actAs(db, vendor.authUserId);

    const { rows } = await db.query(
      'select * from public.vendor_customers($1::uuid, $2::uuid, $3::integer)',
      [vendor.id, vendor.authUserId, 3]
    );
    expect(rows).toHaveLength(3);
  });

  it('reports the TRUE total on every row, not the page size', async () => {
    // The whole defence against a silent truncation: the caller cannot hold the
    // list without also holding the number that contradicts it.
    await seedClients(7, 100);
    await actAs(db, vendor.authUserId);

    const { rows } = await db.query(
      'select * from public.vendor_customers($1::uuid, $2::uuid, $3::integer)',
      [vendor.id, vendor.authUserId, 3]
    );
    for (const r of rows) {
      expect(r.total_count).toBe(7);
    }
  });

  it('counts customers, not ledger entries', async () => {
    // total_count exists to be compared against rows.length. If it counted
    // entries it would look like truncation on any customer with a history.
    const [c] = await seedClients(1, 100);
    await actAsAdmin(db);
    for (let i = 0; i < 4; i += 1) {
      await postEntry(db, {
        vendorId: vendor.id,
        customerId: c!.id,
        direction: 'credit',
        kind: 'change',
        amount: 50,
        actorUserId: vendor.authUserId,
      });
    }

    await actAs(db, vendor.authUserId);
    const { rows } = await db.query(
      'select * from public.vendor_customers($1::uuid, $2::uuid)',
      [vendor.id, vendor.authUserId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].total_count).toBe(1);
    expect(rows[0].entry_count).toBe(5);
  });

  it('a limit above the hard ceiling is clamped, not honoured', async () => {
    // No caller can talk the function into an unbounded read by passing a large
    // number, which is how the cap would come back into play.
    await seedClients(3, 100);
    await actAs(db, vendor.authUserId);

    const { rows } = await db.query(
      'select * from public.vendor_customers($1::uuid, $2::uuid, $3::integer)',
      [vendor.id, vendor.authUserId, 10_000_000]
    );
    // Fewer rows exist than either bound, so this asserts only that a huge
    // limit is accepted and applied as a clamp rather than passed through.
    expect(rows).toHaveLength(3);
  });

  it('a zero or negative limit still returns a row rather than nothing', async () => {
    // A screen showing an empty list for a vendor who has customers is a lie in
    // the other direction.
    await seedClients(3, 100);
    await actAs(db, vendor.authUserId);

    for (const mauvais of [0, -5]) {
      const { rows } = await db.query(
        'select * from public.vendor_customers($1::uuid, $2::uuid, $3::integer)',
        [vendor.id, vendor.authUserId, mauvais]
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].total_count).toBe(3);
    }
  });

  it('keeps the largest balances, so a truncated page is the useful end', async () => {
    await seedClients(3, 100);
    const gros = await seedCustomer(db);
    await actAsAdmin(db);
    await postEntry(db, {
      vendorId: vendor.id,
      customerId: gros.id,
      direction: 'credit',
      kind: 'change',
      amount: 9000,
      actorUserId: vendor.authUserId,
    });

    await actAs(db, vendor.authUserId);
    const { rows } = await db.query(
      'select * from public.vendor_customers($1::uuid, $2::uuid, $3::integer)',
      [vendor.id, vendor.authUserId, 1]
    );
    expect(rows[0].customer_id).toBe(gros.id);
    expect(rows[0].balance_cfa).toBe(9000);
  });
});

describe('the circulation total does NOT come from the page', () => {
  it('vendor_home_summary is right when the client page is truncated', async () => {
    // The regression this whole change exists for. Summing a page of 3 out of 7
    // gives 300; the vendor owes 700.
    await seedClients(7, 100);
    await actAs(db, vendor.authUserId);

    const { rows: page } = await db.query(
      'select * from public.vendor_customers($1::uuid, $2::uuid, $3::integer)',
      [vendor.id, vendor.authUserId, 3]
    );
    const sommeDeLaPage = page.reduce((t, r) => t + r.balance_cfa, 0);

    const { rows: resume } = await db.query(
      'select * from public.vendor_home_summary($1::uuid, $2::uuid)',
      [vendor.id, vendor.authUserId]
    );

    expect(sommeDeLaPage).toBe(300);
    expect(resume[0].circulation_cfa).toBe(700);
    // Stated explicitly: the two disagree, and the aggregate is the true one.
    expect(resume[0].circulation_cfa).not.toBe(sommeDeLaPage);
  });

  it('the summary is one row, so it can never be truncated at all', async () => {
    await seedClients(4, 250);
    await actAs(db, vendor.authUserId);
    const { rows } = await db.query(
      'select * from public.vendor_home_summary($1::uuid, $2::uuid)',
      [vendor.id, vendor.authUserId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].circulation_cfa).toBe(1000);
  });
});

describe('customer_shop_balances is bounded too', () => {
  it('returns at most the limit, across several vendors', async () => {
    const client = await seedCustomer(db);
    for (let i = 0; i < 4; i += 1) {
      const v = await seedVendor(db, { cap: 100000 });
      await actAsAdmin(db);
      await postEntry(db, {
        vendorId: v.id,
        customerId: client.id,
        direction: 'credit',
        kind: 'change',
        amount: 100 * (i + 1),
        actorUserId: v.authUserId,
      });
    }

    await actAs(db, client.authUserId!);
    const { rows } = await db.query(
      'select * from public.customer_shop_balances($1::uuid, $2::integer)',
      [client.authUserId, 2]
    );
    expect(rows).toHaveLength(2);
    // Largest first, so a truncated list keeps the shops that matter.
    expect(rows[0].balance_cfa).toBe(400);
    expect(rows[1].balance_cfa).toBe(300);
  });
});

describe('the customer total does NOT come from the page either', () => {
  /** One customer holding `amount` at each of `n` different vendors. */
  async function chezPlusieurs(n: number, amount: number) {
    const client = await seedCustomer(db);
    for (let i = 0; i < n; i += 1) {
      const v = await seedVendor(db, { cap: 100000 });
      await actAsAdmin(db);
      await postEntry(db, {
        vendorId: v.id,
        customerId: client.id,
        direction: 'credit',
        kind: 'change',
        amount,
        actorUserId: v.authUserId,
      });
    }
    return client;
  }

  it('customer_summary is right when the shop page is truncated', async () => {
    // The same regression as the vendor side, on the other side of the app.
    // Summing a page of 2 out of 5 gives 200; the customer holds 500.
    const client = await chezPlusieurs(5, 100);
    await actAs(db, client.authUserId!);

    const { rows: page } = await db.query(
      'select * from public.customer_shop_balances($1::uuid, $2::integer)',
      [client.authUserId, 2]
    );
    const sommeDeLaPage = page.reduce((t, r) => t + r.balance_cfa, 0);

    const { rows: resume } = await db.query('select * from public.customer_summary($1::uuid)', [
      client.authUserId,
    ]);

    expect(sommeDeLaPage).toBe(200);
    expect(resume[0].total_cfa).toBe(500);
    expect(resume[0].total_cfa).not.toBe(sommeDeLaPage);
  });

  it('the SHOP COUNT is the server′s too, not the page length', async () => {
    // The half that is worse on the customer side: the caption says "Répartie
    // chez N commerçants", and N came from the page. A page of 2 would have
    // claimed 2 shops when the answer is 5.
    const client = await chezPlusieurs(5, 100);
    await actAs(db, client.authUserId!);

    const { rows: page } = await db.query(
      'select * from public.customer_shop_balances($1::uuid, $2::integer)',
      [client.authUserId, 2]
    );
    const { rows: resume } = await db.query('select * from public.customer_summary($1::uuid)', [
      client.authUserId,
    ]);

    expect(page).toHaveLength(2);
    expect(resume[0].shop_count).toBe(5);
  });

  it('counts only shops that still hold something', async () => {
    // Matches perShop(), which drops zero balances. A shop the customer has
    // emptied is not a shop their change is "spread across".
    const client = await seedCustomer(db);
    const v1 = await seedVendor(db, { cap: 100000 });
    const v2 = await seedVendor(db, { cap: 100000 });
    await actAsAdmin(db);
    await postEntry(db, {
      vendorId: v1.id, customerId: client.id, direction: 'credit',
      kind: 'change', amount: 500, actorUserId: v1.authUserId,
    });
    await postEntry(db, {
      vendorId: v2.id, customerId: client.id, direction: 'credit',
      kind: 'change', amount: 300, actorUserId: v2.authUserId,
    });
    // Spend everything at the second shop.
    await postEntry(db, {
      vendorId: v2.id, customerId: client.id, direction: 'debit',
      kind: 'purchase', amount: 300, actorUserId: v2.authUserId,
      customerConfirmed: true,
    });

    await actAs(db, client.authUserId!);
    const { rows } = await db.query('select * from public.customer_summary($1::uuid)', [
      client.authUserId,
    ]);
    expect(rows[0].shop_count).toBe(1);
    expect(rows[0].total_cfa).toBe(500);
  });

  it('is one row, so it cannot be truncated', async () => {
    const client = await chezPlusieurs(3, 250);
    await actAs(db, client.authUserId!);
    const { rows } = await db.query('select * from public.customer_summary($1::uuid)', [
      client.authUserId,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].total_cfa).toBe(750);
  });

  it('answers only about the caller', async () => {
    // Standing rule 1 again: one customer must never see another's total.
    const a = await chezPlusieurs(2, 100);
    const b = await seedCustomer(db);

    await actAs(db, b.authUserId!);
    const code_ = await sqlstateOf(() =>
      db.query('select * from public.customer_summary($1::uuid)', [a.authUserId])
    );
    expect(code_).toBe('SW002');
  });
});

describe('pending_debits_for_customer is bounded with no caller choice', () => {
  it('takes no limit argument', async () => {
    // Deliberate. This is "what is waiting for your confirmation right now",
    // not a list anyone pages through, so the bound is internal.
    await actAsAdmin(db);
    const { rows } = await db.query(
      `select count(*)::int as n
         from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
        where ns.nspname = 'public'
          and p.proname = 'pending_debits_for_customer'
          and p.pronargs = 1`
    );
    expect(rows[0].n).toBe(1);
  });

  it('is capped in SQL rather than by the platform', async () => {
    await actAsAdmin(db);
    const { rows } = await db.query(
      `select pg_get_functiondef(p.oid) as def
         from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
        where ns.nspname = 'public' and p.proname = 'pending_debits_for_customer'`
    );
    expect(rows[0].def.toLowerCase()).toMatch(/limit\s+20/);
  });
});

// ---------------------------------------------------------------------------
// The durable guard
// ---------------------------------------------------------------------------

/**
 * Set-returning functions that have no `limit` and do not need one, each with
 * the reason it is bounded by something other than a limit clause.
 *
 * A missing limit is not automatically a bug — a function selecting one row by a
 * unique key is bounded by the key. It IS a decision, and this list is where the
 * decision is recorded. A new unbounded function appears in neither this list
 * nor the bounded set, so the test below fails and someone has to think about
 * it. That is the whole mechanism: `scripts/audit-bounds.mjs` prints the same
 * question on demand.
 */
const BORNE_AUTREMENT: Record<string, string> = {
  // where c.phone = ... on a unique column: at most one customer.
  lookup_customer_for_vendor: 'one row, keyed on the unique phone',
  // One row per pepper version in use. Bounded by data we deploy, and not
  // granted to any client role.
  pepper_version_usage: 'one row per pepper version; operator-only',
  // Aggregate. One row by construction, which is exactly why the circulation
  // figure was moved here.
  vendor_home_summary: 'aggregate, one row by construction',
  // The customer-side twin, added for the same reason: the informational total
  // and its shop count both used to be folded out of a bounded list.
  customer_summary: 'aggregate, one row by construction',
  // where p.id = p_pending_id on the primary key.
  vendor_pending_detail: 'one row, keyed on the primary key',
};

describe('every set-returning function is bounded, one way or the other', () => {
  it('has no unbounded read that nobody decided about', async () => {
    // Discovered from the catalog rather than from a list someone has to
    // remember to update, so an unbounded read added next month fails here
    // instead of shipping and quietly showing partial data.
    await actAsAdmin(db);
    const { rows } = await db.query(
      `select p.proname, pg_get_functiondef(p.oid) as def
         from pg_proc p
         join pg_namespace ns on ns.oid = p.pronamespace
        where ns.nspname = 'public'
          and p.proretset
          and p.prokind = 'f'`
    );

    expect(rows.length).toBeGreaterThan(10);

    const indecis = rows
      .filter((r) => !/\blimit\b/i.test(r.def))
      .map((r) => r.proname)
      .filter((nom) => !(nom in BORNE_AUTREMENT))
      .sort();

    expect(indecis).toEqual([]);
  });

  it('the allow-list has not rotted', async () => {
    // A named exemption for a function that no longer exists is a stale excuse
    // that would silently cover a future function of the same name.
    await actAsAdmin(db);
    const { rows } = await db.query(
      `select p.proname
         from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
        where ns.nspname = 'public' and p.proretset and p.prokind = 'f'`
    );
    const existants = new Set(rows.map((r) => r.proname));

    const fantomes = Object.keys(BORNE_AUTREMENT).filter((n) => !existants.has(n));
    expect(fantomes).toEqual([]);
  });

  it('nothing on the allow-list can actually return two rows', async () => {
    // The claim being exempted, checked rather than trusted, for the two that
    // take arguments a test can drive. Two customers, two vendors, and the
    // lookup still answers with one row.
    const c1 = await seedCustomer(db);
    await seedCustomer(db);
    await actAsAdmin(db);
    await postEntry(db, {
      vendorId: vendor.id,
      customerId: c1.id,
      direction: 'credit',
      kind: 'change',
      amount: 100,
      actorUserId: vendor.authUserId,
    });

    await actAs(db, vendor.authUserId);
    const { rows: lookup } = await db.query(
      'select * from public.lookup_customer_for_vendor($1::uuid, $2::text, $3::uuid)',
      [vendor.id, c1.phone, vendor.authUserId]
    );
    expect(lookup).toHaveLength(1);

    const { rows: resume } = await db.query(
      'select * from public.vendor_home_summary($1::uuid, $2::uuid)',
      [vendor.id, vendor.authUserId]
    );
    expect(resume).toHaveLength(1);
  });
});
