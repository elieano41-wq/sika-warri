// The admin panel's gate, and the absence of a delete-users capability.
//
// A purge_orphan_auth action existed briefly. It was removed because it could
// delete REAL accounts: it built its keep-list with .select('auth_user_id') and
// no range, and PostgREST caps rows at 1000 by default — so past 1000 accounts,
// every real user beyond the cap looked like an orphan and would have been
// deleted. With two accounts it was harmless; at vendor scale it was a loaded
// gun in a support panel.
//
// The fix was removal, not a range parameter. A permanent delete-users button is
// the wrong shape for a one-off task, and this panel will one day be handed to
// someone else. These tests keep it gone and keep the gate honest.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import {
  connect, reset, actAs, actAsAdmin, seedVendor, seedCustomer,
  sqlstateOf, randomUUID, type SeededVendor,
} from './helpers/db';

const FONCTIONS = path.join(process.cwd(), 'supabase', 'functions');
const SRC = path.join(process.cwd(), 'src');

function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const adminFn = readFileSync(path.join(FONCTIONS, 'admin', 'index.ts'), 'utf8').replace(/\r\n/g, '\n');

// ---------------------------------------------------------------------------
// No admin action can delete a user
// ---------------------------------------------------------------------------

describe('the admin panel cannot delete users', () => {
  it('the admin function never calls deleteUser', () => {
    expect(code(adminFn)).not.toMatch(/deleteUser/);
  });

  it('no purge action exists', () => {
    const src = code(adminFn);
    expect(src).not.toMatch(/purge_orphan_auth/);
    expect(src).not.toMatch(/purge/i);
  });

  it('the panel offers no purge control', () => {
    const ecran = code(readFileSync(path.join(SRC, 'screens', 'admin', 'Admin.tsx'), 'utf8').replace(/\r\n/g, '\n'));
    expect(ecran).not.toMatch(/orphelin/i);
    expect(ecran).not.toMatch(/adminPurge/);
  });

  it('the API layer exposes no purge call', () => {
    const api = code(readFileSync(path.join(SRC, 'lib', 'api.ts'), 'utf8').replace(/\r\n/g, '\n'));
    expect(api).not.toMatch(/adminPurgeOrphanAuth/);
    expect(api).not.toMatch(/purge_orphan_auth/);
  });

  it('the ONLY deleteUser anywhere is register rolling back its own insert', () => {
    // Scoped and safe: it deletes the auth user it created moments earlier, and
    // only when the profile insert failed. Leaving it behind would make the
    // phone number permanently unregisterable.
    const appelants = walk(FONCTIONS)
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => /deleteUser/.test(code(readFileSync(f, 'utf8').replace(/\r\n/g, '\n'))))
      .map((f) => path.relative(FONCTIONS, f));

    expect(appelants).toEqual([path.join('register', 'index.ts')]);

    const reg = code(readFileSync(path.join(FONCTIONS, 'register', 'index.ts'), 'utf8').replace(/\r\n/g, '\n'));
    // It can only ever name the id it just created.
    expect(reg).toMatch(/deleteUser\(authUserId\)/);
  });

  it('no unbounded select feeds a destructive decision', () => {
    // The specific bug: a keep-list built from a truncated select. PostgREST
    // caps at 1000 rows by default, so an unbounded select is not a list of all
    // rows — it is a list of some of them.
    const src = code(adminFn);
    expect(src).not.toMatch(/\.select\('auth_user_id'\)/);
  });
});

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

let db: pg.Client;
let vendor: SeededVendor;

beforeAll(async () => { db = await connect(); });
afterAll(async () => { await actAsAdmin(db); await db.end(); });

beforeEach(async () => {
  await reset(db);
  vendor = await seedVendor(db);
  await seedCustomer(db);
});

describe('a non-admin cannot reach any admin action', () => {
  // Every action the panel offers, and the function behind it. If an action is
  // added without a gate, it will not appear here — so the list is checked
  // against the function source below.
  const ACTIONS = [
    ['admin_reset_queue', 'select * from public.admin_reset_queue($1::uuid)'],
    ['admin_vendor_list', 'select * from public.admin_vendor_list($1::uuid)'],
    ['admin_is_caller', 'select public.admin_is_caller($1::uuid)'],
    ['admin_reject_pin_reset',
      'select public.admin_reject_pin_reset($2::uuid, $1::uuid, null)'],
  ] as const;

  it.each(ACTIONS)('%s is unreachable from a vendor session', async (_nom, requete) => {
    await actAs(db, vendor.authUserId);
    const code_ = await sqlstateOf(() =>
      db.query(requete.replace('$2::uuid', `'${randomUUID()}'::uuid`), [vendor.authUserId])
    );
    // Refused for lack of privilege — the function is not granted to any client
    // role at all, so the admin check inside it never even runs.
    expect(code_).toBe('42501');
  });

  it('a NON-admin passed as actor is refused even by a privileged caller', async () => {
    // The service-role path, which is how the Edge Function calls these. The
    // gate must hold there too, or the whole panel rests on the client not
    // asking.
    await actAsAdmin(db);
    const code_ = await sqlstateOf(() =>
      db.query('select * from public.admin_vendor_list($1::uuid)', [vendor.authUserId])
    );
    expect(code_).toBe('SW001');
  });

  it('admin_is_caller returns false for a non-admin rather than throwing', async () => {
    // Used to gate actions that have no definer function of their own. It must
    // answer, not error, or a caller cannot tell "not an admin" from "broken".
    await actAsAdmin(db);
    const { rows } = await db.query('select public.admin_is_caller($1::uuid) as a', [
      vendor.authUserId,
    ]);
    expect(rows[0].a).toBe(false);
  });

  it('an admin actor IS accepted, so the gate is not blanket denial', async () => {
    await actAsAdmin(db);
    await db.query('insert into public.app_admins (auth_user_id, note) values ($1, $2)', [
      vendor.authUserId,
      'operator',
    ]);

    const code_ = await sqlstateOf(() =>
      db.query('select * from public.admin_vendor_list($1::uuid)', [vendor.authUserId])
    );
    expect(code_).toBeNull();
  });

  it('every admin_ function is withheld from authenticated', async () => {
    // Catches a future action added without the revoke. Discovered from the
    // catalog rather than from a list someone has to remember to update.
    await actAsAdmin(db);
    const { rows } = await db.query(
      `select p.proname,
              has_function_privilege('authenticated', p.oid, 'execute') as autorise
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname like 'admin\\_%'`
    );

    expect(rows.length).toBeGreaterThan(3);
    const ouverts = rows.filter((r) => r.autorise).map((r) => r.proname);
    expect(ouverts).toEqual([]);
  });

  it('the panel is reachable only with a server-issued flag', async () => {
    // The client cannot read is_admin. The flag comes back from login, and the
    // real gate is in SQL — so a forged flag shows a button that then fails.
    const app = code(readFileSync(path.join(SRC, 'App.tsx'), 'utf8').replace(/\r\n/g, '\n'));
    expect(app).toMatch(/estAdmin/);
    expect(app).not.toMatch(/is_admin/);

    const login = code(readFileSync(path.join(FONCTIONS, 'login', 'index.ts'), 'utf8').replace(/\r\n/g, '\n'));
    expect(login).toMatch(/is_admin_self/);
  });
});
