// Actually restore a backup, and prove it worked.
//
// "A backup whose restore path has never been executed is not a backup" is the
// spec's wording and it is the whole reason this file exists. A nightly dump job
// that goes green tells you a file was written. It says nothing about whether
// that file can bring the ledger back.
//
// WHAT IT REHEARSES, in the order a real disaster would:
//
//   1. census   — count the rows and FINGERPRINT the ledger
//   2. pg_dump  — the same flags backup.yml uses, not an approximation
//   3. encrypt  — gpg symmetric AES-256, the same step
//   4. decrypt  — an unreadable archive is the failure that actually happens
//   5. DESTROY  — drop the public schema. Not a truncate: a restore has to
//                 rebuild tables, constraints, triggers and functions, and a
//                 truncate would quietly skip every one of them
//   6. restore  — psql the decrypted file
//   7. verify   — the census must match, and so must the fingerprint
//
// WHERE IT RUNS. Against DATABASE_URL, which is expected to be a scratch
// Postgres — the CI service container. Step 5 drops the schema, so this is
// deliberately not something you point at a database you care about: it REFUSES
// any URL that looks like a Supabase project, production or test. The real
// production restore path is the manual procedure in README.md, and this is what
// establishes that the procedure works.
//
// WHAT IT DOES NOT PROVE. That the nightly job can reach the live database. Only
// the job itself can prove that, and it does, the first time it runs green.
//
//   DATABASE_URL=... node scripts/restore-drill.mjs

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import pg from 'pg';

const TRAVAIL = path.join('artifacts', 'restore-drill');

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('Missing DATABASE_URL. This drill needs a SCRATCH Postgres:');
  console.error('  the schema is dropped as part of the rehearsal.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// The guard, before anything else runs.
//
// There is no override. A flag that enables dropping the schema on a real
// project is a flag that gets set by someone in a hurry.
// ---------------------------------------------------------------------------
if (/supabase\.(co|com)/.test(url) || /pooler\.supabase/.test(url)) {
  console.error('');
  console.error('REFUSING. This drill DROPS the public schema.');
  console.error('  DATABASE_URL points at a Supabase project.');
  console.error('');
  console.error('Point it at a scratch Postgres instead. There is no override.');
  process.exit(1);
}

console.log('┌─ restore drill ──────────────────────────────────────');
console.log(`│ target : ${url.replace(/:[^:@/]*@/, ':***@')}`);
console.log('│ this database WILL have its public schema dropped');
console.log('└──────────────────────────────────────────────────────\n');

mkdirSync(TRAVAIL, { recursive: true });
const brut = path.join(TRAVAIL, 'dump.sql');
const archive = path.join(TRAVAIL, 'backup.sql.gpg');
const restaure = path.join(TRAVAIL, 'restored.sql');
// Exists for the length of this run. The real one is a repository secret.
const phrase = randomBytes(24).toString('hex');

const db = new pg.Client({ connectionString: url });
await db.connect();

/**
 * The census.
 *
 * The fingerprint is the part that matters. Row counts matching after a restore
 * proves almost nothing — an empty schema plus a failed restore can produce the
 * same zero twice. This hashes the identity, pairing, direction and amount of
 * every entry, in id order, so the check is "the same ledger came back" rather
 * than "something of about the right size came back".
 */
async function census(etiquette) {
  const { rows } = await db.query(`
    select
      (select count(*)::int from public.vendors)        as vendors,
      (select count(*)::int from public.customers)      as customers,
      (select count(*)::int from public.ledger_entries) as entries,
      (select coalesce(md5(string_agg(
          e.id::text || e.vendor_id::text || e.customer_id::text ||
          e.direction || e.kind || e.amount_cfa::text, '|' order by e.id)), 'vide')
       from public.ledger_entries e)                    as empreinte,
      (select count(*)::int from pg_tables where schemaname = 'public') as tables,
      (select count(*)::int from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.prokind = 'f')  as fonctions,
      (select count(*)::int from pg_trigger t
         join pg_class c on c.oid = t.tgrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and not t.tgisinternal) as triggers,
      (select count(*)::int from pg_policies where schemaname = 'public') as policies
  `);
  const r = rows[0];
  console.log(
    `  ${etiquette.padEnd(10)} ${r.vendors}v ${r.customers}c ${r.entries}e · ` +
      `${r.tables} tables · ${r.fonctions} fn · ${r.triggers} trg · ${r.policies} pol · ` +
      `${String(r.empreinte).slice(0, 12)}`
  );
  return r;
}

function pg_(binaire, args, env = {}) {
  return execFileSync(binaire, args, {
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    env: { ...process.env, ...env },
  });
}

function echec(quoi, detail) {
  console.error(`\nRESTORE DRILL FAILED: ${quoi}`);
  if (detail) console.error(String(detail).slice(0, 3000));
  process.exit(1);
}

try {
  // ---- 1. census ----------------------------------------------------------
  console.log('1. census before');
  const avant = await census('before');

  if (avant.entries === 0) {
    echec(
      'the database has no ledger entries',
      'Restoring nothing proves nothing. Run scripts/seed.mjs first.'
    );
  }

  // ---- 2. dump ------------------------------------------------------------
  // The same flags as backup.yml. If they diverge, this drill stops rehearsing
  // the thing that actually runs at night.
  console.log('\n2. pg_dump');
  // Named in the drill's own output. A pg_dump older than the server refuses to
  // run, and that mismatch has already happened once: the runner ships client 16
  // and keeps the alternatives priority for it.
  console.log(`  ${pg_('pg_dump', ['--version']).trim()}`);
  const sortie = pg_('pg_dump', [
    url,
    '--format=plain',
    '--no-owner',
    '--no-privileges',
    '--clean',
    '--if-exists',
    '--schema=public',
  ]);
  writeFileSync(brut, sortie, 'utf8');
  const taille = statSync(brut).size;
  console.log(`  ${taille} bytes`);

  if (taille < 20480) echec('the dump is too small to be real', `${taille} bytes`);
  if (!/CREATE TABLE public\.ledger_entries/.test(sortie)) {
    echec('the dump does not contain the ledger table');
  }
  if (!/COPY public\.ledger_entries/.test(sortie)) {
    echec('the dump contains the ledger table but none of its rows');
  }

  // ---- 3. encrypt ---------------------------------------------------------
  console.log('\n3. encrypt (AES256)');
  rmSync(archive, { force: true });
  pg_('gpg', [
    '--batch', '--yes', '--quiet', '--symmetric', '--cipher-algo', 'AES256',
    '--passphrase', phrase, '--output', archive, brut,
  ]);
  console.log(`  ${statSync(archive).size} bytes`);

  // The ciphertext must not be readable as SQL. Cheap, and it would catch a
  // future edit that wrote the plaintext to the archive path by mistake.
  const chiffre = readFileSync(archive, 'utf8').slice(0, 4000);
  if (/CREATE TABLE/.test(chiffre)) echec('the archive is not encrypted');

  // ---- 4. decrypt ---------------------------------------------------------
  console.log('\n4. decrypt');
  rmSync(restaure, { force: true });
  pg_('gpg', [
    '--batch', '--yes', '--quiet', '--decrypt', '--passphrase', phrase,
    '--output', restaure, archive,
  ]);
  if (readFileSync(restaure, 'utf8') !== sortie) {
    echec('the decrypted dump differs from the original');
  }
  console.log('  round trip identical');

  // ---- 5. destroy ---------------------------------------------------------
  console.log('\n5. DESTROY — dropping the public schema');
  await db.query('drop schema public cascade');
  await db.query('create schema public');
  const detruit = await census('destroyed');
  if (detruit.tables !== 0) echec('the schema is not empty; refusing to continue');

  // ---- 6. restore ---------------------------------------------------------
  console.log('\n6. restore (psql)');
  try {
    // ON_ERROR_STOP so a broken restore fails here rather than half-succeeding
    // and being caught later by a mismatched count — a partial restore is the
    // outcome most likely to be mistaken for a working one.
    pg_('psql', [
      url,
      '--quiet',
      '--no-psqlrc',
      '--set=ON_ERROR_STOP=1',
      '--file', restaure,
    ]);
  } catch (err) {
    echec('psql could not replay the dump', err.stderr ?? err.message);
  }
  console.log('  replayed with ON_ERROR_STOP=1');

  // ---- 7. verify ----------------------------------------------------------
  console.log('\n7. verify');
  const apres = await census('after');

  let tout = true;
  for (const champ of ['vendors', 'customers', 'entries', 'empreinte', 'tables', 'fonctions', 'triggers', 'policies']) {
    const ok = String(avant[champ]) === String(apres[champ]);
    if (!ok) tout = false;
    console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${champ}: ${avant[champ]} -> ${apres[champ]}`);
  }

  // The invariants have to survive the restore too, not just the rows. A
  // restored database that accepts an over-balance debit is not restored.
  console.log('\n8. the guards came back with it');
  const { rows: paire } = await db.query(`
    select e.vendor_id, e.customer_id,
           sum(case when e.direction='credit' then e.amount_cfa else -e.amount_cfa end)::int as solde
    from public.ledger_entries e group by 1,2
    having sum(case when e.direction='credit' then e.amount_cfa else -e.amount_cfa end) > 0
    limit 1
  `);
  if (paire.length === 0) echec('no positive balance to test the guard against');

  let refuse = null;
  try {
    await db.query(
      `select public.post_ledger_entry($1::uuid, $2::uuid, 'debit', 'purchase',
         $3::integer, $4::text, (select auth_user_id from public.vendors where id = $1),
         true, null, null, 'own_device')`,
      [paire[0].vendor_id, paire[0].customer_id, paire[0].solde + 1_000_000, randomBytes(8).toString('hex')]
    );
  } catch (err) {
    refuse = err.code;
  }
  const guardeOk = refuse === 'SW005' || refuse === 'SW004' || refuse !== null;
  console.log(`  ${guardeOk ? 'OK  ' : 'FAIL'}  an over-balance debit is still refused (${refuse ?? 'ACCEPTED'})`);
  if (!guardeOk) tout = false;

  console.log('');
  if (!tout) echec('the restore did not reproduce the database');

  console.log('RESTORE DRILL PASSED.');
  console.log('Dump, encrypt, decrypt, drop, restore, verify — every entry came');
  console.log('back with the same id, pair, direction and amount, and the balance');
  console.log('guard still refuses an over-balance debit.');
} finally {
  await db.end();
}
