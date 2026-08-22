// End-to-end exercise of the debt register against a REAL project.
//
// Proves the fraud model holds over HTTP, not just in SQL: the tests in
// tests/28 and tests/29 run against a database directly, which means they never
// exercise the Edge Function, the PIN verification, or the service-role boundary
// that is the actual thing standing between a vendor and a forged confirmation.
//
// WHERE IT WRITES is decided by cible(), which prefers .env.test.local and
// refuses production unless SIKA_ALLOW_PROD_TEST=1.
//
//   node scripts/e2e-debt.mjs

import { cible, telephoneTest, PREFIXE_TEST } from './test-target.mjs';
import { afficherCible } from './whoami.mjs';

afficherCible();

const { url: URL_BASE, apikey: APIKEY, production, source } = cible();
console.log(`e2e:debt writing to ${URL_BASE}  (${source})\n`);
if (production) {
  console.log('*** PRODUCTION — allowed only because SIKA_ALLOW_PROD_TEST=1 ***\n');
}

const FN = (n) => `${URL_BASE}/functions/v1/${n}`;
const REST = (p) => `${URL_BASE}/rest/v1/${p}`;

const stamp = Number(Date.now().toString().slice(-4));
const VENDEUR = telephoneTest(stamp);
const CLIENT = telephoneTest(stamp + 1);
const AUTRE = telephoneTest(stamp + 2);
const NOM_BOUTIQUE = `${PREFIXE_TEST}Dette`;
const PIN_VENDEUR = '481627';
const PIN_CLIENT = '4821';
const PIN_AUTRE = '9137';

let pass = 0;
let fail = 0;
const failures = [];

function check(label, ok, detail = '') {
  if (ok) { pass += 1; console.log(`  PASS  ${label}`); }
  else { fail += 1; failures.push(label); console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}

function section(t) { console.log(`\n--- ${t} ---`); }

async function callFn(name, body, token = null) {
  const headers = { apikey: APIKEY, 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(FN(name), { method: 'POST', headers, body: JSON.stringify(body ?? {}) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function rpc(name, args, token) {
  const res = await fetch(REST(`rpc/${name}`), {
    method: 'POST',
    headers: { apikey: APIKEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function restGet(path, token) {
  const res = await fetch(REST(path), {
    headers: { apikey: APIKEY, Authorization: `Bearer ${token}` },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const cle = () => `dette-${Math.random().toString(36).slice(2)}`;

// ===== setup ===============================================================
section('setup');

await callFn('register', {
  role: 'vendor', phone: VENDEUR, pin: PIN_VENDEUR, businessName: NOM_BOUTIQUE,
  quartier: 'Yopougon', commune: 'Abidjan', termsAccepted: true,
});
await callFn('register', { role: 'customer', phone: CLIENT, pin: PIN_CLIENT });
await callFn('register', { role: 'customer', phone: AUTRE, pin: PIN_AUTRE });

const lv = await callFn('login', { role: 'vendor', phone: VENDEUR, pin: PIN_VENDEUR });
const jetonV = lv.body?.session?.access_token;
const lc = await callFn('login', { role: 'customer', phone: CLIENT, pin: PIN_CLIENT });
const jetonC = lc.body?.session?.access_token;
const la = await callFn('login', { role: 'customer', phone: AUTRE, pin: PIN_AUTRE });
const jetonA = la.body?.session?.access_token;
check('all three sessions', Boolean(jetonV && jetonC && jetonA));

const v = (await restGet('vendors?select=id,auth_user_id', jetonV)).body?.[0];
const c = (await restGet('customers?select=id,auth_user_id', jetonC)).body?.[0];
const a = (await restGet('customers?select=id,auth_user_id', jetonA)).body?.[0];
check('profiles readable', Boolean(v?.id && c?.id && a?.id));

// ===== the fraud model over HTTP ==========================================
section('a vendor cannot forge a confirmation');

const forge = await rpc('post_debt_entry', {
  p_vendor_id: v.id, p_customer_id: c.id, p_direction: 'owed', p_kind: 'debt',
  p_amount_cfa: 5000, p_idempotency_key: cle(), p_actor_user_id: v.auth_user_id,
  p_confirmation_method: 'own_device', p_reverses_entry_id: null, p_note: null,
}, jetonV);
check('vendor posting own_device is refused', forge.status >= 400,
  `${forge.status} ${JSON.stringify(forge.body)}`);

const vd = await rpc('post_debt_entry', {
  p_vendor_id: v.id, p_customer_id: c.id, p_direction: 'owed', p_kind: 'debt',
  p_amount_cfa: 5000, p_idempotency_key: cle(), p_actor_user_id: v.auth_user_id,
  p_confirmation_method: 'vendor_device', p_reverses_entry_id: null, p_note: null,
}, jetonV);
check('vendor_device is refused', vd.status >= 400,
  `${vd.status} ${JSON.stringify(vd.body)}`);

// ===== déclarée ============================================================
section('déclarée — a claim, not a record');

const decl = await rpc('declare_debt', {
  p_vendor_id: v.id, p_customer_id: c.id, p_amount_cfa: 1500,
  p_idempotency_key: cle(), p_actor_user_id: v.auth_user_id, p_note: 'Sac de riz',
}, jetonV);
const entreeDecl = Array.isArray(decl.body) ? decl.body[0] : decl.body;
check('a declared debt is recorded', decl.status === 200 && entreeDecl?.confirmation_method === 'declared',
  `${decl.status} ${JSON.stringify(decl.body)}`);

const histC = await rpc('customer_debt_history',
  { p_actor_user_id: c.auth_user_id, p_vendor_id: v.id }, jetonC);
check('the customer sees it as déclarée', histC.body?.[0]?.state === 'declared',
  JSON.stringify(histC.body?.[0]));
check('and can answer it', histC.body?.[0]?.reviewable === true);

// ===== the handshake =======================================================
section('the two-device handshake');

const prop = await rpc('create_pending_debt', {
  p_vendor_id: v.id, p_customer_id: c.id, p_amount_cfa: 2000,
  p_idempotency_key: cle(), p_actor_user_id: v.auth_user_id, p_note: 'Crédit boutique',
}, jetonV);
const enAttente = Array.isArray(prop.body) ? prop.body[0] : prop.body;
check('vendor proposes a debt', prop.status === 200 && Boolean(enAttente?.id),
  `${prop.status} ${JSON.stringify(prop.body)}`);

const vue = await rpc('pending_debts_for_customer', { p_actor_user_id: c.auth_user_id }, jetonC);
check('the customer sees the proposal with the shop named',
  vue.body?.[0]?.business_name === NOM_BOUTIQUE, JSON.stringify(vue.body?.[0]));
check('and what they would owe in total afterwards',
  vue.body?.[0]?.resulting_debt === 3500, JSON.stringify(vue.body?.[0]));

const parVendeur = await callFn('confirm-debt',
  { action: 'debt', pendingId: enAttente.id, pin: PIN_CLIENT }, jetonV);
check('the VENDOR cannot confirm even holding the PIN', parVendeur.status >= 400,
  `${parVendeur.status} ${JSON.stringify(parVendeur.body)}`);

const parAutre = await callFn('confirm-debt',
  { action: 'debt', pendingId: enAttente.id, pin: PIN_AUTRE }, jetonA);
check('another customer cannot confirm it', parAutre.status >= 400,
  `${parAutre.status} ${JSON.stringify(parAutre.body)}`);

const mauvaisPin = await callFn('confirm-debt',
  { action: 'debt', pendingId: enAttente.id, pin: '0000' }, jetonC);
check('the wrong PIN is refused', mauvaisPin.status === 401,
  `${mauvaisPin.status} ${JSON.stringify(mauvaisPin.body)}`);

const bon = await callFn('confirm-debt',
  { action: 'debt', pendingId: enAttente.id, pin: PIN_CLIENT }, jetonC);
check('the CUSTOMER confirms on their own device',
  bon.status === 200 && bon.body?.confirmationMethod === 'own_device',
  `${bon.status} ${JSON.stringify(bon.body)}`);

const encore = await callFn('confirm-debt',
  { action: 'debt', pendingId: enAttente.id, pin: PIN_CLIENT }, jetonC);
check('confirming twice returns the same entry', encore.body?.entryId === bon.body?.entryId);

const dettes = await rpc('vendor_debtors',
  { p_vendor_id: v.id, p_actor_user_id: v.auth_user_id }, jetonV);
check('the vendor is owed 3 500 in total', dettes.body?.[0]?.debt_cfa === 3500,
  JSON.stringify(dettes.body?.[0]));
check('split as 2 000 confirmed and 1 500 declared',
  dettes.body?.[0]?.confirmed_cfa === 2000 && dettes.body?.[0]?.declared_cfa === 1500,
  JSON.stringify(dettes.body?.[0]));

// ===== dispute =============================================================
section('a dispute flags, it does not delete');

const conteste = await rpc('review_debt_entry', {
  p_entry_id: entreeDecl.id, p_decision: 'disputed',
  p_actor_user_id: c.auth_user_id, p_reason: "Je n'ai pas pris ce sac",
}, jetonC);
check('the customer disputes the declared entry', conteste.status === 200,
  `${conteste.status} ${JSON.stringify(conteste.body)}`);

const apresConteste = await rpc('vendor_debtors',
  { p_vendor_id: v.id, p_actor_user_id: v.auth_user_id }, jetonV);
check('the figure still stands', apresConteste.body?.[0]?.debt_cfa === 3500);
check('but 1 500 is now marked contested',
  apresConteste.body?.[0]?.disputed_cfa === 1500, JSON.stringify(apresConteste.body?.[0]));

const revu = await rpc('review_debt_entry', {
  p_entry_id: entreeDecl.id, p_decision: 'accepted', p_actor_user_id: c.auth_user_id, p_reason: null,
}, jetonC);
check('it cannot be reviewed a second time', revu.status >= 400,
  `${revu.status} ${JSON.stringify(revu.body)}`);

// ===== never net ===========================================================
section('the two registers never net');

// Give the customer some change at the same shop.
await rpc('post_ledger_entry', {
  p_vendor_id: v.id, p_customer_id: c.id, p_direction: 'credit', p_kind: 'change',
  p_amount_cfa: 900, p_idempotency_key: cle(), p_actor_user_id: v.auth_user_id,
  p_customer_confirmed: false, p_reverses_entry_id: null, p_note: null,
  p_confirmation_method: 'own_device',
}, jetonV);

const pos = await rpc('customer_shop_positions', { p_actor_user_id: c.auth_user_id }, jetonC);
const ligne = pos.body?.[0];
check('change and debt are reported separately',
  ligne?.change_cfa === 900 && ligne?.debt_cfa === 3500, JSON.stringify(ligne));
check('no column is negative',
  Object.values(ligne ?? {}).every((x) => typeof x !== 'number' || x >= 0), JSON.stringify(ligne));
check('the offsettable amount is the smaller of the two',
  ligne?.compensable_cfa === 900, String(ligne?.compensable_cfa));

// ===== compensation ========================================================
section('compenser — the paired write');

const tropGrand = await rpc('create_pending_compensation', {
  p_vendor_id: v.id, p_customer_id: c.id, p_amount_cfa: 1000,
  p_idempotency_key: cle(), p_actor_user_id: v.auth_user_id,
}, jetonV);
check('cannot offset more change than is held', tropGrand.status >= 400,
  `${tropGrand.status} ${JSON.stringify(tropGrand.body)}`);

const propComp = await rpc('create_pending_compensation', {
  p_vendor_id: v.id, p_customer_id: c.id, p_amount_cfa: 900,
  p_idempotency_key: cle(), p_actor_user_id: v.auth_user_id,
}, jetonV);
const compEnAttente = Array.isArray(propComp.body) ? propComp.body[0] : propComp.body;
check('vendor proposes an offset', propComp.status === 200 && Boolean(compEnAttente?.id),
  `${propComp.status} ${JSON.stringify(propComp.body)}`);

const vueComp = await rpc('pending_compensations_for_customer',
  { p_actor_user_id: c.auth_user_id }, jetonC);
check('the customer sees all three figures',
  vueComp.body?.[0]?.current_change === 900
    && vueComp.body?.[0]?.current_debt === 3500
    && vueComp.body?.[0]?.resulting_debt === 2600,
  JSON.stringify(vueComp.body?.[0]));

const compParVendeur = await callFn('confirm-debt',
  { action: 'compensation', pendingId: compEnAttente.id, pin: PIN_CLIENT }, jetonV);
check('the vendor cannot confirm the offset', compParVendeur.status >= 400,
  `${compParVendeur.status} ${JSON.stringify(compParVendeur.body)}`);

const comp = await callFn('confirm-debt',
  { action: 'compensation', pendingId: compEnAttente.id, pin: PIN_CLIENT }, jetonC);
check('the customer confirms it', comp.status === 200, `${comp.status} ${JSON.stringify(comp.body)}`);
check('both legs were written',
  Boolean(comp.body?.ledgerEntryId && comp.body?.debtEntryId), JSON.stringify(comp.body));
check('change is now 0 and debt is 2 600',
  comp.body?.remainingChangeCfa === 0 && comp.body?.remainingDebtCfa === 2600,
  JSON.stringify(comp.body));

// ===== the cap =============================================================
section('the cap and the rate limit');

const surPlafond = await rpc('declare_debt', {
  p_vendor_id: v.id, p_customer_id: c.id, p_amount_cfa: 9000,
  p_idempotency_key: cle(), p_actor_user_id: v.auth_user_id, p_note: null,
}, jetonV);
check('a debt over the 10 000 cap is refused', surPlafond.status >= 400,
  `${surPlafond.status} ${JSON.stringify(surPlafond.body)}`);

// ===== isolation ===========================================================
section('debtor information never crosses vendors');

const autreVu = await restGet('debt_entries?select=id,amount_cfa', jetonA);
check('another customer sees no debt entries',
  Array.isArray(autreVu.body) && autreVu.body.length === 0, JSON.stringify(autreVu.body));

const vueClient = await restGet('debt_entries?select=id,amount_cfa', jetonC);
check('the debtor sees their own', Array.isArray(vueClient.body) && vueClient.body.length > 0,
  JSON.stringify(vueClient.body?.length));

// ---------------------------------------------------------------------------
console.log(`\n================ ${pass} passed, ${fail} failed ================`);
if (fail > 0) {
  console.log('Failures:');
  for (const f of failures) console.log(`  - ${f}`);
}
console.log(`\nRows created under numbers 225${VENDEUR}, 225${CLIENT}, 225${AUTRE}`);
process.exit(fail > 0 ? 1 : 0);
