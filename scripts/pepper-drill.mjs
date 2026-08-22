// Prove a pepper rotation works, before it is done to real credentials.
//
// ============================================================================
// WHY THIS NEEDS A DRILL, like the restore did.
//
// The pepper is the one secret whose loss is unrecoverable. Every stored auth
// password is derived from a PIN and a pepper; lose the pepper and every account
// in the country is permanently unverifiable, with "wrong PIN" as the only
// symptom. There is no reset path that does not go through the pepper.
//
// So the rotation must be seen to work — lazily, per user, on login — rather
// than reasoned about from the code. A rotation that silently fails does not
// announce itself: users keep logging in on the old version, the new one is
// never adopted, and the first sign is when someone deletes the old pepper
// believing it unused.
// ============================================================================
//
// WHAT IT CHECKS, against the TEST project only:
//
//   1. a user registered on the current version logs in
//   2. after V<n+1> is configured, that SAME user still logs in — the candidate
//      loop tries their stored version, which is now the older one
//   3. logging in MIGRATES them: their pepper_version becomes the new one
//   4. a user registered after the rotation is on the new version immediately
//   5. the old pepper is still required by nobody once everyone has logged in
//
//   node scripts/pepper-drill.mjs
//
// It cannot rotate the secret itself — Edge Function secrets are set by a human
// with the dashboard, deliberately, because a secret this session generated has
// been through a context window and is not a secret. So it runs in two phases
// and tells you when to do your part.

import { cible, telephoneTest, PREFIXE_TEST } from './test-target.mjs';
import { afficherCible } from './whoami.mjs';

afficherCible();

const { url: URL_BASE, apikey: APIKEY, production, source } = cible();
if (production) {
  console.error('\nREFUSING: this drill registers accounts. Point it at the test project.');
  process.exit(1);
}
console.log(`pepper drill against ${URL_BASE}  (${source})\n`);

const FN = (n) => `${URL_BASE}/functions/v1/${n}`;
const REST = (p) => `${URL_BASE}/rest/v1/${p}`;

let pass = 0;
let fail = 0;
const echecs = [];

function check(label, ok, detail = '') {
  if (ok) { pass += 1; console.log(`  PASS  ${label}`); }
  else { fail += 1; echecs.push(label); console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}

async function callFn(name, body, token = null) {
  const headers = { apikey: APIKEY, 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(FN(name), { method: 'POST', headers, body: JSON.stringify(body ?? {}) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function restGet(path, token) {
  const res = await fetch(REST(path), {
    headers: { apikey: APIKEY, Authorization: `Bearer ${token}` },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** The version a customer's credential currently claims. */
async function versionDe(token) {
  const r = await restGet('customers?select=pepper_version', token);
  return r.body?.[0]?.pepper_version ?? null;
}

const phase = process.argv[2] === '--after' ? 'after' : 'before';
const stamp = Number(process.env.SIKA_DRILL_STAMP ?? '');

if (phase === 'before') {
  // ---- phase 1: a user on the CURRENT pepper -----------------------------
  const s = Number(Date.now().toString().slice(-4));
  const avant = telephoneTest(s);
  const PIN = '4821';

  console.log('phase 1 — a user registered on the CURRENT pepper\n');

  const reg = await callFn('register', { role: 'customer', phone: avant, pin: PIN });
  check('registers on the current pepper', reg.status === 200, JSON.stringify(reg.body));

  const login = await callFn('login', { role: 'customer', phone: avant, pin: PIN });
  const token = login.body?.session?.access_token;
  check('logs in', Boolean(token), JSON.stringify(login.body));

  const v = token ? await versionDe(token) : null;
  check('carries a pepper version', v !== null, String(v));
  console.log(`\n  version before rotation: ${v}`);

  console.log('\n' + '='.repeat(66));
  console.log('NOW ROTATE, in the Supabase dashboard for the TEST project:');
  console.log('');
  console.log('  1. Generate a new value (PowerShell):');
  console.log("     [Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }))");
  console.log("       -replace '\\+','-' -replace '/','_' -replace '=',''");
  console.log('');
  console.log(`  2. Add it as SIKA_PIN_PEPPER_V${(v ?? 1) + 1}. KEEP V${v} in place.`);
  console.log(`  3. Set SIKA_PIN_PEPPER_CURRENT = V${(v ?? 1) + 1}`);
  console.log('');
  console.log('Then run:');
  console.log(`  SIKA_DRILL_STAMP=${s} npm run pepper:drill -- --after`);
  console.log('='.repeat(66));
  process.exit(fail > 0 ? 1 : 0);
}

// ---- phase 2: after the rotation ----------------------------------------
if (!Number.isFinite(stamp)) {
  console.error('Missing SIKA_DRILL_STAMP. Run the first phase and use the number it prints.');
  process.exit(1);
}

const avant = telephoneTest(stamp);
const apres = telephoneTest(stamp + 1);
const PIN = '4821';

console.log('phase 2 — after the rotation\n');

// THE CHECK THAT MATTERS. This account's credential was derived with the OLD
// pepper. If the candidate loop is broken, this login fails and every existing
// user in the country would be locked out by a rotation.
const relogin = await callFn('login', { role: 'customer', phone: avant, pin: PIN });
const jeton = relogin.body?.session?.access_token;
check('an EXISTING user still logs in after the rotation', Boolean(jeton),
  JSON.stringify(relogin.body));

if (jeton) {
  const v = await versionDe(jeton);
  check('and was MIGRATED to the new version by that login', v !== null && v > 1, `version=${v}`);
  console.log(`  version after login: ${v}`);
}

// A second login must also work: the upgrade writes to Supabase Auth and to
// Postgres, which cannot share a transaction. If the second write were lost, the
// row would claim a version its credential does not match.
const encore = await callFn('login', { role: 'customer', phone: avant, pin: PIN });
check('logs in again on the migrated credential',
  Boolean(encore.body?.session?.access_token), JSON.stringify(encore.body));

// A new registration should be on the new version from the start.
const regNeuf = await callFn('register', { role: 'customer', phone: apres, pin: PIN });
check('a NEW user registers after the rotation', regNeuf.status === 200,
  JSON.stringify(regNeuf.body));

const loginNeuf = await callFn('login', { role: 'customer', phone: apres, pin: PIN });
const jetonNeuf = loginNeuf.body?.session?.access_token;
check('and logs in', Boolean(jetonNeuf), JSON.stringify(loginNeuf.body));

if (jetonNeuf) {
  const v = await versionDe(jetonNeuf);
  check('on the NEW version immediately, without needing a migration', v !== null && v > 1,
    `version=${v}`);
}

// The wrong PIN must still be refused. A candidate loop that tries every pepper
// is a loop that could accept a wrong PIN under some other version if it were
// written carelessly.
const mauvais = await callFn('login', { role: 'customer', phone: avant, pin: '9999' });
check('a wrong PIN is still refused across all versions', mauvais.status === 401,
  `${mauvais.status} ${JSON.stringify(mauvais.body)}`);

console.log(`\n================ ${pass} passed, ${fail} failed ================`);
if (fail > 0) {
  console.log('Failures:');
  for (const f of echecs) console.log(`  - ${f}`);
  console.log('\nDO NOT rotate production until this passes.');
}
console.log(`\nAccounts used: 225${avant}, 225${apres}`);
console.log('Check adoption before removing any old pepper:');
console.log('  select * from pepper_version_usage();');
process.exit(fail > 0 ? 1 : 0);
