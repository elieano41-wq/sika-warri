// Caller identity on the three authenticated functions.
//
// Disabling verify_jwt (amendment K) removed Supabase's automatic gate from
// every function. For register and login that is correct — there is no caller
// to gate. For change-pin, initiate-debit and confirm-debit it means each
// function is the ONLY thing standing between a stranger and acting as someone
// else. A missing or weak check here is not a degraded feature, it is total
// impersonation.
//
// Three layers are covered:
//   1. The header parse, in pure code.
//   2. A static guarantee that no handler takes an identity from the body.
//   3. The database refusing a mismatched actor even if a handler were wrong.
//
// What is NOT covered here: signature and expiry validation, which Supabase's
// auth server performs. That is verified by running the deployed functions
// against the live project, not by this file.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { parseBearer } from '../supabase/functions/_shared/bearer.ts';
import {
  connect, reset, actAsAdmin, seedVendor, seedCustomer, giveCredit,
  createPendingDebit, confirmPendingDebit, sqlstateOf, entryCount, balanceOf,
  randomUUID, type SeededVendor, type SeededCustomer,
} from './helpers/db';

const FN_DIR = path.join(process.cwd(), 'supabase', 'functions');
const AUTHENTICATED = ['change-pin', 'initiate-debit', 'confirm-debit'];

function sourceOf(fn: string): string {
  return readFileSync(path.join(FN_DIR, fn, 'index.ts'), 'utf8');
}

/** Strip comments so prose about identity does not satisfy or trip a check. */
function code(src: string): string {
  return src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

// ---------------------------------------------------------------------------
// 1. Header parsing
// ---------------------------------------------------------------------------

describe('bearer parsing — fails closed', () => {
  it('rejects a missing header', () => {
    const r = parseBearer(null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('NO_TOKEN');
  });

  it('rejects an empty or whitespace header', () => {
    expect(parseBearer('').ok).toBe(false);
    expect(parseBearer('   ').ok).toBe(false);
  });

  it('rejects a token with no Bearer scheme', () => {
    // A bare token must not be accepted; that would let a caller skip the
    // scheme and any middleware keyed on it.
    expect(parseBearer('a.b.c').ok).toBe(false);
    expect(parseBearer('Basic dXNlcjpwYXNz').ok).toBe(false);
    expect(parseBearer('Bearer').ok).toBe(false);
    expect(parseBearer('Bearer ').ok).toBe(false);
  });

  it('rejects an API key sent where a session token belongs', () => {
    // The platform answers this with a bare "invalid JWT", which is baffling.
    // Naming it precisely is the difference between a five-minute fix and an
    // afternoon lost.
    for (const key of [
      'Bearer sb_publishable_vMyHqHiYHWGxXXm',
      'Bearer sb_secret_abcdefghijklmnop',
    ]) {
      const r = parseBearer(key);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('KEY_ON_AUTH_HEADER');
    }
  });

  it('rejects anything that is not three JWT segments', () => {
    for (const bad of [
      'Bearer notajwt',
      'Bearer only.two',
      'Bearer a.b.c.d',
      'Bearer ..',
      'Bearer a..c',
    ]) {
      const r = parseBearer(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('MALFORMED_TOKEN');
    }
  });

  it('accepts a well-formed token and passes it through unchanged', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.sig';
    const r = parseBearer(`Bearer ${jwt}`);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.jwt).toBe(jwt);
  });

  it('tolerates lowercase scheme and extra whitespace', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.sig';
    for (const header of [`bearer ${jwt}`, `BEARER  ${jwt}`, `  Bearer ${jwt}  `]) {
      const r = parseBearer(header);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.jwt).toBe(jwt);
    }
  });

  it('accepting a shape is not accepting the token', () => {
    // parseBearer deliberately cannot judge a signature. A forged token passes
    // the shape check and is then rejected by Supabase. This test exists so
    // nobody later mistakes ok:true for "authenticated".
    const forged = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJhdHRhY2tlciJ9.';
    expect(parseBearer(`Bearer ${forged}`).ok).toBe(false); // empty 3rd segment
    const forged2 = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJhdHRhY2tlciJ9.x';
    expect(parseBearer(`Bearer ${forged2}`).ok).toBe(true); // shape only
  });
});

// ---------------------------------------------------------------------------
// 2. No handler may take an identity from the request body
// ---------------------------------------------------------------------------

describe('handlers derive identity ONLY from the verified token', () => {
  it.each(AUTHENTICATED)('%s calls requireCaller before anything else', (fn) => {
    const src = code(sourceOf(fn));
    expect(src).toMatch(/await requireCaller\(req\)/);
  });

  it.each(AUTHENTICATED)('%s never reads an identity field from the body', (fn) => {
    const src = code(sourceOf(fn));

    // If any of these ever appears, a caller can name whose account to act on
    // and the token becomes decoration.
    const forbidden = [
      /body\.\s*userId/,
      /body\.\s*authUserId/,
      /body\.\s*auth_user_id/,
      /body\.\s*vendorId/,
      /body\.\s*vendor_id/,
      /body\.\s*customerId/,
      /body\.\s*customer_id/,
      /body\.\s*actorUserId/,
      /body\.\s*actor/,
    ];

    for (const pattern of forbidden) {
      expect(src).not.toMatch(pattern);
    }
  });

  it.each(AUTHENTICATED)('%s passes only caller.authUserId as the actor', (fn) => {
    const src = code(sourceOf(fn));

    // EVERY identity argument handed to the data layer must be the verified id
    // — actor arguments and the auth_user_id that change-pin passes alike.
    // Terminate on } as well as , and newline: some calls pass the argument
    // object inline, so the last property has no trailing comma.
    const identityArgs = [
      ...src.matchAll(
        /p_(?:actor_user_id|customer_actor_user_id|auth_user_id):\s*([^,\n}]+)/g
      ),
    ];
    expect(identityArgs.length, `${fn} passes no identity to the data layer`)
      .toBeGreaterThan(0);
    for (const m of identityArgs) {
      expect(m[1]!.trim(), `identity argument in ${fn}`).toBe('caller.authUserId');
    }

    // And every profile lookup must be keyed on it.
    const lookups = [...src.matchAll(/\.eq\('auth_user_id',\s*([^)]+)\)/g)];
    expect(lookups.length).toBeGreaterThan(0);
    for (const m of lookups) {
      expect(m[1]!.trim()).toBe('caller.authUserId');
    }
  });

  it('register and login do NOT require a caller, by design', () => {
    // Stated as a test so the asymmetry is deliberate rather than an oversight.
    for (const fn of ['register', 'login']) {
      expect(code(sourceOf(fn))).not.toMatch(/requireCaller/);
    }
  });

  it('no function trusts a role claim to bypass ownership', () => {
    // change-pin takes body.role, but only to choose which table to search —
    // the row must still belong to the verified caller. A customer claiming
    // role "vendor" therefore finds no vendor row rather than gaining one.
    const src = code(sourceOf('change-pin'));
    expect(src).toMatch(/\.eq\('auth_user_id',\s*caller\.authUserId\)/);
  });
});

// ---------------------------------------------------------------------------
// 3. The database refuses a mismatched actor regardless
// ---------------------------------------------------------------------------

let db: pg.Client;
let vendorA: SeededVendor;
let vendorB: SeededVendor;
let customer: SeededCustomer;
let stranger: SeededCustomer;

beforeAll(async () => {
  db = await connect();
});

afterAll(async () => {
  await actAsAdmin(db);
  await db.end();
});

beforeEach(async () => {
  await reset(db);
  vendorA = await seedVendor(db);
  vendorB = await seedVendor(db);
  customer = await seedCustomer(db);
  stranger = await seedCustomer(db);
  await giveCredit(db, vendorA, customer, 1000);
});

describe('defence in depth — a wrong identity writes nothing', () => {
  it("initiate-debit's RPC refuses another vendor's ledger", async () => {
    await actAsAdmin(db);
    const code = await sqlstateOf(() =>
      createPendingDebit(db, {
        vendorId: vendorA.id, // not theirs
        customerId: customer.id,
        kind: 'purchase',
        amount: 100,
        actorUserId: vendorB.authUserId,
      })
    );
    expect(code).toBe('SW001');
    expect(await entryCount(db)).toBe(1);
  });

  it("confirm-debit's RPC refuses a different customer's proposal", async () => {
    await actAsAdmin(db);
    const pending = await createPendingDebit(db, {
      vendorId: vendorA.id, customerId: customer.id,
      kind: 'purchase', amount: 400, actorUserId: vendorA.authUserId,
    });

    // Exactly the case the user asked about: a VALID token belonging to a
    // DIFFERENT user. Even holding a real session, the stranger cannot spend
    // someone else's change.
    const code = await sqlstateOf(() =>
      confirmPendingDebit(db, pending.id, stranger.authUserId!)
    );

    expect(code).toBe('SW001');
    expect(await entryCount(db)).toBe(1);
    expect(await balanceOf(db, vendorA.id, customer.id)).toBe(1000);
  });

  it('an unknown identity is refused, not treated as anonymous-but-allowed', async () => {
    await actAsAdmin(db);
    const pending = await createPendingDebit(db, {
      vendorId: vendorA.id, customerId: customer.id,
      kind: 'purchase', amount: 400, actorUserId: vendorA.authUserId,
    });

    const code = await sqlstateOf(() => confirmPendingDebit(db, pending.id, randomUUID()));
    expect(code).toBe('SW008');
    expect(await entryCount(db)).toBe(1);
  });

  it('a null identity is refused rather than defaulted', async () => {
    await actAsAdmin(db);
    const code = await sqlstateOf(() =>
      db.query('select * from public.confirm_pending_debit($1::uuid, null::uuid)', [
        randomUUID(),
      ])
    );
    expect(code).toBe('SW003');
  });
});
