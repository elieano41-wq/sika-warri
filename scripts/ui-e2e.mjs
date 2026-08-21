// Drive the REAL built app through the whole loop, in two separate browser
// contexts, against the LIVE project.
//
// Two contexts is the point. Amendment H says the customer confirms on their
// own device, so a test that uses one browser proves nothing about the thing
// the design exists to guarantee. Each context has its own storage and its own
// session, exactly like two phones.
//
// Run: node scripts/ui-e2e.mjs
// Requires: npm run build (env vars are baked in at build time).

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => /^[A-Z]/.test(l))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);

const BASE_API = env.VITE_SUPABASE_URL;
const APIKEY = env.VITE_SUPABASE_PUBLISHABLE_KEY;
const PORT = 4178;

// Target the deployed site when given one, otherwise serve the local build.
// Testing the deployed URL is the only way to catch a build whose env vars never
// reached the browser: that failure surfaces as "ce numéro n'est pas encore
// enregistré", not as an error, so it looks like a data problem rather than a
// configuration one.
//
//   node scripts/ui-e2e.mjs                        -> local build
//   node scripts/ui-e2e.mjs https://example.pages.dev -> deployed
const CIBLE = process.env.SIKA_URL ?? process.argv[2] ?? null;
const APP = CIBLE ?? `http://localhost:${PORT}`;
const LOCAL = CIBLE === null;

// A cheap Android in portrait. Not a desktop window shrunk down.
const TELEPHONE = { width: 360, height: 740, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

const stamp = Date.now().toString().slice(-6);
const VENDOR_PHONE = `07${stamp}11`.slice(0, 10);
const CUSTOMER_PHONE = `05${stamp}11`.slice(0, 10);
const VENDOR_PIN = '481627';
const CUSTOMER_PIN = '2846';

let pass = 0, fail = 0;
const failures = [];

function check(label, ok, detail = '') {
  if (ok) { pass += 1; console.log(`  PASS  ${label}`); }
  else { fail += 1; failures.push(label); console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}

async function apiRegister(role, phone, pin, extra = {}) {
  const res = await fetch(`${BASE_API}/functions/v1/register`, {
    method: 'POST',
    headers: { apikey: APIKEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ role, phone, pin, ...extra }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** Tap a sequence of digits on the built-in keypad. */
async function tapDigits(page, digits) {
  for (const d of digits) {
    await page.getByRole('button', { name: d, exact: true }).click();
  }
}

// ---------------------------------------------------------------------------

mkdirSync('artifacts', { recursive: true });

console.log(`Registering test accounts on ${BASE_API}`);
const rv = await apiRegister('vendor', VENDOR_PHONE, VENDOR_PIN, {
  businessName: 'Chez Awa', quartier: 'Yopougon', commune: 'Abidjan', termsAccepted: true,
});
if (rv.body?.ok !== true) throw new Error(`vendor register failed: ${JSON.stringify(rv.body)}`);
const rc = await apiRegister('customer', CUSTOMER_PHONE, CUSTOMER_PIN);
if (rc.body?.ok !== true) throw new Error(`customer register failed: ${JSON.stringify(rc.body)}`);
console.log(`  vendor 225${VENDOR_PHONE}, customer 225${CUSTOMER_PHONE}\n`);

let serveur = null;
if (LOCAL) {
  console.log('Starting preview server…');
  serveur = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
    stdio: 'ignore', shell: true,
  });
} else {
  console.log(`Targeting DEPLOYED url ${APP}`);
}

// Wait for it rather than sleeping blindly.
let pret = false;
for (let i = 0; i < 40 && !pret; i += 1) {
  try {
    const r = await fetch(APP);
    if (r.ok) pret = true;
  } catch { await new Promise((r) => setTimeout(r, 500)); }
}
if (!pret) { serveur?.kill(); throw new Error(`${APP} did not respond`); }
console.log(`  serving ${APP}\n`);

const navigateur = await chromium.launch();

try {
  // ===== two separate devices ============================================
  const telVendeur = await navigateur.newContext({ viewport: TELEPHONE, locale: 'fr-FR' });
  const telClient = await navigateur.newContext({ viewport: TELEPHONE, locale: 'fr-FR' });
  const pv = await telVendeur.newPage();
  const pc = await telClient.newPage();

  const erreursConsole = [];
  for (const p of [pv, pc]) {
    p.on('console', (m) => { if (m.type() === 'error') erreursConsole.push(m.text()); });
    p.on('pageerror', (e) => erreursConsole.push(String(e)));
  }

  // ===== configuration actually reached the browser ======================
  //
  // A missing VITE_ variable does not throw a network error — the app either
  // fails to boot or, worse, points at nothing and reports every customer as
  // unregistered. So the served bundle is inspected directly rather than
  // inferred from the app appearing to work.
  console.log('--- configuration reached the browser ---');
  await pv.goto(APP);

  const html = await pv.content();
  const chemins = [...html.matchAll(/src="([^"]*\.js)"/g)].map((m) => m[1]);
  let bundleConfig = { url: false, cle: false, taille: 0 };
  for (const chemin of chemins) {
    const res = await pv.request.get(new URL(chemin, APP).toString());
    const js = await res.text();
    bundleConfig.taille += js.length;
    if (js.includes(BASE_API)) bundleConfig.url = true;
    if (js.includes(APIKEY)) bundleConfig.cle = true;
  }

  check(`VITE_SUPABASE_URL is in the served bundle`, bundleConfig.url,
    `scanned ${chemins.length} script(s), ${bundleConfig.taille} bytes`);
  check(`VITE_SUPABASE_PUBLISHABLE_KEY is in the served bundle`, bundleConfig.cle);

  const configErreur = (await pv.textContent('body')) ?? '';
  check('no configuration error on screen',
    !/Configuration manquante/i.test(configErreur), configErreur.slice(0, 120));

  const marqueur = await pv.textContent('body');
  const sha = /build\s+([0-9a-f]{7}\+?|inconnu)/i.exec(marqueur ?? '');
  check(`version marker visible (${sha ? sha[1] : 'ABSENT'})`, sha !== null);
  check('version marker is a real commit, not the fallback',
    sha !== null && sha[1] !== 'inconnu', sha?.[1]);

  // ===== vendor logs in ==================================================
  console.log('\n--- vendor logs in ---');
  await pv.getByRole('button', { name: 'Commerçant' }).click();
  await tapDigits(pv, VENDOR_PHONE);
  await pv.getByRole('button', { name: 'Continuer' }).click();
  await tapDigits(pv, VENDOR_PIN);

  await pv.getByRole('heading', { name: 'Que faites-vous ?' }).waitFor({ timeout: 20000 });
  check('vendor reaches the home screen', true);
  check('shop name is shown', (await pv.textContent('body')).includes('Chez Awa'));
  await pv.screenshot({ path: 'artifacts/01-vendeur-accueil.png' });

  // ===== legibility, measured on the rendered page ========================
  console.log('\n--- legibility, measured at 360px ---');
  await pv.getByRole('button', { name: 'Garder la monnaie' }).click();
  await pv.getByRole('heading', { name: 'Garder la monnaie' }).waitFor();

  const boutonPrimaire = await pv.getByRole('button', { name: 'Continuer' }).boundingBox();
  check(`primary action >= 48px tall (${Math.round(boutonPrimaire.height)}px)`,
    boutonPrimaire.height >= 48, `${boutonPrimaire.height}`);

  const touche = await pv.getByRole('button', { name: '7', exact: true }).boundingBox();
  check(`keypad key >= 48px (${Math.round(touche.width)}x${Math.round(touche.height)})`,
    touche.height >= 48 && touche.width >= 48);

  const corpsPx = await pv.evaluate(() =>
    parseFloat(getComputedStyle(document.body).fontSize)
  );
  check(`body text >= 16px (${corpsPx}px)`, corpsPx >= 16, `${corpsPx}`);

  const debordement = await pv.evaluate(() =>
    document.documentElement.scrollWidth > document.documentElement.clientWidth
  );
  check('no horizontal overflow at 360px', debordement === false);

  // ===== garder la monnaie ===============================================
  console.log('\n--- garder la monnaie ---');
  await tapDigits(pv, CUSTOMER_PHONE);
  await pv.getByRole('button', { name: 'Continuer' }).click();
  await pv.getByRole('heading', { name: 'Combien ?' }).waitFor({ timeout: 20000 });

  await tapDigits(pv, '1500');

  // The amount must actually be big on screen, not merely styled to be.
  const tailleMontant = await pv.evaluate(() => {
    const el = document.querySelector('.montant--geant');
    return el ? parseFloat(getComputedStyle(el).fontSize) : 0;
  });
  check(`the amount renders >= 40px (${Math.round(tailleMontant)}px)`, tailleMontant >= 40,
    `${tailleMontant}`);

  const monoEtTabulaire = await pv.evaluate(() => {
    const el = document.querySelector('.montant--geant');
    const s = getComputedStyle(el);
    return { police: s.fontFamily, chiffres: s.fontVariantNumeric };
  });
  check('the amount is mono', /Plex Mono|monospace/i.test(monoEtTabulaire.police),
    monoEtTabulaire.police);
  check('the amount is tabular', monoEtTabulaire.chiffres.includes('tabular-nums'),
    monoEtTabulaire.chiffres);

  const texteMontant = await pv.textContent('.montant--geant');
  check(`shows "1 500 F" with a space separator (${JSON.stringify(texteMontant)})`,
    texteMontant.replace(/ /g, ' ').trim() === '1 500 F');

  await pv.screenshot({ path: 'artifacts/02-garder-montant.png' });

  await pv.getByRole('button', { name: 'Garder la monnaie' }).click();
  await pv.getByRole('heading', { name: 'Monnaie gardée' }).waitFor({ timeout: 25000 });
  check('credit recorded and receipt shown', true);

  const corpsRecu = await pv.textContent('body');
  check('receipt shows the new figure 1 500 F',
    corpsRecu.replace(/ /g, ' ').includes('1 500'));
  check('le carnet is rendered', (await pv.locator('.carnet').count()) > 0);
  await pv.screenshot({ path: 'artifacts/03-garder-recu.png' });

  // ===== customer logs in on the OTHER device ============================
  console.log('\n--- customer logs in on a second device ---');
  await pc.goto(APP);
  await pc.getByRole('button', { name: 'Client' }).click();
  await tapDigits(pc, CUSTOMER_PHONE);
  await pc.getByRole('button', { name: 'Continuer' }).click();
  await tapDigits(pc, CUSTOMER_PIN);
  await pc.getByRole('heading', { name: 'Aucune demande' }).waitFor({ timeout: 20000 });
  check('customer sees no pending request yet', true);
  await pc.screenshot({ path: 'artifacts/04-client-attente.png' });

  // ===== vendor proposes a debit ==========================================
  console.log('\n--- utiliser la monnaie ---');
  await pv.getByRole('button', { name: 'Terminer' }).click();
  await pv.getByRole('button', { name: 'Utiliser la monnaie' }).click();
  await pv.getByRole('heading', { name: 'Utiliser la monnaie' }).waitFor();
  await tapDigits(pv, CUSTOMER_PHONE);
  await pv.getByRole('button', { name: 'Continuer' }).click();
  await pv.getByRole('heading', { name: 'Montant à utiliser' }).waitFor({ timeout: 20000 });
  await tapDigits(pv, '400');
  await pv.getByRole('button', { name: 'Demander la confirmation' }).click();
  await pv.getByRole('heading', { name: 'En attente du client' }).waitFor({ timeout: 20000 });
  check('vendor screen waits for the customer', true);

  const attente = await pv.textContent('body');
  check('vendor screen tells them never to ask for the code',
    /ne demandez jamais son code/i.test(attente.replace(/\s+/g, ' ')));
  await pv.screenshot({ path: 'artifacts/05-vendeur-attente.png' });

  // ===== the request appears on the customer's phone by itself ============
  console.log('\n--- the request appears on the customer phone ---');
  await pc.getByRole('heading', { name: 'Confirmer ?' }).waitFor({ timeout: 25000 });
  check('request appears on the customer device without reloading', true);

  const corpsClient = (await pc.textContent('body')).replace(/ /g, ' ');
  check('shows the shop name', corpsClient.includes('Chez Awa'));
  check('shows the amount 400 F', corpsClient.includes('400'));
  check('shows current and resulting figures (1 500 -> 1 100)',
    corpsClient.includes('1 500') && corpsClient.includes('1 100'), corpsClient.slice(0, 300));
  await pc.screenshot({ path: 'artifacts/06-client-confirmer.png' });

  // ===== the customer confirms with their own PIN =========================
  await tapDigits(pc, CUSTOMER_PIN);
  await pc.getByRole('heading', { name: "C'est confirmé" }).waitFor({ timeout: 25000 });
  check('customer confirms on their OWN device', true);

  const apres = (await pc.textContent('body')).replace(/ /g, ' ');
  check('customer told what remains (1 100 F)', apres.includes('1 100'), apres.slice(0, 200));
  await pc.screenshot({ path: 'artifacts/07-client-confirme.png' });

  // ===== the vendor screen updates by itself =============================
  console.log('\n--- vendor screen updates ---');
  await pv.getByRole('heading', { name: 'Confirmé' }).waitFor({ timeout: 30000 });
  check('vendor screen updates when the debit lands, without reloading', true);

  const vendeurApres = (await pv.textContent('body')).replace(/ /g, ' ');
  check('vendor sees the remaining figure 1 100 F', vendeurApres.includes('1 100'),
    vendeurApres.slice(0, 300));
  await pv.screenshot({ path: 'artifacts/08-vendeur-confirme.png' });

  // ===== 320px, the spec floor ===========================================
  console.log('\n--- 320px viewport ---');
  const etroit = await navigateur.newContext({
    viewport: { width: 320, height: 640, isMobile: true, hasTouch: true }, locale: 'fr-FR',
  });
  const pe = await etroit.newPage();
  await pe.goto(APP);
  await pe.getByRole('button', { name: 'Commerçant' }).click();
  const deborde320 = await pe.evaluate(() =>
    document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
  );
  check('no horizontal overflow at 320px', deborde320 === false);
  await pe.screenshot({ path: 'artifacts/09-320px.png' });
  await etroit.close();

  // ===== debits blocked offline ==========================================
  console.log('\n--- offline behaviour ---');
  const horsLigne = await navigateur.newContext({ viewport: TELEPHONE, locale: 'fr-FR' });
  const ph = await horsLigne.newPage();
  await ph.goto(APP);
  await ph.getByRole('button', { name: 'Commerçant' }).click();
  await tapDigits(ph, VENDOR_PHONE);
  await ph.getByRole('button', { name: 'Continuer' }).click();
  await tapDigits(ph, VENDOR_PIN);
  await ph.getByRole('heading', { name: 'Que faites-vous ?' }).waitFor({ timeout: 20000 });
  await horsLigne.setOffline(true);
  await ph.evaluate(() => window.dispatchEvent(new Event('offline')));
  await ph.getByRole('button', { name: 'Utiliser la monnaie' }).click();

  const messageHorsLigne = await ph.textContent('body');
  check('debits blocked offline with the exact section 8 wording',
    messageHorsLigne.includes('Connexion requise pour utiliser la monnaie'));
  await ph.screenshot({ path: 'artifacts/10-hors-ligne.png' });
  await horsLigne.close();

  // ===== console cleanliness =============================================
  const graves = erreursConsole.filter((e) => !/favicon|manifest/i.test(e));
  check(`no console errors during the loop (${graves.length})`, graves.length === 0,
    graves.slice(0, 3).join(' | '));

  await telVendeur.close();
  await telClient.close();
} finally {
  await navigateur.close();
  serveur?.kill();
}

console.log(`\n================ ${pass} passed, ${fail} failed ================`);
if (fail) { console.log('Failures:'); for (const f of failures) console.log(`  - ${f}`); }
console.log('Screenshots in artifacts/');
process.exit(fail ? 1 : 0);
