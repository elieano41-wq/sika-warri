// A grant is visible without signing out. A non-admin never sees the panel.
//
// ============================================================================
// THE BUG. The admin flag was captured once from the login response and held in
// React state. So a grant made while someone was logged in stayed invisible
// until they happened to log out — and a page RELOAD restored the session from
// localStorage without re-fetching, silently resetting the flag to false.
//
// The account that hit this had held the grant the whole time. app_admins was
// correct; the session was not. And the workaround — sign out and back in — is
// the one thing nobody thinks to try when a button is simply absent.
//
// Worst of all it is the SUPPORT panel: the screen you need precisely when
// something is wrong is the one most likely to have gone missing.
// ============================================================================
//
// Hiding the button was never the security control. Every admin action is gated
// again in SQL by is_admin(), so a stale flag shows a button that then fails —
// which tests/24 covers. This file is about VISIBILITY: can the app find out,
// at any moment, without a round trip through login.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import {
  connect, reset, actAs, actAsAdmin, seedVendor, seedCustomer, sqlstateOf,
  type SeededVendor, type SeededCustomer,
} from './helpers/db';

const SRC = path.join(process.cwd(), 'src');

function lire(...p: string[]): string {
  return readFileSync(path.join(...p), 'utf8').replace(/\r\n/g, '\n');
}

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

async function accorder(authUserId: string, note = 'operator') {
  await actAsAdmin(db);
  await db.query(
    'insert into public.app_admins (auth_user_id, note) values ($1, $2)',
    [authUserId, note]
  );
}

/** What the app asks on load: am I an admin? */
async function demande(authUserId: string): Promise<boolean> {
  const { rows } = await db.query('select public.admin_is_caller($1::uuid) as a', [
    authUserId,
  ]);
  return rows[0].a;
}

describe('a session can ask whether it is an admin', () => {
  it('the function is callable by an ordinary client session', async () => {
    // THE ROOT CAUSE. is_admin, is_admin_self and admin_is_caller were all
    // revoked from `authenticated`, so a client had no way to ask at all — the
    // only path was the login Edge Function, running as service role. That is
    // why the flag had to be carried in session state, and why it went stale.
    await actAsAdmin(db);
    const { rows } = await db.query(
      `select has_function_privilege('authenticated', p.oid, 'execute') as ok
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'admin_is_caller'`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].ok).toBe(true);
  });

  it('answers TRUE for an admin, from that admin\'s own session', async () => {
    await accorder(vendor.authUserId);
    await actAs(db, vendor.authUserId);
    expect(await demande(vendor.authUserId)).toBe(true);
  });

  it('answers FALSE for a non-admin rather than erroring', async () => {
    // It has to answer, not throw: a caller cannot tell "not an admin" from
    // "broken" if the failure mode is the same.
    await actAs(db, vendor.authUserId);
    expect(await demande(vendor.authUserId)).toBe(false);
  });

  it('a customer session can ask about itself too', async () => {
    // Admin is a property of the auth user, not of a role. The check runs on
    // both sides of the app for the same reason.
    await actAs(db, client.authUserId!);
    expect(await demande(client.authUserId!)).toBe(false);
  });
});

describe('a grant is visible WITHOUT re-authenticating', () => {
  it('the same session sees false, then true, with no new login', async () => {
    // The whole point. Nothing here logs in or out: one session asks before the
    // grant and after it, exactly as the app does when it re-checks on load.
    await actAs(db, vendor.authUserId);
    expect(await demande(vendor.authUserId)).toBe(false);

    await accorder(vendor.authUserId);

    await actAs(db, vendor.authUserId);
    expect(await demande(vendor.authUserId)).toBe(true);
  });

  it('and a revoked grant disappears the same way', async () => {
    await accorder(vendor.authUserId);
    await actAs(db, vendor.authUserId);
    expect(await demande(vendor.authUserId)).toBe(true);

    await actAsAdmin(db);
    await db.query('delete from public.app_admins where auth_user_id = $1', [
      vendor.authUserId,
    ]);

    await actAs(db, vendor.authUserId);
    expect(await demande(vendor.authUserId)).toBe(false);
  });
});

describe('it still cannot be used to enumerate admins', () => {
  it('asking about ANOTHER user is refused', async () => {
    // The reason this function exists rather than exposing is_admin(). Granting
    // it to clients would be wrong if it answered about anyone else.
    const autre = await seedVendor(db);
    await accorder(autre.authUserId);

    await actAs(db, vendor.authUserId);
    const code = await sqlstateOf(() =>
      db.query('select public.admin_is_caller($1::uuid)', [autre.authUserId])
    );
    expect(code).toBe('SW002');
  });

  it('app_admins itself stays unreadable', async () => {
    await accorder(vendor.authUserId);
    await actAs(db, vendor.authUserId);
    const { rows } = await db.query('select * from public.app_admins');
    // Even an admin cannot list the table through a client session; the boolean
    // about yourself is the entire disclosure.
    expect(rows).toEqual([]);
  });
});

describe('the app asks on load, not only at login', () => {
  const app = lire('App.tsx');

  it('the admin check runs in the profile effect', () => {
    // Where it belongs: that effect already runs on every load and on every
    // session change, so the answer refreshes on a reload without a second
    // lifecycle to keep in step.
    expect(app).toMatch(/amIAdmin\(/);
    const effet = /useEffect\(\(\) => \{[\s\S]*?myVendor[\s\S]*?\}, \[session\]\);/.exec(app);
    expect(effet, 'profile effect not found').not.toBeNull();
    expect(effet![0]).toMatch(/amIAdmin/);
  });

  it('the flag is not ONLY seeded from the login response', () => {
    // Seeding at login is fine — the button appears immediately. What is not
    // fine is that being the only source, which is what made a reload lose it.
    const seeds = (app.match(/setEstAdmin\(/g) ?? []).length;
    expect(seeds).toBeGreaterThan(1);
  });

  it('a failed check answers NO rather than yes', () => {
    // On a flaky connection the safe answer is the one that shows less. The
    // reverse would put a support button in front of someone who has no grant,
    // and every action behind it would then fail confusingly.
    const api = lire('lib', 'api.ts');
    const fn = /export async function amIAdmin[\s\S]*?\n\}/.exec(api);
    expect(fn, 'amIAdmin not found').not.toBeNull();
    expect(fn![0]).toMatch(/catch/);
    expect(fn![0]).toMatch(/return false/);
  });
});

describe('the account screen states the answer in plain words', () => {
  const compte = lire('screens', 'Compte.tsx');

  it('says Compte support, oui or non', () => {
    // Two taps to distinguish three causes: the grant is gone, the session is
    // stale, or the build is old. Staring at a home screen distinguishes none.
    expect(compte).toMatch(/Compte support/);
    expect(compte).toMatch(/'Oui'/);
    expect(compte).toMatch(/'Non'/);
  });

  it('shows it to NON-admins too', () => {
    // "Non" is the useful half: it separates "you are not an admin" from "you
    // are, and the button is broken". Rendering only for admins would leave the
    // ambiguity exactly where it was.
    const bloc = /Compte support[\s\S]{0,600}/.exec(compte)![0];
    expect(bloc).toMatch(/estAdmin \? 'Oui' : 'Non'/);
    // Not wrapped in a truthiness gate.
    expect(compte).not.toMatch(/estAdmin \? \([\s\S]{0,80}Compte support/);
  });

  it('shows the build alongside it', () => {
    // If the status looks wrong the next question is always "is this the build
    // I think it is". Both in one place saves the round trip.
    const bloc = /Compte support[\s\S]{0,600}/.exec(compte)![0];
    expect(bloc).toMatch(/__BUILD_SHA__/);
  });
});

describe('nothing else is captured at login and left to rot', () => {
  it('the login response has no unused flags still being read', () => {
    // pinChangeRequired and vendorDeviceEntries are returned by the login
    // function and were never consumed by any screen — the PIN-change nudge
    // reaches the user only through `notice`. Recorded here so the next person
    // to add a login-time flag has to think about its lifetime.
    const api = lire('lib', 'api.ts');
    const bloc = /export async function login[\s\S]*?\n\}/.exec(api)![0];
    expect(bloc).toMatch(/isAdmin/);

    const app = lire('App.tsx');
    for (const champ of ['pinChangeRequired', 'vendorDeviceEntries']) {
      // If one of these starts driving UI, it needs refreshing on load like the
      // admin flag — this assertion is what forces that decision.
      expect(app, `${champ} now drives UI and must refresh on load`)
        .not.toMatch(new RegExp(champ));
    }
  });
});
