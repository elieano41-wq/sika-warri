// One account holds both sides, and holding somebody's money still needs consent.
//
// ============================================================================
// WHAT THIS COVERS. 0042 made the two halves of an account legal to hold at
// once; 0043 gave the halves to every account that predated it. The second one
// carries the risk: the vendors row is the half that KEEPS other people's money,
// and spec section 6 requires whoever does that to have acknowledged the
// disclosure — which the old registration flow collected from vendors only and
// never showed to a customer at all.
//
// Worse, nothing enforced it. terms_accepted_at was written at registration and
// then read by nothing, so the requirement lived in one Edge Function's input
// validation, where a backfill walks straight past it. These tests exist because
// "the app asks" is not the same claim as "the ledger refuses".
// ============================================================================

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import {
  connect, reset, actAs, actAsAdmin, seedVendor, seedCustomer, sqlstateOf,
  type SeededVendor, type SeededCustomer,
} from './helpers/db';

let db: pg.Client;

beforeAll(async () => { db = await connect(); });
afterAll(async () => { await actAsAdmin(db); await db.end(); });
beforeEach(async () => { await reset(db); });

/** An account holding both halves, as everything created since 0042 does. */
async function compteComplet(opts: { conditions?: boolean } = {}) {
  const v = await seedVendor(db);
  const { rows } = await db.query(
    `insert into public.customers (auth_user_id, phone, display_name)
     values ($1, $2, $3) returning id`,
    [v.authUserId, v.phone, v.businessName]
  );
  if (opts.conditions === false) {
    await db.query(
      'update public.vendors set terms_accepted_at = null, terms_version = null where id = $1',
      [v.id]
    );
  }
  return { ...v, customerId: rows[0].id as string };
}

describe('one identity can hold both halves', () => {
  it('the same auth user may be a vendor AND a customer', async () => {
    // The thing the old register function refused outright with
    // PHONE_OTHER_ROLE. Nothing in the schema ever forbade it: both
    // auth_user_id columns are separately unique, so one row in each is legal
    // and always was. The split lived in an Edge Function, not in the data.
    await actAsAdmin(db);
    const a = await compteComplet();

    const { rows } = await db.query(
      `select
         (select count(*) from public.vendors   where auth_user_id = $1)::int as v,
         (select count(*) from public.customers where auth_user_id = $1)::int as c`,
      [a.authUserId]
    );
    expect(rows[0]).toEqual({ v: 1, c: 1 });
  });

  it('and both halves of one account can face two different people', async () => {
    // The capability that was missing: this account keeps somebody's change AND
    // owes somebody else. Under two account types that needed two logins.
    await actAsAdmin(db);
    const moi = await compteComplet();
    const autre = await compteComplet();

    // I keep 500 F for them.
    await db.query(
      `select public.post_ledger_entry($1,$2,'credit','change',500,$3,$4,false,null,null,null)`,
      [moi.id, autre.customerId, 'k1', moi.authUserId]
    );
    // They keep 300 F for me.
    await db.query(
      `select public.post_ledger_entry($1,$2,'credit','change',300,$3,$4,false,null,null,null)`,
      [autre.id, moi.customerId, 'k2', autre.authUserId]
    );

    const { rows } = await db.query(
      `select
         (select coalesce(sum(amount_cfa),0) from public.ledger_entries
           where vendor_id = $1)::int as je_garde,
         (select coalesce(sum(amount_cfa),0) from public.ledger_entries
           where customer_id = $2)::int as garde_pour_moi`,
      [moi.id, moi.customerId]
    );
    // Two facts about one account, pointing opposite ways, never summed.
    expect(rows[0]).toEqual({ je_garde: 500, garde_pour_moi: 300 });
  });
});

describe('taking custody requires the acknowledgement, in SQL', () => {
  it('a credit is REFUSED without it', async () => {
    await actAsAdmin(db);
    const moi = await compteComplet({ conditions: false });
    const autre = await compteComplet();

    const code = await sqlstateOf(() =>
      db.query(
        `select public.post_ledger_entry($1,$2,'credit','change',500,$3,$4,false,null,null,null)`,
        [moi.id, autre.customerId, 'x1', moi.authUserId]
      )
    );
    expect(code).toBe('SW033');
  });

  it('a debt claim is REFUSED without it', async () => {
    // The dangerous direction: a fabricated debt EARNS the claimant money, so
    // this is the last one that should be reachable without consent on file.
    await actAsAdmin(db);
    const moi = await compteComplet({ conditions: false });
    const autre = await compteComplet();

    const code = await sqlstateOf(() =>
      db.query(
        `select public.post_debt_entry($1,$2,'owed','debt',2000,$3,$4,'declared',null,null)`,
        [moi.id, autre.customerId, 'd1', moi.authUserId]
      )
    );
    expect(code).toBe('SW033');
  });

  it('but a REFUND is never refused — rule 9 outranks paperwork', async () => {
    // The exception that matters most. A refund RELEASES custody. Gating it
    // would trap a customer's money behind a form its holder had not filled in,
    // which is standing rule 9 broken by administration rather than by malice.
    await actAsAdmin(db);
    const moi = await compteComplet();
    const autre = await compteComplet();

    // Take custody while consent is on file...
    await db.query(
      `select public.post_ledger_entry($1,$2,'credit','change',500,$3,$4,false,null,null,null)`,
      [moi.id, autre.customerId, 'r1', moi.authUserId]
    );
    // ...then lose it. However that happened, the money is still owed.
    await db.query(
      'update public.vendors set terms_accepted_at = null, terms_version = null where id = $1',
      [moi.id]
    );

    await expect(
      db.query(
        `select public.post_ledger_entry($1,$2,'debit','refund',500,$3,$4,true,null,null,'own_device')`,
        [moi.id, autre.customerId, 'r2', moi.authUserId]
      )
    ).resolves.toBeTruthy();
  });

  it('and the refusal names the next step, in French', async () => {
    // A refusal that does not say what to do gets retried until somebody gives
    // up. tests/32 owns the general rule; this is the one code it could not see
    // because it did not exist yet.
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const runtime = readFileSync(
      path.join(process.cwd(), 'supabase', 'functions', '_runtime', 'runtime.ts'),
      'utf8'
    ).replace(/\r\n/g, '\n');
    const bloc = /SW033:[\s\S]*?",\n/.exec(runtime);
    expect(bloc, 'SW033 has no French message').not.toBeNull();
    expect(bloc![0]).toMatch(/accepter les conditions/i);
    // Names where to go, not merely what went wrong.
    expect(bloc![0]).toMatch(/Compte|Conditions/);
  });
});

describe('the acknowledgement can be given later, and only once', () => {
  it('accept_terms records it and the credit then works', async () => {
    await actAsAdmin(db);
    const moi = await compteComplet({ conditions: false });
    const autre = await compteComplet();

    await actAs(db, moi.authUserId);
    await db.query('select public.accept_terms($1, $2)', [moi.authUserId, 'v1']);

    await actAsAdmin(db);
    await expect(
      db.query(
        `select public.post_ledger_entry($1,$2,'credit','change',500,$3,$4,false,null,null,null)`,
        [moi.id, autre.customerId, 'a1', moi.authUserId]
      )
    ).resolves.toBeTruthy();
  });

  it('accepting twice does not move the date', async () => {
    // A consent record whose timestamp can move is not a consent record. The
    // second call is a no-op that returns the original moment.
    await actAsAdmin(db);
    const moi = await compteComplet({ conditions: false });

    await actAs(db, moi.authUserId);
    const { rows: un } = await db.query(
      'select public.accept_terms($1, $2) as t', [moi.authUserId, 'v1']
    );
    await new Promise((r) => setTimeout(r, 50));
    const { rows: deux } = await db.query(
      'select public.accept_terms($1, $2) as t', [moi.authUserId, 'v2']
    );

    expect(deux[0].t.getTime()).toBe(un[0].t.getTime());

    // And the version that was actually accepted is the one still on file.
    await actAsAdmin(db);
    const { rows } = await db.query(
      'select terms_version from public.vendors where auth_user_id = $1', [moi.authUserId]
    );
    expect(rows[0].terms_version).toBe('v1');
  });

  it('and it cannot be given on somebody else\'s behalf', async () => {
    await actAsAdmin(db);
    const moi = await compteComplet({ conditions: false });
    const autre = await compteComplet({ conditions: false });

    await actAs(db, moi.authUserId);
    const code = await sqlstateOf(() =>
      db.query('select public.accept_terms($1, $2)', [autre.authUserId, 'v1'])
    );
    expect(code).toBe('SW002');
  });
});

describe('all four registers come from one row', () => {
  it('account_summary reports each side without adding them', async () => {
    await actAsAdmin(db);
    const moi = await compteComplet();
    const autre = await compteComplet();

    // I keep 500 for them; they keep 300 for me; they owe me 2 000.
    await db.query(
      `select public.post_ledger_entry($1,$2,'credit','change',500,$3,$4,false,null,null,null)`,
      [moi.id, autre.customerId, 's1', moi.authUserId]
    );
    await db.query(
      `select public.post_ledger_entry($1,$2,'credit','change',300,$3,$4,false,null,null,null)`,
      [autre.id, moi.customerId, 's2', autre.authUserId]
    );
    await db.query(
      `select public.post_debt_entry($1,$2,'owed','debt',2000,$3,$4,'declared',null,null)`,
      [moi.id, autre.customerId, 's3', moi.authUserId]
    );

    await actAs(db, moi.authUserId);
    const { rows } = await db.query(
      'select * from public.account_summary($1)', [moi.authUserId]
    );
    expect(rows).toHaveLength(1);
    const r = rows[0];

    expect(r.garde_cfa).toBe(500);
    expect(r.garde_pour_moi_cfa).toBe(300);
    expect(r.on_me_doit_cfa).toBe(2000);
    expect(r.je_dois_cfa).toBe(0);

    // NOTHING NETTED. 500 held and 2 000 owed are two facts; 1 500 is not one,
    // and neither is the 200 you would get by netting the two change figures.
    const valeurs = Object.values(r).map(Number).filter((n) => !Number.isNaN(n));
    for (const interdit of [1500, 2500, 200, 800, 2800]) {
      expect(valeurs, `${interdit} looks like two registers added together`)
        .not.toContain(interdit);
    }
  });

  it('and it refuses to answer about anybody else', async () => {
    await actAsAdmin(db);
    const moi = await compteComplet();
    const autre = await compteComplet();

    await actAs(db, moi.authUserId);
    const code = await sqlstateOf(() =>
      db.query('select * from public.account_summary($1)', [autre.authUserId])
    );
    expect(code).toBe('SW002');
  });
});
