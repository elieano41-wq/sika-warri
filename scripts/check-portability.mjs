// Acceptance test 11, static half — no Supabase-specific dependency anywhere in
// the data layer.
//
// The dynamic half is the CI job itself: these same migrations apply to a stock
// postgres:15 container and the whole suite runs against it. This script catches
// the thing a passing suite would not — a dependency that happens to exist on
// both targets today but ties the ledger to Supabase tomorrow.
//
// The ledger must be restorable onto any stock Postgres 15+ from the migration
// files alone. Supabase Auth is the one accepted lock-in, and it is confined to
// the single branch in 0002.

import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, '..', 'supabase', 'migrations');

// 0002 is the sanctioned seam: it references auth.uid() inside a migration-time
// existence check, which is exactly how portability is achieved rather than
// broken. Every other file must be clean.
const AUTH_SEAM = '0002_identity.sql';

const FORBIDDEN = [
  {
    pattern: /\bauth\./gi,
    what: 'reference to the Supabase auth schema',
    exempt: (f) => f === AUTH_SEAM,
  },
  {
    pattern: /\bstorage\./gi,
    what: 'reference to the Supabase storage schema',
  },
  {
    pattern: /\bextensions\./gi,
    what: 'reference to the Supabase extensions schema',
  },
  {
    pattern: /\bgraphql\b|\bpg_graphql\b/gi,
    what: 'pg_graphql dependency',
  },
  {
    pattern: /\bsupabase_realtime\b|\brealtime\./gi,
    what: 'Supabase Realtime dependency',
  },
  {
    pattern: /create\s+extension/gi,
    what: 'CREATE EXTENSION (not guaranteed present on a stock instance)',
  },
  {
    pattern: /\bsupabase_admin\b|\bservice_role\b/gi,
    what: 'Supabase-managed role name',
  },
];

const files = (await readdir(DIR)).filter((f) => f.endsWith('.sql')).sort();
if (files.length === 0) throw new Error(`No migrations found in ${DIR}`);

const problems = [];

for (const file of files) {
  const raw = await readFile(path.join(DIR, file), 'utf8');

  // Strip -- comments so prose about Supabase does not trip the scan.
  const sql = raw
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');

  for (const rule of FORBIDDEN) {
    if (rule.exempt?.(file)) continue;
    const hits = sql.match(rule.pattern);
    if (hits) {
      problems.push(`${file}: ${rule.what} (${[...new Set(hits)].join(', ')})`);
    }
  }
}

if (problems.length > 0) {
  console.error('Data layer is not portable to stock Postgres:\n');
  for (const p of problems) console.error(`  - ${p}`);
  console.error(
    '\nThe ledger must restore onto any Postgres 15+ from these files alone.'
  );
  process.exit(1);
}

console.log(
  `Portability OK — ${files.length} migration(s) scanned, ` +
    `no Supabase dependency outside the ${AUTH_SEAM} seam.`
);
