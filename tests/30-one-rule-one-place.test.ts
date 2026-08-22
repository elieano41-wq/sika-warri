// A rule written twice is a rule that will disagree with itself.
//
// THE BUG THIS EXISTS FOR. Migration 0029 added 'compensation' to the
// ledger_entries CHECK constraint. post_ledger_entry keeps its own copy of the
// same list and was not touched, so the constraint was widened and the door
// stayed shut: every compensation failed with SIKA_INVALID_KIND. The constraint
// said yes, the function said no, and the function is the one that runs.
//
// Duplicating the enum is a deliberate trade — the function's copy exists so a
// bad kind gets SW007 and a French message instead of a raw 23514 constraint
// violation. Keeping the copy means keeping it honest, which is this file's job.
//
// These tests read both definitions out of the live catalog and compare them.
// Nothing here is a list someone has to remember to update.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { connect, actAsAdmin } from './helpers/db';

let db: pg.Client;

beforeAll(async () => { db = await connect(); });
afterAll(async () => { await actAsAdmin(db); await db.end(); });

/** The quoted values inside a definition, deduplicated and sorted. */
function valeurs(texte: string): string[] {
  return [...new Set((texte.match(/'[a-z_]+'/g) ?? []).map((v) => v.slice(1, -1)))].sort();
}

/** The check constraint on one column of one table. */
async function contrainte(table: string, colonne: string): Promise<string> {
  const { rows } = await db.query(
    `select pg_get_constraintdef(oid) as def
       from pg_constraint
      where conrelid = $1::regclass
        and contype = 'c'
        and pg_get_constraintdef(oid) like '%' || $2 || '%'
        and pg_get_constraintdef(oid) like '%ANY%'`,
    [`public.${table}`, colonne]
  );
  const def = rows.map((r) => r.def).find((d: string) => d.includes(colonne));
  expect(def, `no ANY-style check on ${table}.${colonne}`).toBeTruthy();
  return def as string;
}

/** The `not in (...)` guard for a parameter inside a function body. */
async function gardeFonction(fonction: string, param: string): Promise<string> {
  const { rows } = await db.query(
    `select pg_get_functiondef(p.oid) as def
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = $1`,
    [fonction]
  );
  expect(rows.length, `${fonction} not found`).toBeGreaterThan(0);
  const def: string = rows[0].def;
  const m = new RegExp(`${param}\\s+not\\s+in\\s*\\(([^)]*)\\)`).exec(def);
  expect(m, `${fonction} has no "not in" guard for ${param}`).not.toBeNull();
  return m![1];
}

describe('the ledger kinds agree between the constraint and the function', () => {
  it('post_ledger_entry accepts exactly what ledger_entries allows', async () => {
    await actAsAdmin(db);
    const c = valeurs(await contrainte('ledger_entries', 'kind'));
    const f = valeurs(await gardeFonction('post_ledger_entry', 'p_kind'));

    expect(c.length).toBeGreaterThan(3);
    expect(f).toEqual(c);
    // Named explicitly so a reader knows what the set is supposed to be.
    expect(c).toEqual(['change', 'compensation', 'purchase', 'refund', 'reversal']);
  });

  it('post_ledger_entry accepts exactly the directions the table allows', async () => {
    await actAsAdmin(db);
    const c = valeurs(await contrainte('ledger_entries', 'direction'));
    const f = valeurs(await gardeFonction('post_ledger_entry', 'p_direction'));
    expect(f).toEqual(c);
    expect(c).toEqual(['credit', 'debit']);
  });
});

describe('the debt kinds agree between the constraint and the function', () => {
  it('post_debt_entry accepts exactly what debt_entries allows', async () => {
    await actAsAdmin(db);
    const c = valeurs(await contrainte('debt_entries', 'kind'));
    const f = valeurs(await gardeFonction('post_debt_entry', 'p_kind'));
    expect(f).toEqual(c);
    expect(c).toEqual([
      'cancellation', 'compensation', 'debt', 'reversal', 'settlement',
    ]);
  });

  it('post_debt_entry accepts exactly the directions the table allows', async () => {
    await actAsAdmin(db);
    const c = valeurs(await contrainte('debt_entries', 'direction'));
    const f = valeurs(await gardeFonction('post_debt_entry', 'p_direction'));
    expect(f).toEqual(c);
    expect(c).toEqual(['owed', 'repaid']);
  });

  it('the debt confirmation methods agree, and exclude vendor_device', async () => {
    // The most important instance of this check. If the constraint and the
    // function ever disagreed here, the disagreement would be about whether a
    // vendor can type the customer's PIN on the vendor's phone to mint a debt.
    await actAsAdmin(db);
    const c = valeurs(await contrainte('debt_entries', 'confirmation_method'));
    expect(c).toEqual(['declared', 'own_device']);
    expect(c).not.toContain('vendor_device');

    const { rows } = await db.query(
      `select pg_get_functiondef(p.oid) as def
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'post_debt_entry'`
    );
    const def: string = rows[0].def;
    // The function names it only to refuse it, and the refusal must be the only
    // mention.
    expect(def).toMatch(/SIKA_DEBT_VENDOR_DEVICE_FORBIDDEN/);
    const mentions = (def.match(/'vendor_device'/g) ?? []).length;
    expect(mentions).toBe(1);
  });
});

describe('every kind the tables allow can actually be written', () => {
  it('no ledger kind is accepted by the table but refused by the function', async () => {
    // The failure shape in one sentence: a constraint widened, a function not.
    // Checked by name so the message says which kind is stranded.
    await actAsAdmin(db);
    const c = valeurs(await contrainte('ledger_entries', 'kind'));
    const f = valeurs(await gardeFonction('post_ledger_entry', 'p_kind'));
    const bloques = c.filter((k) => !f.includes(k));
    expect(bloques, 'allowed by the table, refused by the function').toEqual([]);
  });

  it('no debt kind is accepted by the table but refused by the function', async () => {
    await actAsAdmin(db);
    const c = valeurs(await contrainte('debt_entries', 'kind'));
    const f = valeurs(await gardeFonction('post_debt_entry', 'p_kind'));
    expect(c.filter((k) => !f.includes(k))).toEqual([]);
  });

  it('and nothing the function accepts is refused by the table', async () => {
    // The other direction, which would fail later and more confusingly: the
    // function waves it through and the insert dies on a raw 23514 with no
    // French message.
    await actAsAdmin(db);
    for (const [table, fonction] of [
      ['ledger_entries', 'post_ledger_entry'],
      ['debt_entries', 'post_debt_entry'],
    ] as const) {
      const c = valeurs(await contrainte(table, 'kind'));
      const f = valeurs(await gardeFonction(fonction, 'p_kind'));
      expect(f.filter((k) => !c.includes(k)), `${fonction} accepts what ${table} rejects`)
        .toEqual([]);
    }
  });
});
