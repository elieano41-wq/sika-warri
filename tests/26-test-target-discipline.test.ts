// Every script that writes to a live project must ask cible() where to write.
//
// WHY THIS EXISTS. scripts/test-target.mjs was written to stop automated runs
// filling the real vendor list. It works: it prefers .env.test.local and refuses
// production unless SIKA_ALLOW_PROD_TEST=1. It was wired into ui-e2e.mjs and
// clear-test-data.mjs — and not into e2e-live.mjs, which went on reading
// .env.local directly.
//
// So on 2026-08-22, while the suite whose whole purpose was to prove the test
// and production projects were separate was running, e2e:live registered four
// accounts and posted two ledger entries into PRODUCTION. The guard existed. The
// script simply never called it. Nothing failed, nothing warned, and the only
// clue was one "Project: https://bltiif..." line scrolled off the top of a long
// passing report.
//
// A guard that has to be remembered per-script is not a guard. This test asks
// the question of every script in the directory, so the next one to be added
// cannot quietly opt out.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const SCRIPTS = path.join(process.cwd(), 'scripts');

const fichiers = readdirSync(SCRIPTS).filter((f) => f.endsWith('.mjs'));

function source(nom: string): string {
  return readFileSync(path.join(SCRIPTS, nom), 'utf8');
}

/** Strip comments, so prose describing the rule does not satisfy it. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');
}

/**
 * The only two files allowed to read .env.local directly.
 *
 * test-target.mjs reads it to make the decision. whoami.mjs reads it to print
 * the decision. Neither writes anything anywhere.
 */
const LECTEURS_AUTORISES = ['test-target.mjs', 'whoami.mjs'];

describe('no script reaches for .env.local on its own', () => {
  it('only the target module and the reporter read it', () => {
    const coupables = fichiers
      .filter((f) => !LECTEURS_AUTORISES.includes(f))
      .filter((f) => /\.env\.local/.test(code(source(f))));

    expect(coupables).toEqual([]);
  });

  it('the two that may read it do not write to any project', () => {
    // Reading the file is only safe while these stay reporters. A fetch() or a
    // pg connection in either would make the exemption load-bearing in the wrong
    // direction.
    for (const f of LECTEURS_AUTORISES) {
      const src = code(source(f));
      expect(src, `${f} performs requests`).not.toMatch(/\bfetch\s*\(/);
      expect(src, `${f} opens a database connection`).not.toMatch(/new pg\.Client/);
    }
  });
});

describe('every script that writes to a live project goes through cible()', () => {
  // A script writes to a live project if it calls the REST API or the Edge
  // Functions over HTTP. Scripts that talk to Postgres directly are a separate
  // case: their target is a connection string given to them explicitly, which is
  // its own deliberate act (see make-admin.mjs).
  const ecrivains = fichiers.filter((f) => /\bfetch\s*\(/.test(code(source(f))));

  it('there is at least one such script, so this suite is not vacuous', () => {
    expect(ecrivains.length).toBeGreaterThan(0);
  });

  it.each(ecrivains)('%s imports cible from test-target', (nom) => {
    expect(code(source(nom))).toMatch(/from\s+'\.\/test-target\.mjs'/);
  });

  it.each(ecrivains)('%s actually calls cible()', (nom) => {
    // Importing it and then not using it would pass the check above.
    expect(code(source(nom))).toMatch(/\bcible\s*\(\s*\)/);
  });

  it.each(ecrivains)('%s prints its target before writing anything', (nom) => {
    // The standing instruction: at the start of every run, print which project
    // is being targeted. A target printed at the end is an autopsy.
    const src = code(source(nom));
    expect(src).toMatch(/afficherCible\s*\(\s*\)/);

    const positionAffichage = src.search(/afficherCible\s*\(\s*\)/);
    const positionPremierFetch = src.search(/\bfetch\s*\(/);
    expect(positionAffichage).toBeGreaterThan(-1);
    expect(positionAffichage).toBeLessThan(positionPremierFetch);
  });
});

describe('accounts an automated run creates are identifiable', () => {
  // Not merely unusual — filterable. The old numbers were timestamp-derived and
  // the old vendor was called "Chez Awa (test)", which reads as a test account to
  // a human looking closely and as a real shop to everything else. Four of them
  // survived a cleanup pass that matched on phone-number shape.
  const ecrivains = fichiers.filter((f) => /\bfetch\s*\(/.test(code(source(f))));

  it.each(ecrivains)('%s names accounts with the reserved prefix', (nom) => {
    const src = code(source(nom));
    // Either it registers accounts, in which case it must use the prefix, or it
    // does not register at all.
    if (/'register'/.test(src)) {
      expect(src).toMatch(/PREFIXE_TEST/);
    }
  });

  it.each(ecrivains)('%s uses the reserved phone block', (nom) => {
    const src = code(source(nom));
    if (/'register'/.test(src)) {
      expect(src).toMatch(/telephoneTest\s*\(/);
    }
  });

  it('no script hard-codes a phone number outside the reserved block for registration', () => {
    // Rejection cases legitimately use odd numbers — a non-mobile prefix has to
    // come from somewhere. Those are refused before a row exists. What must not
    // appear is a hard-coded number that a SUCCESSFUL registration would use,
    // which is what reverse-test-data.mjs did: two real production numbers and
    // their PINs, committed, pointed at .env.local.
    for (const f of fichiers) {
      const src = code(source(f));
      // A const holding a bare 10-digit Ivorian number, rather than a call to
      // telephoneTest().
      const durs = src.match(/const\s+\w*phone\w*\s*=\s*'0\d{9}'/gi) ?? [];
      expect(durs, `${f} hard-codes a live phone number`).toEqual([]);
    }
  });

  it('no script hard-codes a PIN alongside a hard-coded number', () => {
    // The specific stale-credential shape. PIN constants are fine — the harness
    // needs them — but not next to a committed live number.
    for (const f of fichiers) {
      const src = code(source(f));
      const aNumeroDur = /const\s+\w*phone\w*\s*=\s*'0\d{9}'/i.test(src);
      const aCodeDur = /const\s+\w*pin\w*\s*=\s*'\d{4,6}'/i.test(src);
      expect(aNumeroDur && aCodeDur, `${f} carries live credentials`).toBe(false);
    }
  });
});

describe('the stale single-use reversal script is gone', () => {
  it('reverse-test-data.mjs no longer exists', () => {
    // It hard-coded one past run's numbers and PINs, read .env.local, and so
    // pointed at production with credentials that no longer matched anything.
    // Undoing a run belongs to clear-test-data.mjs against a disposable project.
    expect(fichiers).not.toContain('reverse-test-data.mjs');
  });
});
