// Where automated tests are allowed to write, and what they must be called.
//
// The problem this solves: the UI harness registers accounts and records ledger
// entries through the real API. Pointed at production, it left 91 test accounts
// in the vendor list, indistinguishable at a glance from real shops. That will
// keep happening, and eventually one of them will be mistaken for a real vendor.
//
// So the target is now explicit and production is refused by default.

import { readFileSync, existsSync } from 'node:fs';

/**
 * The production project. Hard-coded on purpose.
 *
 * A guard that reads the thing it is guarding from the same file the test reads
 * guards nothing. This ref is the one place that says "this database has real
 * vendors in it".
 */
export const REF_PRODUCTION = 'bltiifxlfmlfdoqnsdrz';

/**
 * Reserved prefix for every account an automated test creates.
 *
 * Decisive and filterable: no real shop is called "TEST-something". The earlier
 * cleanup tried to identify test rows by phone-number pattern and silently
 * missed four accounts from an older run, including a vendor named
 * "Chez Awa (test)". A prefix that the harness ALWAYS applies cannot drift.
 */
export const PREFIXE_TEST = 'TEST-';

/**
 * Reserved phone block for test accounts: 01 55 55 x xxx.
 *
 * 01 is a real Ivorian mobile prefix, so the numbers stay valid — normalisation
 * and validation are part of what the tests exercise. But the 0155 55 block is
 * documented as reserved, so a number in it is never a real customer.
 */
export const BLOC_TEST = '015555';

/** A phone in the reserved block, from a 4-digit tail. */
export function telephoneTest(suffixe) {
  const t = String(suffixe).replace(/\D/g, '').padStart(4, '0').slice(-4);
  return `${BLOC_TEST}${t}`;
}

/** Read VITE_ values out of an env file. */
function lireEnv(chemin) {
  if (!existsSync(chemin)) return null;
  return Object.fromEntries(
    readFileSync(chemin, 'utf8')
      .split('\n')
      .filter((l) => /^[A-Z]/.test(l))
      .map((l) => {
        const i = l.indexOf('=');
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
      })
  );
}

/**
 * Decide which project an automated run may write to.
 *
 * Order:
 *   1. .env.test.local — the dedicated test project. Used whenever present.
 *   2. .env.local — production. REFUSED unless SIKA_ALLOW_PROD_TEST=1.
 *
 * The refusal is the point. Forgetting to set up a test project should stop the
 * run, not quietly fill the real vendor list.
 */
export function cible() {
  const test = lireEnv('.env.test.local');
  if (test?.VITE_SUPABASE_URL && test?.VITE_SUPABASE_PUBLISHABLE_KEY) {
    return {
      url: test.VITE_SUPABASE_URL,
      apikey: test.VITE_SUPABASE_PUBLISHABLE_KEY,
      production: false,
      source: '.env.test.local',
    };
  }

  const prod = lireEnv('.env.local');
  if (!prod?.VITE_SUPABASE_URL) {
    throw new Error('No .env.test.local and no .env.local — nothing to point at.');
  }

  const estProd = prod.VITE_SUPABASE_URL.includes(REF_PRODUCTION);

  if (estProd && process.env.SIKA_ALLOW_PROD_TEST !== '1') {
    throw new Error(
      [
        '',
        'REFUSING to run automated tests against PRODUCTION.',
        '',
        `  target : ${prod.VITE_SUPABASE_URL}`,
        '  reason : this project holds real vendor and customer accounts.',
        '',
        'Do one of these:',
        '',
        '  1. Create .env.test.local pointing at the test project:',
        '       VITE_SUPABASE_URL=https://<test-ref>.supabase.co',
        '       VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...',
        '',
        '  2. Or, deliberately, for one run only:',
        '       SIKA_ALLOW_PROD_TEST=1 node scripts/ui-e2e.mjs',
        `     Accounts will be named "${PREFIXE_TEST}..." on numbers in the`,
        `     reserved ${BLOC_TEST}xxxx block, so they can be filtered out.`,
        '',
      ].join('\n')
    );
  }

  return {
    url: prod.VITE_SUPABASE_URL,
    apikey: prod.VITE_SUPABASE_PUBLISHABLE_KEY,
    production: estProd,
    source: estProd ? '.env.local (PRODUCTION — allowed explicitly)' : '.env.local',
  };
}
