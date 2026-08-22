// The two registers are never netted, and Compenser is the only bridge.
//
// ============================================================================
// THE FIGURE THAT MUST NOT EXIST: −1 500 F.
//
// A customer holding 500 F of change at a shop and owing that shop 2 000 F has
// two true facts about them. Collapsing those into −1 500 F would be a third
// thing that is not true: it recreates the negative balance standing rule 2
// forbids, and it states that the customer's position at that shop is a single
// signed number, which is exactly the framing this product refuses.
//
// So: two tables, two figures, and no code path anywhere that subtracts one from
// the other. What a customer MAY do is ask that one pay down the other. That is a
// transaction — proposed, bounded by both balances, confirmed on the customer's
// own device, and written as a traceable pair.
// ============================================================================

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import {
  connect, reset, actAs, actAsAdmin, seedVendor, seedCustomer, postEntry,
  declareDebt, debtOf, balanceOf, sqlstateOf, randomUUID,
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

/** 500 F of change held, 2 000 F of debt owed. The shape that must never net. */
async function laSituation() {
  await actAsAdmin(db);
  await postEntry(db, {
    vendorId: vendor.id, customerId: client.id, direction: 'credit',
    kind: 'change', amount: 500, actorUserId: vendor.authUserId,
  });
  await actAs(db, vendor.authUserId);
  await declareDebt(db, {
    vendorId: vendor.id, customerId: client.id, amount: 2000,
    actorUserId: vendor.authUserId,
  });
}

describe('the two registers stay separate', () => {
  it('both figures are reported, and neither is the difference', async () => {
    await laSituation();
    await actAs(db, client.authUserId!);

    const { rows } = await db.query(
      'select * from public.customer_shop_positions($1::uuid)', [client.authUserId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].change_cfa).toBe(500);
    expect(rows[0].debt_cfa).toBe(2000);
    // The forbidden figure appears nowhere in the row.
    expect(Object.values(rows[0])).not.toContain(-1500);
  });

  it('no returned column is ever negative', async () => {
    await laSituation();
    await actAs(db, client.authUserId!);
    const { rows } = await db.query(
      'select * from public.customer_shop_positions($1::uuid)', [client.authUserId]
    );
    for (const [k, v] of Object.entries(rows[0])) {
      if (typeof v === 'number') {
        expect(v, `${k} is negative`).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('the offsettable amount is the SMALLER of the two, never a difference', async () => {
    await laSituation();
    await actAs(db, client.authUserId!);
    const { rows } = await db.query(
      'select * from public.customer_shop_positions($1::uuid)', [client.authUserId]
    );
    // min(500, 2000), not 2000 − 500.
    expect(rows[0].compensable_cfa).toBe(500);
  });

  it('a shop with change and no debt reports zero debt, not a credit', async () => {
    await actAsAdmin(db);
    await postEntry(db, {
      vendorId: vendor.id, customerId: client.id, direction: 'credit',
      kind: 'change', amount: 900, actorUserId: vendor.authUserId,
    });
    await actAs(db, client.authUserId!);
    const { rows } = await db.query(
      'select * from public.customer_shop_positions($1::uuid)', [client.authUserId]
    );
    expect(rows[0].change_cfa).toBe(900);
    expect(rows[0].debt_cfa).toBe(0);
    expect(rows[0].compensable_cfa).toBe(0);
  });

  it('a shop with debt and no change reports zero change', async () => {
    await actAs(db, vendor.authUserId);
    await declareDebt(db, {
      vendorId: vendor.id, customerId: client.id, amount: 1200,
      actorUserId: vendor.authUserId,
    });
    await actAs(db, client.authUserId!);
    const { rows } = await db.query(
      'select * from public.customer_shop_positions($1::uuid)', [client.authUserId]
    );
    expect(rows[0].change_cfa).toBe(0);
    expect(rows[0].debt_cfa).toBe(1200);
    expect(rows[0].compensable_cfa).toBe(0);
  });

  it('the change balance is untouched by a debt existing', async () => {
    await laSituation();
    // The pre-existing balance function must return what it always returned.
    // If a debt could reduce it, every screen in the app would silently change
    // meaning.
    expect(await balanceOf(db, vendor.id, client.id)).toBe(500);
    expect(await debtOf(db, vendor.id, client.id)).toBe(2000);
  });
});

describe('Compenser is explicit, bounded, and customer-confirmed', () => {
  async function proposer(montant: number) {
    await actAs(db, vendor.authUserId);
    const { rows } = await db.query(
      'select * from public.create_pending_compensation($1::uuid,$2::uuid,$3::integer,$4::text,$5::uuid)',
      [vendor.id, client.id, montant, randomUUID(), vendor.authUserId]
    );
    return rows[0];
  }

  async function confirmer(pendingId: string, authUserId: string) {
    await actAsAdmin(db);
    const { rows } = await db.query(
      'select * from public.confirm_pending_compensation($1::uuid, $2::uuid)',
      [pendingId, authUserId]
    );
    return rows[0];
  }

  it('writes BOTH legs and the row that ties them together', async () => {
    await laSituation();
    const p = await proposer(500);
    const c = await confirmer(p.id, client.authUserId!);

    expect(c.amount_cfa).toBe(500);
    expect(c.ledger_entry_id).not.toBeNull();
    expect(c.debt_entry_id).not.toBeNull();

    // Change spent, debt reduced, by the same amount.
    expect(await balanceOf(db, vendor.id, client.id)).toBe(0);
    expect(await debtOf(db, vendor.id, client.id)).toBe(1500);
  });

  it('both legs are marked as a compensation in their own register', async () => {
    await laSituation();
    const p = await proposer(500);
    const c = await confirmer(p.id, client.authUserId!);

    await actAsAdmin(db);
    const { rows: l } = await db.query(
      'select kind, direction, confirmation_method from public.ledger_entries where id = $1',
      [c.ledger_entry_id]
    );
    expect(l[0].kind).toBe('compensation');
    expect(l[0].direction).toBe('debit');
    expect(l[0].confirmation_method).toBe('own_device');

    const { rows: d } = await db.query(
      'select kind, direction, confirmation_method from public.debt_entries where id = $1',
      [c.debt_entry_id]
    );
    expect(d[0].kind).toBe('compensation');
    expect(d[0].direction).toBe('repaid');
    expect(d[0].confirmation_method).toBe('own_device');
  });

  it('cannot exceed the change held', async () => {
    await laSituation();
    const code = await sqlstateOf(() => proposer(600));
    expect(code).toBe('SW028');
  });

  it('cannot exceed the debt owed', async () => {
    await actAsAdmin(db);
    await postEntry(db, {
      vendorId: vendor.id, customerId: client.id, direction: 'credit',
      kind: 'change', amount: 5000, actorUserId: vendor.authUserId,
    });
    await actAs(db, vendor.authUserId);
    await declareDebt(db, {
      vendorId: vendor.id, customerId: client.id, amount: 800,
      actorUserId: vendor.authUserId,
    });
    const code = await sqlstateOf(() => proposer(1000));
    expect(code).toBe('SW028');
  });

  it('is refused when there is no debt to pay', async () => {
    await actAsAdmin(db);
    await postEntry(db, {
      vendorId: vendor.id, customerId: client.id, direction: 'credit',
      kind: 'change', amount: 500, actorUserId: vendor.authUserId,
    });
    const code = await sqlstateOf(() => proposer(100));
    expect(code).toBe('SW026');
  });

  it('is refused when there is no change to pay it with', async () => {
    await actAs(db, vendor.authUserId);
    await declareDebt(db, {
      vendorId: vendor.id, customerId: client.id, amount: 2000,
      actorUserId: vendor.authUserId,
    });
    const code = await sqlstateOf(() => proposer(100));
    expect(code).toBe('SW026');
  });

  it('the VENDOR cannot confirm it', async () => {
    await laSituation();
    const p = await proposer(500);
    await actAsAdmin(db);
    const code = await sqlstateOf(() =>
      db.query('select public.confirm_pending_compensation($1::uuid,$2::uuid)', [
        p.id, vendor.authUserId,
      ])
    );
    expect(code).toBe('SW001');
    // Neither register moved.
    expect(await balanceOf(db, vendor.id, client.id)).toBe(500);
    expect(await debtOf(db, vendor.id, client.id)).toBe(2000);
  });

  it('a session-bound caller cannot confirm it at all', async () => {
    await laSituation();
    const p = await proposer(500);
    await actAs(db, client.authUserId!);
    const code = await sqlstateOf(() =>
      db.query('select public.confirm_pending_compensation($1::uuid,$2::uuid)', [
        p.id, client.authUserId,
      ])
    );
    // Not granted to authenticated: the PIN must be verified by the function.
    expect(code).toBe('42501');
  });

  it('confirming twice does not offset twice', async () => {
    await laSituation();
    const p = await proposer(500);
    await confirmer(p.id, client.authUserId!);
    await confirmer(p.id, client.authUserId!);

    expect(await balanceOf(db, vendor.id, client.id)).toBe(0);
    expect(await debtOf(db, vendor.id, client.id)).toBe(1500);

    await actAsAdmin(db);
    const { rows } = await db.query('select count(*)::int as n from public.compensations');
    expect(rows[0].n).toBe(1);
  });

  it('the same ledger entry cannot be offset twice', async () => {
    // Enforced by the unique foreign keys on compensations, so a second pairing
    // is impossible rather than merely unlikely.
    await actAsAdmin(db);
    const { rows } = await db.query(
      `select indexdef from pg_indexes
        where tablename = 'compensations' and indexdef like '%UNIQUE%'`
    );
    const defs = rows.map((r) => r.indexdef).join(' ');
    expect(defs).toContain('ledger_entry_id');
    expect(defs).toContain('debt_entry_id');
  });

  it('an unregistered customer cannot compensate', async () => {
    const inconnu = await seedCustomer(db, { registered: false });
    await actAsAdmin(db);
    await postEntry(db, {
      vendorId: vendor.id, customerId: inconnu.id, direction: 'credit',
      kind: 'change', amount: 500, actorUserId: vendor.authUserId,
    });
    await actAs(db, vendor.authUserId);
    await declareDebt(db, {
      vendorId: vendor.id, customerId: inconnu.id, amount: 500,
      actorUserId: vendor.authUserId,
    });

    const code = await sqlstateOf(() =>
      db.query(
        'select * from public.create_pending_compensation($1::uuid,$2::uuid,$3::integer,$4::text,$5::uuid)',
        [vendor.id, inconnu.id, 500, randomUUID(), vendor.authUserId]
      )
    );
    // No device, no confirmation, no compensation. Recorded as a real limit.
    expect(code).toBe('SW008');
  });
});

// ---------------------------------------------------------------------------
// Structural: nothing in the schema or the source nets the two
// ---------------------------------------------------------------------------

describe('nothing anywhere subtracts one register from the other', () => {
  it('no function or view joins both ledgers into one signed figure', async () => {
    // The specific shape being hunted: a definition that reads both
    // ledger_entries and debt_entries AND contains a subtraction between them.
    // customer_shop_positions reads both, legitimately, and returns them as two
    // columns plus a least() — so the test looks for the join being collapsed,
    // not for the join existing.
    await actAsAdmin(db);
    const { rows } = await db.query(
      `select p.proname as nom, pg_get_functiondef(p.oid) as def
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.prokind = 'f'`
    );

    const suspects: string[] = [];
    for (const r of rows) {
      const def: string = r.def;
      const lesDeux = /ledger_entries/.test(def) && /debt_entries/.test(def);
      if (!lesDeux) continue;
      // A netting expression would have to bring the two sums together. Look for
      // a monnaie/dette subtraction in either order.
      if (/monnaie\s*-\s*dette|dette\s*-\s*monnaie|change_cfa\s*-\s*debt_cfa|debt_cfa\s*-\s*change_cfa/i.test(def)) {
        suspects.push(r.nom);
      }
    }
    expect(suspects).toEqual([]);
  });

  it('the customer position function returns no net column', async () => {
    await actAsAdmin(db);
    const { rows } = await db.query(
      `select pg_get_function_result(p.oid) as res
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'customer_shop_positions'`
    );
    const res: string = rows[0].res;
    expect(res).toContain('change_cfa');
    expect(res).toContain('debt_cfa');
    // Names that would invite a signed reading.
    expect(res).not.toMatch(/\bnet_/);
    expect(res).not.toMatch(/\bposition_cfa\b/);
    expect(res).not.toMatch(/\bbalance_net\b/);
  });

  it('the app never subtracts a debt figure from a change figure', () => {
    const SRC = path.join(process.cwd(), 'src');
    function walk(dir: string): string[] {
      return readdirSync(dir).flatMap((name) => {
        const full = path.join(dir, name);
        return statSync(full).isDirectory() ? walk(full) : [full];
      });
    }
    const fichiers = walk(SRC).filter((f) => /\.(ts|tsx)$/.test(f));
    const interdits = [
      /change_cfa\s*-\s*debt/i,
      /debt_cfa\s*-\s*change/i,
      /changeCfa\s*-\s*debt/i,
      /debtCfa\s*-\s*change/i,
    ];

    for (const f of fichiers) {
      const src = readFileSync(f, 'utf8').replace(/\r\n/g, '\n')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((l) => !/^\s*\/\//.test(l))
        .join('\n');
      for (const p of interdits) {
        expect(src, `${path.relative(process.cwd(), f)} nets the registers`).not.toMatch(p);
      }
    }
  });
});
