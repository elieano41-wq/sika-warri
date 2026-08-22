// Which reads have no bound of their own?
//
// PostgREST caps rows at db-max-rows (1000 by default) for table reads AND for
// functions returning a table over rpc. A function with no limit does not return
// "all the rows" — it returns however many the platform decides to give, with no
// error and no marker. That is fine for a list nobody totals, and wrong for one
// that feeds a figure about money.
//
// This applies the migrations to PGlite (Postgres in WASM, no Docker) and asks
// the catalog which functions can return more than one row, then which of those
// have no limit in their body. Same question tests/25 asks; this is the version
// you can run by hand while deciding what to fix.
//
//   node scripts/audit-bounds.mjs

import { PGlite } from '@electric-sql/pglite';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const DIR = path.join(process.cwd(), 'supabase', 'migrations');
const db = await PGlite.create();

for (const file of (await readdir(DIR)).filter((f) => f.endsWith('.sql')).sort()) {
  try {
    await db.exec(await readFile(path.join(DIR, file), 'utf8'));
  } catch (err) {
    console.error(`FAIL ${file}: ${err.message}`);
    process.exit(1);
  }
}

const { rows } = await db.query(`
  select p.proname, p.pronargs, pg_get_functiondef(p.oid) as def
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proretset and p.prokind = 'f'
   order by p.proname
`);

console.log(`set-returning functions in public: ${rows.length}\n`);
for (const r of rows) {
  const borne = /\blimit\b/i.test(r.def);
  console.log(`${borne ? '  limit ' : 'NO LIMIT'}  ${r.proname}/${r.pronargs}`);
}

console.log(
  '\nNO LIMIT is not automatically a bug: a function that selects one row by a\n' +
    'unique key is bounded by the key. It IS a decision, and tests/25 requires\n' +
    'that decision to be recorded rather than assumed.'
);
