// An expired access token renews itself. Nobody re-enters a PIN at the counter.
//
// ============================================================================
// THE BUG, found while answering "what else only refreshes at login?".
//
// login() returned a refresh token. The app stored it, persisted it across
// reloads, typed it — and never used it. Supabase access tokens last an hour,
// so an hour into the working day every request came back 401 and the vendor
// read "Une erreur est survenue, réessayez". Retrying is the one thing that
// could never work. The cure was signing out and back in, which is precisely
// the move nobody thinks of, and precisely the shape of the admin-flag bug.
// ============================================================================
//
// Tested against a STUBBED fetch rather than a live project: expiry is the
// thing under test, and waiting an hour for a real token to lapse is not a
// test. Every assertion here is about what the client does with a 401 — how
// many calls it makes, in what order, carrying which token and which body.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const URL_BASE = 'https://exemple.supabase.co';

type Appel = { url: string; auth: string | null; body: string | null };
let appels: Appel[] = [];

/** Queue of responses, consumed in order. */
let reponses: Array<{ status: number; body: unknown }> = [];

function stubFetch() {
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    appels.push({
      url: String(url),
      auth: headers.get('Authorization'),
      body: (init.body as string) ?? null,
    });
    const r = reponses.shift();
    if (!r) throw new Error(`unexpected extra request to ${url}`);
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

async function chargerApi() {
  vi.stubEnv('VITE_SUPABASE_URL', URL_BASE);
  vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_test');
  vi.resetModules();
  return await import('../src/lib/api');
}

const SESSION = {
  accessToken: 'jeton-perime',
  refreshToken: 'renouvellement-1',
  role: 'vendor' as const,
  msisdn: '2250700000001',
};

beforeEach(() => {
  appels = [];
  reponses = [];
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('an expired token is renewed and the request retried', () => {
  it('renews once, retries once, and returns the real answer', async () => {
    const api = await chargerApi();
    let publiee: any = null;
    api.brancherSession(SESSION, (s) => { publiee = s; });

    reponses = [
      { status: 401, body: { code: 'PGRST301', message: 'JWT expired' } },
      { status: 200, body: { access_token: 'jeton-frais', refresh_token: 'renouvellement-2' } },
      { status: 200, body: [{ id: 'v1', auth_user_id: 'u1', business_name: 'Chez Awa' }] },
    ];

    const v = await api.myVendor(SESSION.accessToken);
    expect(v.id).toBe('v1');

    // Three calls, in this order, and no more. A fourth would mean a loop.
    expect(appels).toHaveLength(3);
    expect(appels[0]!.url).toContain('/rest/v1/vendors');
    expect(appels[1]!.url).toContain('grant_type=refresh_token');
    expect(appels[2]!.url).toContain('/rest/v1/vendors');

    // The retry carries the NEW token. Carrying the old one would 401 forever.
    expect(appels[0]!.auth).toBe('Bearer jeton-perime');
    expect(appels[2]!.auth).toBe('Bearer jeton-frais');

    // And the renewed session is published so it survives the next reload.
    expect(publiee).toMatchObject({
      accessToken: 'jeton-frais',
      refreshToken: 'renouvellement-2',
      role: 'vendor',
    });
  });

  it('retries a WRITE with the same idempotency key, not a new one', async () => {
    // Rule 8 is what makes retrying safe at all. If the renewal path minted a
    // fresh key, a token expiring mid-write would post the entry twice — the
    // exact double-entry tests/33 exists to prevent, reintroduced through the
    // back door.
    const api = await chargerApi();
    api.brancherSession(SESSION, () => {});

    reponses = [
      { status: 401, body: { code: 'PGRST301', message: 'JWT expired' } },
      { status: 200, body: { access_token: 'jeton-frais', refresh_token: 'renouvellement-2' } },
      { status: 200, body: { id: 'entree-1' } },
    ];

    await api.recordCredit(SESSION.accessToken, {
      vendorId: 'v1',
      customerId: 'c1',
      actorUserId: 'u1',
      amountCfa: 500,
      idempotencyKey: 'cle-unique-abc',
    });

    const ecritures = appels.filter((a) => a.url.includes('post_ledger_entry'));
    expect(ecritures).toHaveLength(2);
    expect(ecritures[0]!.body).toBe(ecritures[1]!.body);
    expect(ecritures[0]!.body).toContain('cle-unique-abc');
  });

  it('renews ONCE when two requests expire together', async () => {
    // GoTrue rotates the refresh token. Two parallel renewals would spend it
    // twice and the loser would be logged out seconds after being repaired.
    const api = await chargerApi();
    api.brancherSession(SESSION, () => {});

    reponses = [
      { status: 401, body: { message: 'JWT expired' } },
      { status: 401, body: { message: 'JWT expired' } },
      { status: 200, body: { access_token: 'jeton-frais', refresh_token: 'renouvellement-2' } },
      { status: 200, body: [{ id: 'v1', auth_user_id: 'u1', business_name: 'Chez Awa' }] },
      { status: 200, body: [{ id: 'v1', auth_user_id: 'u1', business_name: 'Chez Awa' }] },
    ];

    await Promise.all([
      api.myVendor(SESSION.accessToken),
      api.myVendor(SESSION.accessToken),
    ]);

    const renouvellements = appels.filter((a) => a.url.includes('grant_type=refresh_token'));
    expect(renouvellements).toHaveLength(1);
  });
});

describe('when renewal cannot help, it says something true', () => {
  it('a dead refresh token asks for a sign-in, in French', async () => {
    const api = await chargerApi();
    api.brancherSession(SESSION, () => {});

    reponses = [
      { status: 401, body: { message: 'JWT expired' } },
      { status: 400, body: { error: 'invalid_grant' } },
    ];

    await expect(api.myVendor(SESSION.accessToken)).rejects.toMatchObject({
      code: 'SESSION_EXPIREE',
      status: 401,
      message: 'Session expirée. Reconnectez-vous.',
    });
  });

  it('offline stays offline, and does not send anyone to re-enter a PIN', async () => {
    // The distinction that matters at a counter with two bars of signal. A
    // network drop is not an expired session, and telling someone to sign in
    // again would fail too — while losing the session they still have.
    const api = await chargerApi();
    api.brancherSession(SESSION, () => {});

    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      appels.push({ url: String(url), auth: headers.get('Authorization'), body: null });
      if (String(url).includes('grant_type=refresh_token')) throw new TypeError('Failed to fetch');
      return new Response(JSON.stringify({ message: 'JWT expired' }), { status: 401 });
    });

    await expect(api.myVendor(SESSION.accessToken)).rejects.toMatchObject({
      code: 'OFFLINE',
    });
  });

  it('a 401 with no session registered is a plain failure, not a renewal', async () => {
    // Renewal is only ever attempted for the token this session is holding.
    // Anything else and a genuinely unauthorised call would retry forever.
    const api = await chargerApi();
    api.brancherSession(null, () => {});

    reponses = [{ status: 401, body: { code: 'BAD_PIN', message: 'Code incorrect' } }];
    await expect(api.myVendor('un-jeton-etranger')).rejects.toMatchObject({
      code: 'BAD_PIN',
    });
    expect(appels).toHaveLength(1);
  });
});

describe('the refresh token is not dead weight', () => {
  const src = readFileSync(path.join(process.cwd(), 'src', 'lib', 'api.ts'), 'utf8')
    .replace(/\r\n/g, '\n');
  const app = readFileSync(path.join(process.cwd(), 'src', 'App.tsx'), 'utf8')
    .replace(/\r\n/g, '\n');

  it('it is spent, not merely stored', () => {
    // What made this a bug rather than a missing feature: the value was
    // captured, persisted and typed, so every reading of the code suggested
    // renewal happened somewhere.
    expect(src).toMatch(/grant_type=refresh_token/);
    const usages = (src.match(/refreshToken/g) ?? []).length;
    expect(usages, 'refreshToken is stored but never read').toBeGreaterThan(2);
  });

  it('App hands the live session to the API layer on every change', () => {
    expect(app).toMatch(/brancherSession\(/);
    const effet = /useEffect\(\(\) => \{[\s\S]*?brancherSession[\s\S]*?\}, \[session\]\);/.exec(app);
    expect(effet, 'brancherSession is not in a session-keyed effect').not.toBeNull();
    // The renewed session must be persisted, or the next reload loses it again.
    expect(effet![0]).toMatch(/enregistrerSession/);
  });
});
