// Clear automated-test accounts out of a database.
//
// READ THIS BEFORE RUNNING IT. It reverses ledger entries where reversal works
// and DELETES rows where it does not. Deleting ledger rows is the thing the
// schema is deliberately built to resist, so this exists as a named, readable,
// one-off — not as a helper anything else calls.
//
// Two passes, in this order:
//
//   1. REVERSE. Every credit still standing gets a reversing entry, exactly as
//      a vendor correction would. The history stays intact and readable, and the
//      balance goes to zero. This is the honest way to neutralise a balance.
//
//   2. DELETE. Only then are the test rows removed, entries included. Reversal
//      cannot un-create a row, and leaving 91 zeroed accounts in the vendor list
//      would make it unusable — which is its own kind of failure.
//
// It refuses to touch anything that does not match the test-account patterns
// below, and prints exactly what it will do before doing it.
//
//   node scripts/clear-test-data.mjs            # dry run, changes nothing
//   node scripts/clear-test-data.mjs --apply    # actually do it

import { execSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const APPLY = process.argv.includes('--apply');

/**
 * What counts as test data.
 *
 * Deliberately narrow and name-based. The automated harness always registers
 * vendors as "Chez Awa"/"Chez Test"/"Chez SD"/"Boutique Test"/"Chez Awa (test)"
 * and customers as "Awa"/"Client Test"/"Client SD" or with no name at all,
 * always on numbers ending 11/22/33 or the 0700000001/0500000002 pair.
 *
 * Anything else is treated as real and left alone. A false negative here means
 * leaving junk behind, which is recoverable; a false positive means deleting a
 * real vendor's ledger, which is not.
 */
// Matched on NAME, not on a phone pattern.
//
// The first attempt required the number to end 11/22/33, which is what the
// harness generates now — and it silently kept four accounts from an earlier run
// whose numbers end 00/99, including a vendor literally called "Chez Awa (test)".
// A pattern that has to track every scheme the harness has ever used will keep
// missing rows. The names are unambiguous and were never chosen by a real user.
const VENDEURS_TEST = `(
  business_name like 'TEST-%'
  or business_name in ('Chez Awa', 'Chez Test', 'Chez SD', 'Boutique Test', 'Chez Awa (test)')
)`;

// Named test customers, plus UNNAMED ones — but only where they have never dealt
// with a vendor outside the test set. An unnamed customer who transacted with a
// real shop is a real customer with a blank name, and is kept.
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

/**
 * Run one statement against the linked project.
 *
 * Via a temp FILE rather than an argument. Passing multi-line SQL as a shell
 * argument gets word-split — "count(*) as n from vendors" arrives as seven
 * positional arguments and the CLI rejects it. A file has no quoting rules to
 * get wrong.
 */
function sql(requete) {
  const chemin = path.join(tmpdir(), `sika-clear-${randomUUID()}.sql`);
  writeFileSync(chemin, requete, 'utf8');
  try {
    // A shell string, with only the file path as an argument. Safe to quote
    // because the path is generated here and contains no spaces; the SQL itself
    // never touches the command line.
    const out = execSync(
      `npx --yes supabase@latest db query --linked --file "${chemin}"`,
      { encoding: 'utf8', maxBuffer: 1024 * 1024 * 32, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    const debut = out.indexOf('{');
    if (debut < 0) return [];
    return JSON.parse(out.slice(debut)).rows ?? [];
  } finally {
    try { unlinkSync(chemin); } catch { /* already gone */ }
  }
}

const nombre = (r) => Number(Object.values(r)[0] ?? 0);

console.log(APPLY ? '=== APPLYING ===\n' : '=== DRY RUN — nothing will change ===\n');

// ---------------------------------------------------------------------------
// What is in scope
// ---------------------------------------------------------------------------

const [vendeurs] = sql(`select count(*) as n from vendors where ${VENDEURS_TEST}`);
const [clients] = sql(`select count(*) as n from customers where ${CLIENTS_TEST}`);
const [entrees] = sql(`
  select count(*) as n from ledger_entries e
  where e.vendor_id in (select id from vendors where ${VENDEURS_TEST})
     or e.customer_id in (select id from customers where ${CLIENTS_TEST})
`);
const [reels] = sql(`
  select (select count(*) from vendors where not ${VENDEURS_TEST})
       + (select count(*) from customers where not ${CLIENTS_TEST}) as n
`);

console.log(`test vendors      : ${nombre(vendeurs)}`);
console.log(`test customers    : ${nombre(clients)}`);
console.log(`their entries     : ${nombre(entrees)}`);
console.log(`REAL accounts kept: ${nombre(reels)}`);

// Name the real accounts explicitly, so it is obvious nothing wanted is going.
const gardes = sql(`
  select 'vendor' as type, phone, business_name as nom from vendors where not ${VENDEURS_TEST}
  union all
  select 'customer', phone, coalesce(display_name, '-') from customers where not ${CLIENTS_TEST}
  order by 1, 2
`);
console.log('\nkept:');
for (const r of gardes) console.log(`  ${r.type.padEnd(9)} ${r.phone}  ${r.nom}`);

if (nombre(vendeurs) === 0 && nombre(clients) === 0) {
  console.log('\nNothing to do.');
  process.exit(0);
}

if (!APPLY) {
  console.log('\nRe-run with --apply to reverse and remove the test rows.');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Pass 1 — reverse standing balances, the way a vendor correction would
// ---------------------------------------------------------------------------
console.log('\n--- pass 1: reversing standing credits ---');

// One reversing debit per un-reversed credit, matching amount and opposite
// direction, marked vendor_correction. Written directly rather than through
// post_ledger_entry because that enforces a 15-minute window these entries are
// long past — the point here is to leave an honest history, not to pretend a
// vendor did it at the till.
const renverses = sql(`
  with cibles as (
    select e.*
    from ledger_entries e
    where e.direction = 'credit'
      and e.kind = 'change'
      and not exists (select 1 from ledger_entries r where r.reverses_entry_id = e.id)
      and (e.vendor_id in (select id from vendors where ${VENDEURS_TEST})
        or e.customer_id in (select id from customers where ${CLIENTS_TEST}))
  ),
  inserees as (
    insert into ledger_entries (
      vendor_id, customer_id, direction, kind, amount_cfa, idempotency_key,
      reverses_entry_id, note, confirmation_method, created_by
    )
    select
      c.vendor_id, c.customer_id, 'debit', 'reversal', c.amount_cfa,
      'cleanup-' || c.id, c.id, 'annulation des données de test',
      'vendor_correction', c.created_by
    from cibles c
    returning 1
  )
  select count(*) as n from inserees
`);
console.log(`  reversed: ${nombre(renverses[0] ?? { n: 0 })}`);

const [restant] = sql(`
  select coalesce(sum(solde), 0) as n from (
    select sum(case when direction='credit' then amount_cfa else -amount_cfa end) as solde
    from ledger_entries
    where vendor_id in (select id from vendors where ${VENDEURS_TEST})
    group by vendor_id, customer_id
  ) s
`);
console.log(`  remaining balance across test accounts: ${nombre(restant)} F`);

// ---------------------------------------------------------------------------
// Pass 2 — remove the rows
// ---------------------------------------------------------------------------
console.log('\n--- pass 2: removing test rows ---');

// Order matters: children before parents, or the foreign keys refuse.
const etapes = [
  ['pending_debits', `
    delete from pending_debits
     where vendor_id in (select id from vendors where ${VENDEURS_TEST})
        or customer_id in (select id from customers where ${CLIENTS_TEST})`],
  ['vendor_customer_labels', `
    delete from vendor_customer_labels
     where vendor_id in (select id from vendors where ${VENDEURS_TEST})
        or customer_id in (select id from customers where ${CLIENTS_TEST})`],
  ['vendor_lookup_log', `
    delete from vendor_lookup_log
     where vendor_id in (select id from vendors where ${VENDEURS_TEST})`],
  // Reversals reference the entries they reverse, so they go first.
  ['ledger_entries (reversals)', `
    delete from ledger_entries
     where reverses_entry_id is not null
       and (vendor_id in (select id from vendors where ${VENDEURS_TEST})
         or customer_id in (select id from customers where ${CLIENTS_TEST}))`],
  ['ledger_entries', `
    delete from ledger_entries
     where vendor_id in (select id from vendors where ${VENDEURS_TEST})
        or customer_id in (select id from customers where ${CLIENTS_TEST})`],
  ['pin_reset_grants', `
    delete from pin_reset_grants
     where target_vendor_id in (select id from vendors where ${VENDEURS_TEST})
        or target_customer_id in (select id from customers where ${CLIENTS_TEST})`],
  ['pin_reset_requests', `
    delete from pin_reset_requests
     where phone in (select phone from vendors where ${VENDEURS_TEST})
        or phone in (select phone from customers where ${CLIENTS_TEST})`],
  ['auth_attempts', `
    delete from auth_attempts
     where phone in (select phone from vendors where ${VENDEURS_TEST})
        or phone in (select phone from customers where ${CLIENTS_TEST})`],
  ['vendors', `delete from vendors where ${VENDEURS_TEST}`],
  ['customers', `delete from customers where ${CLIENTS_TEST}`],
];

for (const [nom, requete] of etapes) {
  sql(requete);
  console.log(`  cleared ${nom}`);
}

const [apresV] = sql('select count(*) as n from vendors');
const [apresC] = sql('select count(*) as n from customers');
console.log(`\nremaining: ${nombre(apresV)} vendor(s), ${nombre(apresC)} customer(s)`);
console.log(
  '\nNOTE: the Supabase Auth users behind these accounts are NOT deleted — that ' +
  'needs the admin API, not SQL. They are orphaned and harmless: no profile row ' +
  'means no login. Say the word and I will remove them too.'
);
