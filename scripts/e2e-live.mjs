// End-to-end exercise of the five deployed Edge Functions against the REAL
// project. Not a unit test — it makes real calls and writes real rows.
//
// Run: node scripts/e2e-live.mjs
//
// Reads the project URL and publishable key from .env.local. Requires nothing
// secret: the publishable key is public by design, and every privileged step
// happens inside the functions using secrets only they hold.

import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => /^[A-Z]/.test(l))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);

const URL_BASE = env.VITE_SUPABASE_URL;
const APIKEY = env.VITE_SUPABASE_PUBLISHABLE_KEY;
if (!URL_BASE || !APIKEY) throw new Error('Missing VITE_SUPABASE_URL or key in .env.local');

const FN = (name) => `${URL_BASE}/functions/v1/${name}`;
const REST = (path) => `${URL_BASE}/rest/v1/${path}`;

// Distinctive synthetic numbers so the rows are obvious in the dashboard.
const stamp = Date.now().toString().slice(-6);
const VENDOR_PHONE = `07${stamp}00`.slice(0, 10);
const CUSTOMER_PHONE = `05${stamp}00`.slice(0, 10);
const OTHER_PHONE = `25${stamp}00`.slice(0, 10);
const VENDOR_PIN = '481627';
const CUSTOMER_PIN = '4821';
const OTHER_PIN = '9137';

let pass = 0;
let fail = 0;
const failures = [];

function check(label, condition, detail = '') {
  if (condition) {
    pass += 1;
    console.log(`  PASS  ${label}`);
  } else {
    fail += 1;
    failures.push(label);
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function callFn(name, body, token = null) {
  const headers = { apikey: APIKEY, 'Content-Type': 'application/json' };
  // The key goes on apikey ONLY. A key on Authorization is parsed as a JWT
  // and rejected (amendment K).
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(FN(name), {
    method: 'POST',
    headers,
    body: JSON.stringify(body ?? {}),
  });

  let json = null;
  try { json = await res.json(); } catch { /* non-JSON body */ }
  return { status: res.status, body: json };
}

async function rpc(name, args, token) {
  const res = await fetch(REST(`rpc/${name}`), {
    method: 'POST',
    headers: {
      apikey: APIKEY,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  let json = null;
  try { json = await res.json(); } catch { /* ignore */ }
  return { status: res.status, body: json };
}

async function restGet(path, token) {
  const res = await fetch(REST(path), {
    headers: { apikey: APIKEY, Authorization: `Bearer ${token}` },
  });
  let json = null;
  try { json = await res.json(); } catch { /* ignore */ }
  return { status: res.status, body: json };
}

function section(title) {
  console.log(`\n--- ${title} ---`);
}

// ---------------------------------------------------------------------------

console.log(`Project: ${URL_BASE}`);
console.log(`Test numbers: vendor 225${VENDOR_PHONE}, customer 225${CUSTOMER_PHONE}, other 225${OTHER_PHONE}\n`);

// ===== 1. register =========================================================
section('register');

const regVendor = await callFn('register', {
  role: 'vendor',
  phone: VENDOR_PHONE,
  pin: VENDOR_PIN,
  businessName: 'Chez Awa (test)',
  quartier: 'Yopougon',
  commune: 'Abidjan',
  termsAccepted: true,
});
check('vendor registers', regVendor.status === 200 && regVendor.body?.ok === true,
  JSON.stringify(regVendor.body));

const regCustomer = await callFn('register', {
  role: 'customer', phone: CUSTOMER_PHONE, pin: CUSTOMER_PIN,
});
check('customer registers', regCustomer.status === 200 && regCustomer.body?.ok === true,
  JSON.stringify(regCustomer.body));

const regOther = await callFn('register', {
  role: 'customer', phone: OTHER_PHONE, pin: OTHER_PIN,
});
check('second customer registers', regOther.status === 200 && regOther.body?.ok === true,
  JSON.stringify(regOther.body));

const regDupe = await callFn('register', {
  role: 'customer', phone: CUSTOMER_PHONE, pin: CUSTOMER_PIN,
});
check('duplicate registration refused (409)', regDupe.status === 409,
  `got ${regDupe.status} ${JSON.stringify(regDupe.body)}`);

const regNoTerms = await callFn('register', {
  role: 'vendor', phone: '0788888888', pin: '482716',
  businessName: 'X', quartier: 'Y', termsAccepted: false,
});
check('vendor without terms acknowledgement refused',
  regNoTerms.body?.code === 'TERMS_REQUIRED',
  JSON.stringify(regNoTerms.body));

const regWeakPin = await callFn('register', {
  role: 'customer', phone: '0577777777', pin: '1234',
});
check('sequential PIN refused', regWeakPin.body?.code === 'PIN_SEQUENTIAL',
  JSON.stringify(regWeakPin.body));

const regBadPhone = await callFn('register', {
  role: 'customer', phone: '0901020304', pin: '4821',
});
check('non-mobile prefix refused', regBadPhone.body?.code === 'PHONE_NOT_MOBILE',
  JSON.stringify(regBadPhone.body));

// ===== 2. login ============================================================
section('login');

const loginVendor = await callFn('login', {
  role: 'vendor', phone: VENDOR_PHONE, pin: VENDOR_PIN,
});
check('vendor logs in', loginVendor.status === 200 && Boolean(loginVendor.body?.session?.access_token),
  JSON.stringify(loginVendor.body));
const vendorToken = loginVendor.body?.session?.access_token;

const loginCustomer = await callFn('login', {
  role: 'customer', phone: CUSTOMER_PHONE, pin: CUSTOMER_PIN,
});
check('customer logs in', loginCustomer.status === 200 && Boolean(loginCustomer.body?.session?.access_token),
  JSON.stringify(loginCustomer.body));
const customerToken = loginCustomer.body?.session?.access_token;

const loginOther = await callFn('login', {
  role: 'customer', phone: OTHER_PHONE, pin: OTHER_PIN,
});
const otherToken = loginOther.body?.session?.access_token;
check('second customer logs in', Boolean(otherToken), JSON.stringify(loginOther.body));

const loginWrongPin = await callFn('login', {
  role: 'customer', phone: CUSTOMER_PHONE, pin: '9999',
});
check('wrong PIN refused (401)', loginWrongPin.status === 401,
  `got ${loginWrongPin.status} ${JSON.stringify(loginWrongPin.body)}`);

const loginUnknown = await callFn('login', {
  role: 'customer', phone: '0511111111', pin: '4821',
});
check('unknown number gives the SAME message as a wrong PIN (no oracle)',
  loginUnknown.body?.code === 'BAD_CREDENTIALS' || loginUnknown.body?.message === 'Numéro ou code incorrect',
  JSON.stringify(loginUnknown.body));

// ===== 3. vendor records a credit (post_ledger_entry via PostgREST) ========
section('credit — garder la monnaie');

const vendorRow = await restGet('vendors?select=id,auth_user_id,business_name', vendorToken);
check('vendor reads own record through RLS',
  vendorRow.status === 200 && Array.isArray(vendorRow.body) && vendorRow.body.length === 1,
  JSON.stringify(vendorRow.body));

const vendorId = vendorRow.body?.[0]?.id;
const vendorAuthId = vendorRow.body?.[0]?.auth_user_id;

const custRow = await restGet('customers?select=id,auth_user_id', customerToken);
const customerId = custRow.body?.[0]?.id;
check('customer reads own record through RLS', Boolean(customerId),
  JSON.stringify(custRow.body));

const credit = await rpc('post_ledger_entry', {
  p_vendor_id: vendorId,
  p_customer_id: customerId,
  p_direction: 'credit',
  p_kind: 'change',
  p_amount_cfa: 1000,
  p_idempotency_key: `e2e-credit-${stamp}`,
  p_actor_user_id: vendorAuthId,
  p_customer_confirmed: false,
  p_reverses_entry_id: null,
  p_note: null,
  p_confirmation_method: null,
}, vendorToken);
check('vendor records a 1000 F credit', credit.status === 200 && credit.body?.amount_cfa === 1000,
  `${credit.status} ${JSON.stringify(credit.body)}`);

const creditReplay = await rpc('post_ledger_entry', {
  p_vendor_id: vendorId, p_customer_id: customerId, p_direction: 'credit',
  p_kind: 'change', p_amount_cfa: 1000, p_idempotency_key: `e2e-credit-${stamp}`,
  p_actor_user_id: vendorAuthId, p_customer_confirmed: false,
  p_reverses_entry_id: null, p_note: null, p_confirmation_method: null,
}, vendorToken);
check('replaying the same key returns the SAME entry',
  creditReplay.body?.id === credit.body?.id,
  JSON.stringify(creditReplay.body));

// ===== 4. cross-vendor isolation, live ====================================
section('isolation — the legal position');

const otherVendorPeek = await restGet('ledger_entries?select=id,vendor_id', otherToken);
check('an unrelated customer sees NO ledger entries',
  Array.isArray(otherVendorPeek.body) && otherVendorPeek.body.length === 0,
  JSON.stringify(otherVendorPeek.body));

const customerSees = await restGet('v_balances?select=vendor_id,balance_cfa', customerToken);
check('the customer sees their own balance of 1000',
  Array.isArray(customerSees.body) && customerSees.body[0]?.balance_cfa === 1000,
  JSON.stringify(customerSees.body));

// ===== 5. the two-device handshake ========================================
section('debit handshake — amendment H');

const noToken = await callFn('initiate-debit', {
  customerPhone: CUSTOMER_PHONE, amountCfa: 400, kind: 'purchase',
});
check('initiate-debit with NO token rejected (401)', noToken.status === 401,
  `got ${noToken.status} ${JSON.stringify(noToken.body)}`);

const malformed = await callFn('initiate-debit',
  { customerPhone: CUSTOMER_PHONE, amountCfa: 400 }, 'not-a-jwt');
check('initiate-debit with malformed token rejected', malformed.status === 401,
  `got ${malformed.status} ${JSON.stringify(malformed.body)}`);

const keyOnAuth = await callFn('initiate-debit',
  { customerPhone: CUSTOMER_PHONE, amountCfa: 400 }, APIKEY);
check('publishable key on Authorization rejected and NAMED',
  keyOnAuth.body?.code === 'KEY_ON_AUTH_HEADER',
  JSON.stringify(keyOnAuth.body));

const tampered = vendorToken
  ? vendorToken.slice(0, -3) + (vendorToken.slice(-3) === 'AAA' ? 'BBB' : 'AAA')
  : 'x.y.z';
const tamperedRes = await callFn('initiate-debit',
  { customerPhone: CUSTOMER_PHONE, amountCfa: 400 }, tampered);
check('token with tampered signature rejected (401)', tamperedRes.status === 401,
  `got ${tamperedRes.status} ${JSON.stringify(tamperedRes.body)}`);

const wrongRole = await callFn('initiate-debit',
  { customerPhone: CUSTOMER_PHONE, amountCfa: 400 }, customerToken);
check("a CUSTOMER's valid token cannot initiate a debit (403)",
  wrongRole.status === 403 && wrongRole.body?.code === 'NOT_A_VENDOR',
  `got ${wrongRole.status} ${JSON.stringify(wrongRole.body)}`);

const initiated = await callFn('initiate-debit', {
  customerPhone: CUSTOMER_PHONE, amountCfa: 400, kind: 'purchase',
  idempotencyKey: `e2e-debit-${stamp}`,
}, vendorToken);
check('vendor initiates a 400 F debit',
  initiated.status === 200 && Boolean(initiated.body?.pendingId),
  JSON.stringify(initiated.body));
const pendingId = initiated.body?.pendingId;

const pendingForCustomer = await rpc('pending_debits_for_customer',
  { p_actor_user_id: custRow.body?.[0]?.auth_user_id }, customerToken);
check('the customer sees the request with shop name and resulting balance',
  Array.isArray(pendingForCustomer.body) &&
  pendingForCustomer.body[0]?.business_name === 'Chez Awa (test)' &&
  pendingForCustomer.body[0]?.resulting_balance === 600,
  JSON.stringify(pendingForCustomer.body));

const vendorCannotConfirm = await callFn('confirm-debit',
  { pendingId, pin: CUSTOMER_PIN }, vendorToken);
check("the VENDOR cannot confirm, even holding the customer's PIN (403)",
  vendorCannotConfirm.status === 403 && vendorCannotConfirm.body?.code === 'NOT_A_CUSTOMER',
  `got ${vendorCannotConfirm.status} ${JSON.stringify(vendorCannotConfirm.body)}`);

const strangerConfirm = await callFn('confirm-debit',
  { pendingId, pin: OTHER_PIN }, otherToken);
check("ANOTHER customer's valid token cannot confirm this request",
  strangerConfirm.body?.ok !== true,
  JSON.stringify(strangerConfirm.body));

const wrongPinConfirm = await callFn('confirm-debit',
  { pendingId, pin: '9137' }, customerToken);
check('confirmation with the wrong PIN refused (401)',
  wrongPinConfirm.status === 401 && wrongPinConfirm.body?.code === 'BAD_PIN',
  JSON.stringify(wrongPinConfirm.body));

const confirmed = await callFn('confirm-debit',
  { pendingId, pin: CUSTOMER_PIN }, customerToken);
check('the CUSTOMER confirms on their own device',
  confirmed.status === 200 && confirmed.body?.ok === true &&
  confirmed.body?.confirmationMethod === 'own_device',
  JSON.stringify(confirmed.body));
check('remaining balance is 600', confirmed.body?.remainingCfa === 600,
  JSON.stringify(confirmed.body));

const confirmAgain = await callFn('confirm-debit',
  { pendingId, pin: CUSTOMER_PIN }, customerToken);
check('confirming twice returns the same entry, not a second debit',
  confirmAgain.body?.entryId === confirmed.body?.entryId,
  JSON.stringify(confirmAgain.body));

// ===== 6. change-pin ======================================================
section('change-pin');

const cpNoToken = await callFn('change-pin', {
  role: 'customer', currentPin: CUSTOMER_PIN, newPin: '5062',
});
check('change-pin with no token rejected (401)', cpNoToken.status === 401,
  `got ${cpNoToken.status}`);

const cpWrongCurrent = await callFn('change-pin', {
  role: 'customer', currentPin: '9999', newPin: '5062',
}, customerToken);
check('change-pin with wrong current PIN refused (401)',
  cpWrongCurrent.status === 401 && cpWrongCurrent.body?.code === 'BAD_CURRENT_PIN',
  JSON.stringify(cpWrongCurrent.body));

const cpWeak = await callFn('change-pin', {
  role: 'customer', currentPin: CUSTOMER_PIN, newPin: '1111',
}, customerToken);
check('change-pin to a repeated PIN refused',
  cpWeak.body?.code === 'PIN_REPEATED', JSON.stringify(cpWeak.body));

const cpOk = await callFn('change-pin', {
  role: 'customer', currentPin: CUSTOMER_PIN, newPin: '5062',
}, customerToken);
check('customer changes their PIN', cpOk.status === 200 && cpOk.body?.ok === true,
  JSON.stringify(cpOk.body));

const loginNewPin = await callFn('login', {
  role: 'customer', phone: CUSTOMER_PHONE, pin: '5062',
});
check('login works with the NEW PIN', Boolean(loginNewPin.body?.session?.access_token),
  JSON.stringify(loginNewPin.body));

const loginOldPin = await callFn('login', {
  role: 'customer', phone: CUSTOMER_PHONE, pin: CUSTOMER_PIN,
});
check('the OLD PIN no longer works', loginOldPin.status === 401,
  `got ${loginOldPin.status}`);

// ===== 7. lockout, live  (acceptance test 9) ==============================
section('lockout — acceptance test 9');

// Fresh number so the counter starts clean and no earlier failure interferes.
const lockPhone = `07${stamp}99`.slice(0, 10);
await callFn('register', { role: 'customer', phone: lockPhone, pin: '2846' });

let warnSeen = null;
let lockedAt = null;
for (let i = 1; i <= 6; i += 1) {
  const r = await callFn('login', { role: 'customer', phone: lockPhone, pin: '9999' });
  if (r.body?.warning && warnSeen === null) warnSeen = i;
  if (r.body?.code === 'ACCOUNT_LOCKED' && lockedAt === null) lockedAt = i;
}
check('the 4th wrong attempt warns', warnSeen === 4, `warning first appeared at attempt ${warnSeen}`);
check('the 5th wrong attempt locks', lockedAt === 5, `locked first reported at attempt ${lockedAt}`);

const lockedCorrectPin = await callFn('login', {
  role: 'customer', phone: lockPhone, pin: '2846',
});
check('even the CORRECT PIN is refused while locked',
  lockedCorrectPin.body?.code === 'ACCOUNT_LOCKED',
  JSON.stringify(lockedCorrectPin.body));

// ===== 8. amendment B on the real project ================================
section('amendment B — identity wrapper on the live project');

const backend = await rpc('app_identity_backend', {}, vendorToken);
check('the live project uses the auth branch, not the GUC fallback',
  backend.body === 'auth', JSON.stringify(backend.body));

// ---------------------------------------------------------------------------
console.log(`\n================ ${pass} passed, ${fail} failed ================`);
if (fail > 0) {
  console.log('Failures:');
  for (const f of failures) console.log(`  - ${f}`);
}
console.log(`\nRows created on the live project under numbers 225${VENDOR_PHONE}, 225${CUSTOMER_PHONE}, 225${OTHER_PHONE}, 225${lockPhone}`);
process.exit(fail > 0 ? 1 : 0);
