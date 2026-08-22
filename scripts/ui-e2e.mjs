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
import { cible, PREFIXE_TEST, telephoneTest } from './test-target.mjs';

// Where this run may write. Production is REFUSED unless explicitly allowed —
// see scripts/test-target.mjs. This harness registers accounts and records
// ledger entries through the real API, and pointed at production it left 91 test
// accounts sitting in the vendor list.
const CIBLE_API = cible();
const BASE_API = CIBLE_API.url;
const APIKEY = CIBLE_API.apikey;
console.log(`API target: ${BASE_API}  (${CIBLE_API.source})`);
if (CIBLE_API.production) {
  console.log(`WARNING: writing to PRODUCTION. Accounts prefixed "${PREFIXE_TEST}".`);
}

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

// Reserved block and prefixed names, so anything this run creates is
// unmistakable and trivially filterable — in whichever project it lands.
// Identifying test rows by phone-number pattern was tried and silently missed
// four accounts from an older scheme; a prefix the harness always applies cannot
// drift like that.
const stamp = Date.now().toString().slice(-4);
const VENDOR_PHONE = telephoneTest(stamp);
const CUSTOMER_PHONE = telephoneTest(String((Number(stamp) + 1) % 10000).padStart(4, '0'));
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


/**
 * Does the page show this amount?
 *
 * Amounts render with a non-breaking space, and a literal in this file may be
 * either kind. Comparing with every space removed sidesteps a class of false
 * failures that look like missing data.
 */
function montantPresent(texte, attendu) {
  // \s in JavaScript already covers U+00A0 and U+202F, so one class suffices.
  const nu = (v) => v.replace(/\s/g, '');
  return nu(texte).includes(nu(attendu));
}


/**
 * Enter a customer's number, coping with the scan-or-type choice screen.
 *
 * SaisieClient remembers the vendor's last choice, so the choice screen appears
 * on the first lookup in a session and not afterwards. The helper handles both
 * rather than assuming one.
 */
async function saisirNumero(page, phone) {
  const choix = page.getByRole('button', { name: 'Taper le numéro' });
  if (await choix.isVisible().catch(() => false)) {
    await choix.click();
  }
  await tapDigits(page, phone);
  await page.getByRole('button', { name: 'Continuer' }).click();
}

/** Tap a sequence of digits on the built-in keypad. */
async function tapDigits(page, digits) {
  for (const d of digits) {
    await page.getByRole('button', { name: d, exact: true }).click();
  }
}

/**
 * Register through the UI, exactly as a shopkeeper standing in their boutique
 * would — no API shortcut.
 *
 * This is the flow that has to work with nobody helping, so it is the flow the
 * test drives. Registering via the API instead would leave the one screen a new
 * user actually meets completely unexercised.
 */
/**
 * Log in through the UI, starting from the landing screen.
 *
 * A first-time visitor now lands on Bienvenue rather than a login form, so
 * reaching the PIN entry means going through the "J'ai déjà un compte" door.
 */
async function loginViaUI(page, role, phone, pin) {
  await page.goto(APP);
  await page.getByRole('button', { name: "J'ai déjà un compte" }).click();
  await page.getByRole('heading', { name: 'Connexion' }).waitFor({ timeout: 20000 });
  await page.getByRole('button', { name: role === 'vendor' ? 'Commerçant' : 'Client' }).click();
  await tapDigits(page, phone);
  await page.getByRole('button', { name: 'Continuer' }).click();
  await tapDigits(page, pin);
}

async function registerViaUI(page, role, { phone, pin, nom, quartier }) {
  await page.goto(APP);

  // The landing screen. Checked once, on the vendor's device.
  if (role === 'vendor') {
    const accueil = (await page.textContent('body')).replace(/\s+/g, ' ');
    check('landing screen explains the product before asking anything',
      /Votre monnaie ne se perd plus/i.test(accueil)
      && /reste chez lui/i.test(accueil), accueil.slice(0, 160));
    check('landing screen offers BOTH doors',
      accueil.includes('Créer un compte') && accueil.includes("J'ai déjà un compte"));
    await page.screenshot({ path: 'artifacts/a1-bienvenue.png' });
  }

  await page.getByRole('button', { name: 'Créer un compte' }).click();
  await page.getByRole('heading', { name: 'Vous êtes ?' }).waitFor({ timeout: 20000 });

  await page.getByRole('button', { name: role === 'vendor' ? 'Commerçant' : 'Client' }).click();

  // phone
  await page.getByRole('heading', { name: 'Votre numéro' }).waitFor();
  await tapDigits(page, phone);
  await page.getByRole('button', { name: 'Continuer' }).click();

  // name
  await page
    .getByRole('heading', { name: role === 'vendor' ? 'Nom de la boutique' : 'Votre prénom' })
    .waitFor();
  await page.locator('input.champ__saisie').fill(nom);
  await page.getByRole('button', { name: 'Continuer' }).click();

  if (role === 'vendor') {
    // quartier
    await page.getByRole('heading', { name: 'Votre quartier' }).waitFor();
    await page.locator('input.champ__saisie').fill(quartier);
    await page.getByRole('button', { name: 'Continuer' }).click();

    // the disclosure — a real tap, never pre-ticked
    await page.getByRole('heading', { name: 'À lire avant de continuer' }).waitFor();
    const texte = (await page.textContent('body')).replace(/\s+/g, ' ');
    const attendu =
      "Sika Warri est un service d'enregistrement. Sika Warri ne détient, ne reçoit et ne transfère aucun fonds.";
    check('the verbatim disclosure is shown in full before signing up',
      texte.includes(attendu), texte.slice(0, 200));

    const avant = await page.getByRole('button', { name: 'Continuer' }).isDisabled();
    check('cannot continue without acknowledging the disclosure', avant === true);

    await page.getByRole('button', { name: /J'ai lu et j'accepte/ }).click();
    const apres = await page.getByRole('button', { name: 'Continuer' }).isDisabled();
    check('acknowledging enables continue', apres === false);
    await page.getByRole('button', { name: 'Continuer' }).click();
  }

  // PIN, with the rules shown before typing
  await page.getByRole('heading', { name: 'Choisissez votre code' }).waitFor();
  const regles = (await page.textContent('body')).replace(/\s+/g, ' ');
  check(`PIN rules explained BEFORE typing (${role})`,
    /pas 0000/i.test(regles) && /pas 1234/i.test(regles), regles.slice(0, 200));
  check(`told never to share the code (${role})`,
    /Ne donnez ce code à personne/i.test(regles));

  // A deliberately weak PIN must be refused before submission, not after.
  const faible = role === 'vendor' ? '123456' : '1234';
  await tapDigits(page, faible);
  const bloque = await page.getByRole('button', { name: 'Créer mon compte' }).isDisabled();
  check(`a sequential PIN is refused before submitting (${role})`, bloque === true);
  await page.getByRole('button', { name: 'Tout effacer' }).click();

  await tapDigits(page, pin);
  await page.getByRole('button', { name: 'Créer mon compte' }).click();

  await page.getByRole('heading', { name: "C'est fait" }).waitFor({ timeout: 30000 });
  check(`${role} registration completes`, true);

  await page.getByRole('button', { name: 'Commencer' }).click();
}

// ---------------------------------------------------------------------------

mkdirSync('artifacts', { recursive: true });

// Accounts are created THROUGH THE UI below, not through the API. The
// registration screen is the one screen every new user meets, so shortcutting
// it in the test would leave it the least exercised part of the app.
console.log(`Test numbers: vendor 225${VENDOR_PHONE}, customer 225${CUSTOMER_PHONE}\n`);

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

  // ===== vendor registers themselves, unaided ============================
  console.log('\n--- vendor registers, unaided ---');
  await registerViaUI(pv, 'vendor', {
    phone: VENDOR_PHONE, pin: VENDOR_PIN, nom: PREFIXE_TEST + 'Boutique', quartier: 'Yopougon',
  });

  await pv.getByRole('button', { name: 'Garder la monnaie' }).waitFor({ timeout: 20000 });
  check('vendor reaches the home screen', true);
  check('shop name is shown', (await pv.textContent('body')).includes(PREFIXE_TEST + 'Boutique'));
  await pv.screenshot({ path: 'artifacts/01-vendeur-accueil.png' });

  // ===== customer registers on the OTHER device ==========================
  //
  // Registered separately, on their own device, before the vendor needs them.
  // Amendment H means a customer who cannot register cannot complete a single
  // debit, and the vendor is not permitted to register them on their behalf.
  console.log('\n--- customer registers on a second device ---');
  await registerViaUI(pc, 'customer', {
    phone: CUSTOMER_PHONE, pin: CUSTOMER_PIN, nom: PREFIXE_TEST + 'Client', quartier: '',
  });
  await pc.screenshot({ path: 'artifacts/00-inscription-client.png' });

  // ===== legibility, measured on the rendered page ========================
  console.log('\n--- legibility, measured at 360px ---');
  await pv.getByRole('button', { name: 'Garder la monnaie' }).click();
  await pv.getByRole('heading', { name: 'Garder la monnaie' }).waitFor();

  // The lookup now opens on the scan-or-type choice. Take the typing door so
  // the keypad is on screen to measure.
  await pv.getByRole('button', { name: 'Taper le numéro' }).click();

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
  await saisirNumero(pv, CUSTOMER_PHONE);

  // A vendor who has never named this customer is asked once. A phone number is
  // useless at a counter, so this is where the label gets set.
  // isVisible() does NOT wait — it answers about this instant. Waiting for the
  // heading is the difference between testing the screen and testing a race.
  let nomDemande = true;
  try {
    await pv.getByRole('heading', { name: 'Qui est ce client ?' })
      .waitFor({ timeout: 20000 });
  } catch {
    nomDemande = false;
  }
  check('vendor is asked to name a customer they have not named before', nomDemande);
  if (nomDemande) {
    const texteNom = (await pv.textContent('body')).replace(/\s+/g, ' ');
    check('the label is explained as private to this vendor',
      /Vous seul le voyez/i.test(texteNom), texteNom.slice(0, 200));
    await pv.locator('input.champ__saisie').fill((PREFIXE_TEST + 'Nom'));
    await pv.getByRole('button', { name: 'Continuer' }).click();
  }

  await pv.getByRole('heading', { name: 'Combien ?' }).waitFor({ timeout: 20000 });

  const surMontant = (await pv.textContent('body')).replace(/\s+/g, ' ');
  check('the name is shown instead of a bare number',
    surMontant.includes((PREFIXE_TEST + 'Nom')), surMontant.slice(0, 200));

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

  // ===== the customer's device sits on their balances ====================
  //
  // With nothing pending, the customer's home IS their balance screen. The
  // confirmation view takes over only when a request arrives — ordering by
  // urgency rather than putting the urgent thing behind a tab.
  console.log('\n--- customer device, on their balances ---');
  await pc.getByRole('heading', { name: 'Ma monnaie' }).waitFor({ timeout: 25000 });
  check('customer home is their balance screen when nothing is pending', true);

  // The credit was recorded on the vendor's device moments ago. This screen
  // polls every 8 seconds, so waiting for the figure to APPEAR is the actual
  // behaviour under test: a customer watching their phone should see new change
  // arrive without touching anything.
  let apparu = true;
  try {
    await pc.waitForFunction(
      () => document.body.innerText.replace(/\s/g, '').includes('1500'),
      null,
      { timeout: 20000 }
    );
  } catch {
    apparu = false;
  }
  const avantDebit = await pc.textContent('body');
  check('the credit appears on the customer screen unprompted', apparu,
    avantDebit.slice(0, 250));
  await pc.screenshot({ path: 'artifacts/04-client-ma-monnaie.png' });

  // ===== vendor proposes a debit ==========================================
  console.log('\n--- utiliser la monnaie ---');
  await pv.getByRole('button', { name: 'Terminer' }).click();
  await pv.getByRole('button', { name: 'Utiliser la monnaie' }).click();
  await pv.getByRole('heading', { name: 'Utiliser la monnaie' }).waitFor();
  await saisirNumero(pv, CUSTOMER_PHONE);
  await pv.getByRole('heading', { name: 'Montant à utiliser' }).waitFor({ timeout: 20000 });
  check('a named customer is not asked for a name again', true);
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
  check('shows the shop name', corpsClient.includes(PREFIXE_TEST + 'Boutique'));
  check('shows the amount 400 F', corpsClient.includes('400'));
  check('shows current and resulting figures (1 500 -> 1 100)',
    corpsClient.includes('1 500') && corpsClient.includes('1 100'), corpsClient.slice(0, 300));
  await pc.screenshot({ path: 'artifacts/06-client-confirmer.png' });

  // ===== the customer confirms with their own PIN =========================
  await tapDigits(pc, CUSTOMER_PIN);
  let confirme = true;
  try {
    await pc.getByRole('heading', { name: "C'est confirmé" }).waitFor({ timeout: 25000 });
  } catch {
    confirme = false;
  }
  check('customer confirms on their OWN device', confirme,
    confirme ? '' : (await pc.textContent('body')).replace(/s+/g, ' ').slice(0, 400));
  if (!confirme) { await pc.screenshot({ path: 'artifacts/echec-confirmation.png' }); }

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

  // ===== the vendor home shows what they owe =============================
  //
  // The finding that prompted this screen: a shopkeeper had to tap into another
  // view to learn what they were holding. It should be readable on opening the
  // app, without touching anything.
  console.log('\n--- accueil vendeur ---');
  await pv.getByRole('button', { name: 'Terminer' }).click();
  await pv.getByRole('button', { name: 'Garder la monnaie' }).waitFor({ timeout: 20000 });

  let vuAccueil = true;
  try {
    await pv.waitForFunction(
      () => document.body.innerText.replace(/\s/g, '').includes('1100'),
      null,
      { timeout: 20000 }
    );
  } catch { vuAccueil = false; }

  const accueilVendeur = await pv.textContent('body');
  check('vendor home names what they are holding',
    /Monnaie que vous gardez/i.test(accueilVendeur));
  check('vendor home shows the figure without tapping anywhere (1 100 F)',
    vuAccueil, accueilVendeur.slice(0, 250));
  check('vendor home shows how many customers are concerned',
    /clients? concern/i.test(accueilVendeur));
  check("vendor home shows today's activity", /Aujourd'hui/i.test(accueilVendeur));
  check("today's activity shows both directions",
    /Gard[ée]e ·/i.test(accueilVendeur) && /Utilis[ée]e ·/i.test(accueilVendeur),
    accueilVendeur.slice(0, 300));
  await pv.screenshot({ path: 'artifacts/v1-accueil.png' });

  // ===== Mes clients — the vendor's own book =============================
  console.log('\n--- mes clients ---');
  await pv.getByRole('button', { name: 'Mes clients' }).click();
  await pv.getByRole('heading', { name: 'Mes clients' }).waitFor({ timeout: 20000 });

  // Wait for the list itself, not just the heading. Asserting on figures while
  // the fetch is in flight reads the loading placeholder.
  await pv.locator('.ligne-client').first().waitFor({ timeout: 25000 });

  const livre = (await pv.textContent('body')).replace(/ /g, ' ');
  check('shows monnaie en circulation', /Monnaie en circulation/i.test(livre));
  check('shows no misleading 0 F once loaded', !/Monnaie en circulation.?0.?F/i.test(livre));
  // 1 500 credited, 400 spent, so the vendor still holds 1 100 for one customer.
  check('circulation figure is 1 100 F', montantPresent(livre, '1 100'), livre.slice(0, 250));
  check('one customer is listed', livre.includes('1 client concerné'), livre.slice(0, 250));
  check('the client list shows the NAME, not just a number',
    livre.includes((PREFIXE_TEST + 'Nom')), livre.slice(0, 300));
  await pv.screenshot({ path: 'artifacts/c1-mes-clients.png' });

  // Search narrows by number.
  await pv.locator('input.champ__saisie').fill(CUSTOMER_PHONE.slice(0, 6));
  const trouve = await pv.locator('.ligne-client').count();
  check('search by number finds the customer', trouve === 1, `matched ${trouve}`);

  await pv.locator('input.champ__saisie').fill('0000000000');
  const rien = await pv.locator('.ligne-client').count();
  check('a non-matching search shows nothing rather than everything', rien === 0);
  await pv.locator('input.champ__saisie').fill('');

  // Drill into that customer's history.
  await pv.locator('.ligne-client').first().click();
  await pv.getByRole('heading', { name: 'Détail' }).waitFor({ timeout: 20000 });
  await pv.locator('.ligne-histoire').first().waitFor({ timeout: 25000 });
  const detail = await pv.textContent('body');
  check('history shows both the credit and the debit',
    /Monnaie gard[ée]e/i.test(detail) && /Utilis[ée]e pour un achat/i.test(detail),
    detail.slice(0, 300));
  check('history shows a running balance', /reste/i.test(detail));
  check('the customer detail is headed by the name',
    detail.includes((PREFIXE_TEST + 'Nom')), detail.slice(0, 250));
  // The vouching path is gone. What remains is the vendor being told plainly
  // that they cannot reset a code and must never ask for one.
  const detailPropre = detail.replace(/\s+/g, ' ');
  check('the vendor is told they CANNOT reset a customer code',
    /Vous ne pouvez pas réinitialiser son code/i.test(detailPropre),
    detailPropre.slice(0, 300));
  check('and that they must never ask for it',
    /jamais le lui demander/i.test(detailPropre), detailPropre.slice(0, 300));
  // Checked as a BUTTON, not as text. The explanation legitimately contains the
  // word "réinitialiser" — what must not exist is something tappable.
  const boutonsReset = await pv
    .getByRole('button', { name: /r[ée]initialis|oubli[ée] son code/i })
    .count();
  check('no reset button is offered to the vendor', boutonsReset === 0,
    `${boutonsReset} found`);
  await pv.screenshot({ path: 'artifacts/c2-client-detail.png' });

  // ===== Ma monnaie — the point of the product ===========================
  console.log('\n--- ma monnaie (acceptance test 8) ---');
  await pc.getByRole('heading', { name: 'Ma monnaie' }).waitFor({ timeout: 25000 });

  // The debit landed moments ago and this screen polls every 8 seconds. Wait
  // for the post-debit figure rather than reading mid-refresh — otherwise the
  // test is a coin flip on timing, which is worse than no test.
  try {
    await pc.waitForFunction(
      () => document.body.innerText.replace(/\s/g, '').includes('1100'),
      null,
      { timeout: 25000 }
    );
  } catch { /* assertions below report it precisely */ }

  const maMonnaie = (await pc.textContent('body')).replace(/ /g, ' ');
  check('customer sees the shop by name', maMonnaie.includes(PREFIXE_TEST + 'Boutique'));
  check('customer sees their figure at that shop (1 100 F)',
    montantPresent(maMonnaie, '1 100'), maMonnaie.slice(0, 300));
  check('states the money stays with the vendor',
    /reste chez le commer[çc]ant/i.test(maMonnaie));

  // With ONE shop there must be no total at all — repeating the same number
  // under a "spread across" caption would imply a pool.
  check('NO informational total with a single shop',
    !/à titre d'information/i.test(maMonnaie), maMonnaie.slice(0, 300));
  check('never presents a spendable total',
    !/monnaie totale/i.test(maMonnaie) && !/total disponible/i.test(maMonnaie));
  await pc.screenshot({ path: 'artifacts/b1-ma-monnaie.png' });

  // Drill into the shop's history.
  await pc.locator('.carnet--cliquable').first().click();
  await pc.getByRole('heading', { name: 'Détail' }).waitFor({ timeout: 20000 });
  await pc.locator('.ligne-histoire').first().waitFor({ timeout: 25000 });
  const histoireClient = await pc.textContent('body');
  check('customer history lists their own movements',
    /Monnaie gard[ée]e/i.test(histoireClient));
  check('customer is told they can ask for cash back',
    /rembourser en esp[èe]ces/i.test(histoireClient), histoireClient.slice(0, 300));
  await pc.screenshot({ path: 'artifacts/b2-boutique-detail.png' });

  // ===== QR: the customer's code =========================================
  console.log('\n--- mon code (QR) ---');
  await pc.getByRole('button', { name: 'Retour à ma monnaie' }).click().catch(() => {});
  await pc.getByRole('button', { name: 'Voir toutes mes boutiques' }).click().catch(() => {});
  await pc.getByRole('button', { name: 'Mon code' }).click();
  await pc.getByRole('heading', { name: 'Mon code' }).waitFor({ timeout: 20000 });

  // The canvas must actually contain a rendered code, not just exist.
  const qr = await pc.evaluate(() => {
    const c = document.querySelector('canvas');
    if (!c) return null;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let sombres = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] < 128) sombres += 1;
    return { largeur: c.width, hauteur: c.height, sombres };
  });
  check('the QR canvas renders actual dark modules',
    qr !== null && qr.largeur > 100 && qr.sombres > 200, JSON.stringify(qr));

  const codeEcran = await pc.textContent('body');
  check('the number is shown in plain text beside the code',
    codeEcran.replace(/\s/g, '').includes(CUSTOMER_PHONE.slice(1)),
    codeEcran.slice(0, 200));
  check('states plainly that the code cannot take their money',
    /ne permet pas de prendre votre monnaie/i.test(codeEcran.replace(/\s+/g, ' ')));
  await pc.screenshot({ path: 'artifacts/d1-mon-code.png' });

  // ===== QR: the vendor's two doors ======================================
  console.log('\n--- scanner ou taper ---');
  const neuf = await navigateur.newContext({ viewport: TELEPHONE, locale: 'fr-FR' });
  const pn = await neuf.newPage();
  await loginViaUI(pn, 'vendor', VENDOR_PHONE, VENDOR_PIN);
  await pn.getByRole('button', { name: 'Garder la monnaie' }).waitFor({ timeout: 20000 });
  await pn.getByRole('button', { name: 'Garder la monnaie' }).click();

  // A fresh context has no remembered preference, so the choice screen shows.
  await pn.getByRole('button', { name: 'Taper le numéro' }).waitFor({ timeout: 20000 });
  const deuxPortes = await pn.locator('.choix__option').count();
  check('both options offered as equal buttons', deuxPortes === 2, `found ${deuxPortes}`);

  const tailles = await pn.evaluate(() =>
    [...document.querySelectorAll('.choix__option')].map((e) => ({
      w: Math.round(e.getBoundingClientRect().width),
      h: Math.round(e.getBoundingClientRect().height),
    }))
  );
  // Equal weight is the requirement, not a hierarchy with a small "or type"
  // link underneath.
  check('the two options are the same size',
    tailles.length === 2 && tailles[0].w === tailles[1].w && tailles[0].h === tailles[1].h,
    JSON.stringify(tailles));
  check('both options are >= 48px tall', tailles.every((t) => t.h >= 48), JSON.stringify(tailles));
  await pn.screenshot({ path: 'artifacts/d2-choix.png' });

  // Camera refused: the offer to type must appear, with no dead end.
  await pn.getByRole('button', { name: 'Scanner son code' }).click();
  let messageCamera = '';
  for (let i = 0; i < 30; i += 1) {
    messageCamera = (await pn.textContent('body')).replace(/\s+/g, ' ');
    if (/Tapez le numéro du client|Taper le numéro/i.test(messageCamera)) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  check('camera unavailable degrades to typing, with a reason',
    /Tapez le numéro du client/i.test(messageCamera)
    || /Taper le numéro/i.test(messageCamera), messageCamera.slice(0, 220));
  await pn.screenshot({ path: 'artifacts/d3-camera-refusee.png' });

  // And typing still completes from there.
  await pn.getByRole('button', { name: 'Taper le numéro' }).click().catch(() => {});
  await tapDigits(pn, CUSTOMER_PHONE);
  await pn.getByRole('button', { name: 'Continuer' }).click();
  await pn.getByRole('heading', { name: 'Combien ?' }).waitFor({ timeout: 25000 });
  check('typing still works after the camera failed', true);
  await neuf.close();

  // ===== 320px, the spec floor ===========================================
  console.log('\n--- 320px viewport ---');
  const etroit = await navigateur.newContext({
    viewport: { width: 320, height: 640, isMobile: true, hasTouch: true }, locale: 'fr-FR',
  });
  const pe = await etroit.newPage();
  await pe.goto(APP);
  await pe.getByRole('heading', { name: /Votre monnaie ne se perd plus/ }).waitFor({ timeout: 20000 });
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
  await loginViaUI(ph, 'vendor', VENDOR_PHONE, VENDOR_PIN);
  await ph.getByRole('button', { name: 'Garder la monnaie' }).waitFor({ timeout: 20000 });
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
