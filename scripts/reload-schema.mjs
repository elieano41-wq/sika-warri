// Tell PostgREST its schema changed.
//
// THE FAILURE THIS PREVENTS. PostgREST caches the schema it exposes over HTTP. A
// migration that adds or changes a function is live in SQL immediately and can
// still 404 from the app — PGRST202, "Could not find the function ... in the
// schema cache". The database is right, the API is stale, and the only symptom
// is a screen where nothing loaded and no error appears anywhere useful.
//
// WHY THIS FILE EXISTS SEPARATELY FROM migrate.mjs. There are two ways schema
// reaches a database here, and only one of them is migrate.mjs:
//
//   npm run migrate     — CI, against a stock Postgres container. No PostgREST
//                         is running there, so the notify is a no-op.
//   supabase db push    — test and PRODUCTION, through the CLI. This is the path
//                         that actually needs the reload, and it is not ours.
//
// So folding the notify into migrate.mjs alone would have put it exactly where it
// was never needed. `npm run db:push` does both in order.
//
//   node scripts/reload-schema.mjs

import { execSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { REF_PRODUCTION } from './test-target.mjs';

function refLie() {
  try {
    return readFileSync(path.join('supabase', '.temp', 'project-ref'), 'utf8').trim();
  } catch {
    return null;
  }
}

const ref = refLie();
if (!ref) {
  console.error('No linked project. Run: npx supabase link --project-ref <ref>');
  process.exit(1);
}

console.log(
  `PostgREST schema reload -> ${ref}${ref === REF_PRODUCTION ? '  [PRODUCTION]' : '  [test]'}`
);

// Through a file rather than argv: on Windows, passing SQL as a shell argument
// word-splits on the spaces, which is how this repo learned to route every
// statement through --file.
const fichier = path.join('supabase', `.reload-${randomBytes(4).toString('hex')}.sql`);
writeFileSync(fichier, "notify pgrst, 'reload schema';\n", 'utf8');

try {
  execSync(`npx supabase db query --linked --file "${fichier}"`, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  console.log('  reload requested.');
} catch (err) {
  // Not fatal: the migrations are already applied and committed. PostgREST
  // reloads on its own eventually, and saying so beats failing a deploy that
  // succeeded.
  console.error(`  could not notify PostgREST: ${String(err.message).slice(0, 200)}`);
  console.error("  run by hand if the app reports a missing function:");
  console.error("    notify pgrst, 'reload schema';");
  process.exitCode = 0;
} finally {
  rmSync(fichier, { force: true });
}
