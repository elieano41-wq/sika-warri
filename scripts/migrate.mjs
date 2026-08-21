// Applies supabase/migrations/*.sql in filename order.
//
// Deliberately plain node + pg rather than the Supabase CLI: acceptance test 11
// requires these migrations to apply to a bare Postgres 15 with no Supabase
// tooling present, and the same script is what CI points at a stock container.

import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(HERE, '..', 'supabase', 'migrations');

// Standing rule 6: fail loudly, naming exactly what is missing.
const url = process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL;
if (!url) {
  throw new Error(
    'Missing database connection string. Set DATABASE_URL (CI) or ' +
      'SUPABASE_DB_URL (local). No default is assumed.'
  );
}

const client = new pg.Client({ connectionString: url });
await client.connect();

await client.query(`
  create table if not exists public.schema_migrations (
    filename    text primary key,
    applied_at  timestamptz not null default now()
  )
`);

const { rows: applied } = await client.query(
  'select filename from public.schema_migrations'
);
const seen = new Set(applied.map((r) => r.filename));

const files = (await readdir(MIGRATIONS_DIR))
  .filter((f) => f.endsWith('.sql'))
  .sort();

if (files.length === 0) {
  throw new Error(`No .sql files found in ${MIGRATIONS_DIR}`);
}

let count = 0;
for (const file of files) {
  if (seen.has(file)) {
    console.log(`  skip  ${file}`);
    continue;
  }

  const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');

  // Each migration is one transaction: a failure leaves nothing half-applied.
  try {
    await client.query('begin');
    await client.query(sql);
    await client.query(
      'insert into public.schema_migrations (filename) values ($1)',
      [file]
    );
    await client.query('commit');
    console.log(`  apply ${file}`);
    count += 1;
  } catch (err) {
    await client.query('rollback');
    console.error(`\nFAILED applying ${file}\n${err.message}`);
    if (err.position) console.error(`  at character position ${err.position}`);
    if (err.detail) console.error(`  detail: ${err.detail}`);
    if (err.hint) console.error(`  hint: ${err.hint}`);
    await client.end();
    process.exit(1);
  }
}

console.log(`\n${count} migration(s) applied, ${files.length - count} already current.`);
await client.end();
