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
import { sansCommentaires } from './helpers/source';

const SRC = path.join(process.cwd(), 'src');

/**
 * Read a file under src/, with line endings normalised.
 *
 * Rooted at SRC rather than the cwd: every call site here passes a path
 * relative to src, and joining them without the root resolved 'App.tsx' against
 * the repo root and threw ENOENT. Normalised because the repo is CRLF on
 * Windows and `.` does not match \r — see tests/32.
 */
function lire(...p: string[]): string {
  return readFileSync(path.join(SRC, ...p), 'utf8').replace(/\r\n/g, '\n');
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

    // REFUSED, not merely empty. I expected an empty result set through RLS and
    // the table is stricter than that: `authenticated` has no select grant at
    // all, so the query is rejected outright. Asserting the refusal records the
    // stronger guarantee rather than the weaker one I assumed.
    const code_ = await sqlstateOf(() => db.query('select * from public.app_admins'));
    expect(code_).toBe('42501');
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

describe('the diagnostic is for admins, and only admins', () => {
  // Comments stripped: the prose in this file explains the removal by quoting
  // the very strings it forbids, and a leak check that counts comments teaches
  // the next person to describe the rule vaguely instead of naming it.
  const compte = sansCommentaires(lire('screens', 'Compte.tsx'));

  // REVERSED DELIBERATELY. The first version of this screen showed everybody
  // "Compte support : Non", on the reasoning that "Non" is the useful half —
  // it separates "you are not an admin" from "you are, and the button is
  // broken". True for whoever is debugging, and wrong for everyone else: it
  // answers a question an ordinary user never asked, and announces that a door
  // exists. Someone keeping a debt book does not need to be told which parts of
  // the app are not for them.
  //
  // The diagnostic did not go away. It moved inside the admin-only card, where
  // the person who needs it is the only person who sees it.

  it('the status and the build live inside one admins-only card', () => {
    const carte = /\{estAdmin \? \([\s\S]*?\) : null\}/.exec(compte);
    expect(carte, 'admin-only card not found').not.toBeNull();
    expect(carte![0]).toMatch(/Compte support/);
    expect(carte![0]).toMatch(/__BUILD_SHA__/);
    expect(carte![0]).toMatch(/Panneau support/);
  });

  it('a non-admin is told nothing about it', () => {
    // No "Non", no greyed-out entry, no mention of a panel. The three strings
    // that would leak it, each checked outside the admin-only card.
    const sansCarte = compte.replace(/\{estAdmin \? \([\s\S]*?\) : null\}/g, '');
    for (const fuite of [/Compte support/, /Panneau support/, /panneau support/]) {
      expect(sansCarte, `${fuite} is rendered outside the admin-only card`)
        .not.toMatch(fuite);
    }
  });

  it('what a non-admin gets instead is a number to call', () => {
    // The replacement, and the reason removing the card is not a loss: someone
    // with a problem needs a person, not a status line.
    const aide = /\{!estAdmin && SUPPORT_TEL \? \([\s\S]*?\) : null\}/.exec(compte);
    expect(aide, 'support contact block not found').not.toBeNull();
    expect(aide![0]).toMatch(/Contacter le support/);
    expect(aide![0]).toMatch(/href=\{`tel:/);
  });

  it('and no number is invented when none is configured', () => {
    // A wrong support number sends someone to a stranger at the worst possible
    // moment. Absent configuration, the block is absent.
    expect(compte).toMatch(/SUPPORT_TEL\s*=\s*\(import\.meta\.env\.VITE_SUPPORT_TEL/);
    const litteral = /tel:\+?\d/.exec(compte);
    expect(litteral, 'a phone number is hard-coded into the screen').toBeNull();
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
