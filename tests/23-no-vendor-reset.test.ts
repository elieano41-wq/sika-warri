// Vendors have NO reset capability whatsoever.
//
// The removed model let a vendor vouch for a customer's PIN reset. The hole was
// that the vouching vendor could claim the reset themselves — enter the
// customer's number on their own phone, set a code they knew, and hold that
// customer's account. They could then confirm debits at will, which is exactly
// what amendment H exists to prevent. A cooling-off period delayed that; it did
// not prevent it, and a patient attacker simply waited.
//
// Detection is not sufficient when the thing being protected is someone's money.
// So the capability is gone, not merely restricted, and this file exists to keep
// it gone.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import {
  connect, reset, actAs, actAsAdmin, seedVendor, seedCustomer, giveCredit,
  sqlstateOf, randomUUID, type SeededVendor, type SeededCustomer,
} from './helpers/db';

const SRC = path.join(process.cwd(), 'src');
const FONCTIONS = path.join(process.cwd(), 'supabase', 'functions');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|--)/.test(l))
    .join('\n');
}

let db: pg.Client;
let vendorA: SeededVendor;
let vendorB: SeededVendor;
let customer: SeededCustomer;

beforeAll(async () => { db = await connect(); });
afterAll(async () => { await actAsAdmin(db); await db.end(); });

beforeEach(async () => {
  await reset(db);
  vendorA = await seedVendor(db);
  vendorB = await seedVendor(db);
  customer = await seedCustomer(db);
  await giveCredit(db, vendorA, customer, 1000);
});

// ---------------------------------------------------------------------------
// The capability is gone from the database
// ---------------------------------------------------------------------------

describe('the vouching path no longer exists', () => {
  it('request_customer_pin_reset is gone', async () => {
    await actAsAdmin(db);
    const { rows } = await db.query(
      `select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and proname = 'request_customer_pin_reset'`
    );
    expect(rows).toEqual([]);
  });

  it('the cooling-off machinery is gone with it', async () => {
    await actAsAdmin(db);
    const { rows } = await db.query(
      `select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and proname in ('vendor_barred_until', 'pin_reset_cooloff')`
    );
    // It existed only to blunt the vouching attack. Leaving it would be a rule
    // nobody could explain.
    expect(rows).toEqual([]);
  });

  it('no function anywhere lets a vendor authorise a reset', async () => {
    await actAsAdmin(db);
    const { rows } = await db.query(
      `select p.proname, pg_get_function_arguments(p.oid) as args
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname like '%reset%'`
    );

    for (const r of rows) {
      // A reset function taking a vendor id would be the old shape returning.
      expect(r.args ?? '', `${r.proname} accepts a vendor id`).not.toMatch(/p_vendor_id/);
    }
  });
});

describe('no client role can reach any reset machinery', () => {
  const FONCTIONS_PRIVEES = [
    'create_pin_reset_request',
    'admin_reset_queue',
    'admin_issue_pin_reset',
    'admin_reject_pin_reset',
    'open_grant_for_phone',
    'record_grant_attempt',
    'consume_grant',
    'admin_vendor_list',
    'admin_verify_phone',
    'admin_set_vendor_active',
    'is_admin',
  ];

  it.each(FONCTIONS_PRIVEES)('%s is not executable by authenticated', async (nom) => {
    await actAsAdmin(db);
    const { rows } = await db.query(
      `select has_function_privilege('authenticated', p.oid, 'execute') as autorise
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = $1`,
      [nom]
    );
    expect(rows.length, `${nom} does not exist`).toBeGreaterThan(0);
    for (const r of rows) expect(r.autorise, `${nom} is callable`).toBe(false);
  });

  it('a vendor session cannot read the request queue', async () => {
    await actAs(db, vendorA.authUserId);
    expect(
      await sqlstateOf(() => db.query('select * from public.pin_reset_requests'))
    ).toBe('42501');
  });

  it('a vendor session cannot read grants — the code hashes live there', async () => {
    await actAs(db, vendorA.authUserId);
    expect(
      await sqlstateOf(() => db.query('select * from public.pin_reset_grants'))
    ).toBe('42501');
  });

  it('a vendor cannot make themselves an admin', async () => {
    await actAs(db, vendorA.authUserId);
    expect(
      await sqlstateOf(() =>
        db.query('insert into public.app_admins (auth_user_id) values ($1)', [
          vendorA.authUserId,
        ])
      )
    ).toBe('42501');
  });

  it('a vendor cannot even read who the admins are', async () => {
    await actAs(db, vendorA.authUserId);
    expect(
      await sqlstateOf(() => db.query('select * from public.app_admins'))
    ).toBe('42501');
  });
});

// ---------------------------------------------------------------------------
// The properties the old tests protected, still holding
// ---------------------------------------------------------------------------

describe('a vendor still cannot impersonate or act for a customer', () => {
  it('cannot post a confirmed debit from their own session', async () => {
    await actAs(db, vendorA.authUserId);
    const code_ = await sqlstateOf(() =>
      db.query(
        `select * from public.post_ledger_entry(
           $1::uuid, $2::uuid, 'debit', 'purchase', 100, $3::text,
           $4::uuid, true, null::uuid, null::text, 'own_device')`,
        [vendorA.id, customer.id, randomUUID(), vendorA.authUserId]
      )
    );
    expect(code_).toBe('SW014');
  });

  it("cannot confirm a pending debit, even their own", async () => {
    await actAsAdmin(db);
    const { rows } = await db.query(
      `select * from public.create_pending_debit(
         $1::uuid, $2::uuid, 'purchase', 400, $3::text, $4::uuid, null::uuid)`,
      [vendorA.id, customer.id, randomUUID(), vendorA.authUserId]
    );
    const pending = rows[0];

    await actAs(db, vendorA.authUserId);
    expect(
      await sqlstateOf(() =>
        db.query('select * from public.confirm_pending_debit($1::uuid, $2::uuid)', [
          pending.id,
          customer.authUserId,
        ])
      )
    ).toBe('42501');
  });

  it("cannot act against another vendor's ledger", async () => {
    await actAsAdmin(db);
    expect(
      await sqlstateOf(() =>
        db.query(
          `select * from public.create_pending_debit(
             $1::uuid, $2::uuid, 'purchase', 100, $3::text, $4::uuid, null::uuid)`,
          [vendorA.id, customer.id, randomUUID(), vendorB.authUserId]
        )
      )
    ).toBe('SW001');
  });
});

// ---------------------------------------------------------------------------
// The source no longer offers a vendor a reset
// ---------------------------------------------------------------------------

describe('the app offers vendors no reset path', () => {
  it('the vouching Edge Function is deleted, not disabled', () => {
    // A disabled function is one config edit from returning.
    expect(existsSync(path.join(FONCTIONS, 'request-reset'))).toBe(false);
  });

  it('no screen calls a vendor-vouched reset', () => {
    for (const f of walk(SRC).filter((x) => /\.tsx?$/.test(x))) {
      const src = code(readFileSync(f, 'utf8'));
      expect(src, `${path.basename(f)} still vouches`).not.toMatch(/requestCustomerReset/);
      expect(src, `${path.basename(f)} still vouches`).not.toMatch(/request-reset/);
    }
  });

  it('the vendor UI tells them they cannot reset a customer', () => {
    const src = readFileSync(
      path.join(SRC, 'screens', 'vendeur', 'MesClients.tsx'), 'utf8'
    ).replace(/\s+/g, ' ');
    expect(src).toMatch(/Vous ne pouvez pas réinitialiser son code/i);
    // And that they must never ask for it, which is the behaviour that matters.
    expect(src).toMatch(/jamais le lui demander/i);
  });

  it('the reset code is never chosen by a human', () => {
    const admin = code(readFileSync(path.join(FONCTIONS, 'admin', 'index.ts'), 'utf8'));
    // Generated by a CSPRNG in the function; the SQL takes only a hash, so
    // there is no parameter through which an operator could impose a code.
    expect(admin).toMatch(/genererCode\(\)/);
    expect(admin).not.toMatch(/body\.code/);
    expect(admin).not.toMatch(/p_code:/);
  });

  it('only the hash of the code is ever stored', () => {
    const sql = code(
      readFileSync(
        path.join(process.cwd(), 'supabase', 'migrations', '0020_support_desk_recovery.sql'),
        'utf8'
      )
    );
    expect(sql).toMatch(/code_hash/);
    expect(sql).toMatch(/code_salt/);
    // A plaintext column would let a database leak hand out working codes, and
    // would let the operator retrieve a code they had already read out.
    expect(sql).not.toMatch(/code_plain|code_clair|\bcode text\b/);
  });
});

// ---------------------------------------------------------------------------
// An admin account may never also be a customer account
// ---------------------------------------------------------------------------

describe('admin and customer roles cannot coexist on one account', () => {
  // The support-desk model rests on separation: the operator issues reset codes,
  // and the people whose accounts get reset are on the other side of that desk.
  // An account holding both collapses it — a customer with support powers can
  // issue themselves a code, which is the vendor-vouching hole with more reach.

  it('granting admin to an existing customer is refused', async () => {
    const customer2 = await seedCustomer(db);
    await actAsAdmin(db);

    const code_ = await sqlstateOf(() =>
      db.query('insert into public.app_admins (auth_user_id, note) values ($1, $2)', [
        customer2.authUserId,
        'should be impossible',
      ])
    );

    expect(code_).toBe('SW018');
  });

  it('creating a customer for an existing admin is refused', async () => {
    // The other direction. Either order of operations reaches the same
    // forbidden state, so both are blocked.
    await actAsAdmin(db);
    const authId = randomUUID();
    await db.query('insert into public.app_admins (auth_user_id, note) values ($1, $2)', [
      authId,
      'operator',
    ]);

    const code_ = await sqlstateOf(() =>
      db.query(
        'insert into public.customers (auth_user_id, phone) values ($1, $2)',
        [authId, '2250700009999']
      )
    );

    expect(code_).toBe('SW018');
  });

  it('LINKING an admin to a vendor-created customer stub is refused', async () => {
    // Registration claims a stub by UPDATE, not INSERT. Covering only INSERT
    // would leave the whole registration path open.
    await actAsAdmin(db);
    const authId = randomUUID();
    await db.query('insert into public.app_admins (auth_user_id) values ($1)', [authId]);

    const { rows } = await db.query(
      `insert into public.customers (phone) values ('2250700008888') returning id`
    );

    const code_ = await sqlstateOf(() =>
      db.query('update public.customers set auth_user_id = $1 where id = $2', [
        authId,
        rows[0].id,
      ])
    );

    expect(code_).toBe('SW018');
  });

  it('a VENDOR may hold admin — the operator runs a shop', async () => {
    // Deliberately permitted. The restriction is about the customer side of the
    // desk, not about admins being forbidden an account at all.
    await actAsAdmin(db);
    const vendorC = await seedVendor(db);

    const code_ = await sqlstateOf(() =>
      db.query('insert into public.app_admins (auth_user_id, note) values ($1, $2)', [
        vendorC.authUserId,
        'operator vendor',
      ])
    );

    expect(code_).toBeNull();
  });

  it('no auth user currently holds both roles', async () => {
    // Guards against a row that predates the trigger.
    await actAsAdmin(db);
    const { rows } = await db.query(
      `select a.auth_user_id
         from public.app_admins a
         join public.customers c on c.auth_user_id = a.auth_user_id`
    );
    expect(rows).toEqual([]);
  });
});
