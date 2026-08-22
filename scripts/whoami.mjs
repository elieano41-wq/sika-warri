// Which project is everything pointing at?
//
// Printed at the start of every automated run and available on its own as
// `npm run target`. There should never be a moment of wondering which database
// a command is about to touch.

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { REF_PRODUCTION } from './test-target.mjs';

function refLie() {
  try {
    return readFileSync(path.join('supabase', '.temp', 'project-ref'), 'utf8').trim();
  } catch {
    return null;
  }
}

function urlDe(fichier) {
  if (!existsSync(fichier)) return null;
  const m = /^VITE_SUPABASE_URL=(.*)$/m.exec(readFileSync(fichier, 'utf8'));
  return m ? m[1].trim() : null;
}

export function afficherCible() {
  const lie = refLie();
  const test = urlDe('.env.test.local');
  const prod = urlDe('.env.local');

  const etiquette = (ref) =>
    !ref ? 'unknown' : ref === REF_PRODUCTION ? 'PRODUCTION' : 'test';

  const lignes = [
    '┌─ target ─────────────────────────────────────────────',
    `│ supabase CLI linked : ${lie ?? '(none)'}  [${etiquette(lie)}]`,
    `│ automated suites    : ${test ? test + '  [test]' : '(no .env.test.local — production would be REFUSED)'}`,
    `│ app build uses      : ${prod ?? '(none)'}  [${etiquette(prod?.match(/\/\/([a-z0-9]+)\./)?.[1] ?? null)}]`,
    '└──────────────────────────────────────────────────────',
  ];
  console.log(lignes.join('\n'));
}

// Run directly: node scripts/whoami.mjs
//
// Compared by basename rather than by rebuilding a file:// URL — on Windows the
// path separators differ between import.meta.url and process.argv[1], and
// escaping them through a shell heredoc is its own small trap.
if (path.basename(process.argv[1] ?? '') === 'whoami.mjs') {
  afficherCible();
}
