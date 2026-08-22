// Clear automated-test accounts out of the TEST project.
//
// REFUSES TO RUN AGAINST PRODUCTION. Not by convention — it reads the linked
// project ref and aborts if it matches. There is no override flag.
//
// It also no longer WRITES anything to the ledger. The earlier version inserted
// reversing entries directly, bypassing post_ledger_entry, which meant it could
// produce negative balances — a thing the schema exists to make impossible
// (standing rule 2). That capability is gone: this script can only DELETE, and
// only in a database with no real accounts in it.
//
// The reversal pass existed to leave production history honest before removal.
// Against a disposable test database there is nothing to be honest about, so the
// justification for the capability disappeared with the need for it.
//
//   node scripts/clear-test-data.mjs            # dry run
//   node scripts/clear-test-data.mjs --apply    # delete

import { execSync } from 'node:child_process';
import { writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { REF_PRODUCTION } from './test-target.mjs';

const APPLY = process.argv.includes('--apply');

// ---------------------------------------------------------------------------
// Refuse production, before anything else happens
// ---------------------------------------------------------------------------

/**
 * Which project the CLI is linked to.
 *
 * Read from the file the CLI itself writes, so this reflects what a query would
 * actually hit rather than what any config claims. If it cannot be determined,
 * the script stops: an unknown target is treated as production.
 */
function refLie() {
  try {
    return readFileSync(
      path.join('supabase', '.temp', 'project-ref'),
      'utf8'
    ).trim() || null;
  } catch {
    return null;
  }
}

const ref = refLie();

if (!ref) {
  console.error('Cannot determine which project is linked. Refusing to run.');
  process.exit(1);
}

if (ref === REF_PRODUCTION) {
  console.error(
    [
      '',
      'REFUSING to run against PRODUCTION.',
      '',
      `  linked project : ${ref}`,
      '  reason         : this database holds real vendor and customer accounts,',
      '                   and this script only knows how to delete.',
      '',
      'There is no override. Link the test project first:',
      '  npx supabase link --project-ref <test-ref>',
      '',
    ].join('\n')
  );
  process.exit(1);
}

console.log(`linked project: ${ref} (not production)\n`);

// ---------------------------------------------------------------------------
// What counts as test data
// ---------------------------------------------------------------------------

// Matched on NAME, which the harness always controls. An earlier draft matched
// on phone-number pattern and silently kept four accounts from an older scheme,
// including a vendor named "Chez Awa (test)".
const VENDEURS_TEST = `(
  business_name like 'TEST-%'
  or business_name in ('Chez Awa', 'Chez Test', 'Chez SD', 'Boutique Test', 'Chez Awa (test)')
)`;

const CLIENTS_TEST = `(
  display_name like 'TEST-%'
  or display_name in ('Awa', 'Client Test', 'Client SD')
  or (
    display_name is null
    and not exists (
      select 1
      from ledger_entries e
      join vendors v2 on v2.id = e.vendor_id
      where e.customer_id = customers.id
        and v2.business_name not like 'TEST-%'
        and v2.business_name not in
          ('Chez Awa', 'Chez Test', 'Chez SD', 'Boutique Test', 'Chez Awa (test)')
    )
  )
)`;

/** Run one statement. Via a temp file: multi-line SQL as an argument gets split. */
function sql(requete) {
  const chemin = path.join(tmpdir(), `sika-clear-${randomUUID()}.sql`);
  writeFileSync(chemin, requete, 'utf8');
  try {
    const out = execSync(
      `npx --yes supabase@latest db query --linked --file "${chemin}"`,
      { encoding: 'utf8', maxBuffer: 1024 * 1024 * 32, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    const debut = out.indexOf('{');
    return debut < 0 ? [] : JSON.parse(out.slice(debut)).rows ?? [];
  } finally {
    try { unlinkSync(chemin); } catch { /* already gone */ }
  }
}

const nombre = (r) => Number(Object.values(r ?? {})[0] ?? 0);

console.log(APPLY ? '=== APPLYING ===\n' : '=== DRY RUN — nothing will change ===\n');

const [vendeurs] = sql(`select count(*) as n from vendors where ${VENDEURS_TEST}`);
const [clients] = sql(`select count(*) as n from customers where ${CLIENTS_TEST}`);
const [entrees] = sql(`
  select count(*) as n from ledger_entries e
  where e.vendor_id in (select id from vendors where ${VENDEURS_TEST})
     or e.customer_id in (select id from customers where ${CLIENTS_TEST})
`);

console.log(`test vendors   : ${nombre(vendeurs)}`);
console.log(`test customers : ${nombre(clients)}`);
console.log(`their entries  : ${nombre(entrees)}`);

const gardes = sql(`
  select 'vendor' as type, phone, business_name as nom from vendors where not ${VENDEURS_TEST}
  union all
  select 'customer', phone, coalesce(display_name, '-') from customers where not ${CLIENTS_TEST}
  order by 1, 2
`);
console.log(`\nnot matched (kept): ${gardes.length}`);
for (const r of gardes) console.log(`  ${r.type.padEnd(9)} ${r.phone}  ${r.nom}`);

if (nombre(vendeurs) === 0 && nombre(clients) === 0) {
  console.log('\nNothing to do.');
  process.exit(0);
}

if (!APPLY) {
  console.log('\nRe-run with --apply to delete.');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Delete. Children before parents, or the foreign keys refuse.
// ---------------------------------------------------------------------------
const etapes = [
  ['pending_debits', `delete from pending_debits
     where vendor_id in (select id from vendors where ${VENDEURS_TEST})
        or customer_id in (select id from customers where ${CLIENTS_TEST})`],
  ['vendor_customer_labels', `delete from vendor_customer_labels
     where vendor_id in (select id from vendors where ${VENDEURS_TEST})
        or customer_id in (select id from customers where ${CLIENTS_TEST})`],
  ['vendor_lookup_log', `delete from vendor_lookup_log
     where vendor_id in (select id from vendors where ${VENDEURS_TEST})`],
  ['ledger_entries (reversals first)', `delete from ledger_entries
     where reverses_entry_id is not null
       and (vendor_id in (select id from vendors where ${VENDEURS_TEST})
         or customer_id in (select id from customers where ${CLIENTS_TEST}))`],
  ['ledger_entries', `delete from ledger_entries
     where vendor_id in (select id from vendors where ${VENDEURS_TEST})
        or customer_id in (select id from customers where ${CLIENTS_TEST})`],
  ['pin_reset_grants', `delete from pin_reset_grants
     where target_vendor_id in (select id from vendors where ${VENDEURS_TEST})
        or target_customer_id in (select id from customers where ${CLIENTS_TEST})`],
  ['pin_reset_requests', `delete from pin_reset_requests
     where phone in (select phone from vendors where ${VENDEURS_TEST})
        or phone in (select phone from customers where ${CLIENTS_TEST})`],
  ['auth_attempts', `delete from auth_attempts
     where phone in (select phone from vendors where ${VENDEURS_TEST})
        or phone in (select phone from customers where ${CLIENTS_TEST})`],
  ['vendors', `delete from vendors where ${VENDEURS_TEST}`],
  ['customers', `delete from customers where ${CLIENTS_TEST}`],
];

for (const [nom, requete] of etapes) {
  sql(requete);
  console.log(`  cleared ${nom}`);
}

const [v] = sql('select count(*) as n from vendors');
const [c] = sql('select count(*) as n from customers');
console.log(`\nremaining: ${nombre(v)} vendor(s), ${nombre(c)} customer(s)`);
console.log(
  '\nAuth users are not removed here — see scripts/purge-auth-users.mjs.'
);
