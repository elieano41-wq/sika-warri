// Local smoke test: do the migrations actually parse and apply?
//
// PGlite is Postgres compiled to WASM. It is NOT a substitute for the CI job —
// single connection (so no concurrency test), and it runs as a lone superuser
// (so RLS cannot be exercised). What it does give, with no Docker, is a real
// Postgres parser and planner: syntax errors, bad dollar quoting, missing
// functions, and broken constraints all surface here instead of in CI.

import { PGlite } from '@electric-sql/pglite';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const DIR = path.join(process.cwd(), 'supabase', 'migrations');
const db = await PGlite.create();

const { rows: ver } = await db.query('show server_version');
console.log('PGlite server_version:', ver[0].server_version);

const files = (await readdir(DIR)).filter((f) => f.endsWith('.sql')).sort();
let failed = false;

for (const file of files) {
  const sql = await readFile(path.join(DIR, file), 'utf8');
  try {
    await db.exec(sql);
    console.log(`  ok    ${file}`);
  } catch (err) {
    failed = true;
    console.error(`  FAIL  ${file}`);
    console.error(`        ${err.message}`);
    if (err.position) console.error(`        position ${err.position}`);
    break;
  }
}

if (failed) process.exit(1);

console.log('\n--- functional smoke (single superuser, no RLS) ---');

async function one(sql, params) {
  const { rows } = await db.query(sql, params);
  return rows[0];
}

const vendor = await one(
  `insert into vendors (auth_user_id, phone, business_name, quartier,
                        max_balance_per_customer, terms_accepted_at, terms_version)
   values (gen_random_uuid(), '2250700000001', 'Chez Awa', 'Yopougon', 3000, now(), 'v1')
   returning id, auth_user_id`
);
const customer = await one(
  `insert into customers (auth_user_id, phone) values (gen_random_uuid(), '2250700000002')
   returning id`
);

// A credit should succeed.
const credit = await one(
  `select * from post_ledger_entry($1,$2,'credit','change',500,'k1',$3,false,null,null)`,
  [vendor.id, customer.id, vendor.auth_user_id]
);
console.log('credit 500 ->', credit.amount_cfa, credit.direction);

// Replay must return the same row.
const replay = await one(
  `select * from post_ledger_entry($1,$2,'credit','change',500,'k1',$3,false,null,null)`,
  [vendor.id, customer.id, vendor.auth_user_id]
);
console.log('replay same id:', replay.id === credit.id);

// Unconfirmed debit must be refused (amendment D).
try {
  await one(
    `select * from post_ledger_entry($1,$2,'debit','refund',500,'k2',$3,false,null,null)`,
    [vendor.id, customer.id, vendor.auth_user_id]
  );
  console.log('unconfirmed refund: NOT REFUSED  <-- BUG');
} catch (e) {
  console.log('unconfirmed refund refused:', e.message);
}

// Confirmed debit must pass.
const debit = await one(
  `select * from post_ledger_entry($1,$2,'debit','purchase',200,'k3',$3,true,null,null)`,
  [vendor.id, customer.id, vendor.auth_user_id]
);
console.log('confirmed debit 200 ->', debit.amount_cfa, 'confirmed_at set:', debit.customer_confirmed_at !== null);

// Over-balance debit must be refused.
try {
  await one(
    `select * from post_ledger_entry($1,$2,'debit','purchase',9999,'k4',$3,true,null,null)`,
    [vendor.id, customer.id, vendor.auth_user_id]
  );
  console.log('over-balance debit: NOT REFUSED  <-- BUG');
} catch (e) {
  console.log('over-balance debit refused:', e.message);
}

// Cap must be refused.
try {
  await one(
    `select * from post_ledger_entry($1,$2,'credit','change',5000,'k5',$3,false,null,null)`,
    [vendor.id, customer.id, vendor.auth_user_id]
  );
  console.log('cap breach: NOT REFUSED  <-- BUG');
} catch (e) {
  console.log('cap breach refused:', e.message);
}

// Wrong actor must be refused (amendment C).
try {
  await one(
    `select * from post_ledger_entry($1,$2,'credit','change',100,'k6',gen_random_uuid(),false,null,null)`,
    [vendor.id, customer.id]
  );
  console.log('wrong actor: NOT REFUSED  <-- BUG');
} catch (e) {
  console.log('wrong actor refused:', e.message);
}

const bal = await one(
  `select balance_cfa from v_balances where vendor_id=$1 and customer_id=$2`,
  [vendor.id, customer.id]
);
console.log('final balance (expect 300):', bal.balance_cfa);

const rc = await one(`select entry_receipt_code($1) as code`, [credit.id]);
console.log('receipt code:', rc.code, /^\d{4}$/.test(rc.code) ? '(4 digits ok)' : '<-- BUG');

const backend = await one('select app_identity_backend() as b');
console.log('identity backend:', backend.b);

console.log('\nsmoke complete');
