// Reading source in a test, without the test passing on nothing.
//
// ============================================================================
// THE BUG THIS EXISTS FOR. tests/32 extracted every error message from
// runtime.ts with one regex, got back an EMPTY LIST, and passed every check over
// it. "No message is empty" and "no message is in English" are both true of zero
// messages. The suite reported green while testing nothing at all.
//
// The cause was mundane: this repo is checked out on Windows, so sources are
// CRLF on disk, and in JavaScript `.` does not match `\r`. So `/^ {2}(SW\d{3}):
// (.*)$/` matched nothing — the `(.*)` stopped before the `\r` and the `$` could
// not follow. A pattern that works perfectly on LF silently matches zero lines
// on CRLF.
//
// The lesson is bigger than the bug. "The test passed" was carrying less weight
// than it looked like it was carrying, and no amount of care in writing the
// assertions would have revealed it — only asking "how many things did this
// actually check?".
// ============================================================================
//
// So every source-reading test goes through here:
//
//   lireSource()  — normalises line endings, so an anchored pattern behaves the
//                   same on any checkout
//   fichiersSource() — walks a tree and REFUSES to return an empty list
//   nonVide()     — the vacuity guard, for any collection an assertion loops over

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { expect } from 'vitest';

/**
 * Read a source file with line endings normalised to \n.
 *
 * Always use this rather than readFileSync in a test that matches patterns
 * against the result. A `$`-anchored or `.`-based pattern gives different
 * answers on CRLF and LF, and the difference is silent.
 */
export function lireSource(...segments: string[]): string {
  return readFileSync(path.join(...segments), 'utf8').replace(/\r\n/g, '\n');
}

/** Strip comments, so prose describing a rule does not satisfy a scan for it. */
export function sansCommentaires(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|--)/.test(l))
    .join('\n');
}

/**
 * Every file under `racine` matching `motif`.
 *
 * REFUSES to return an empty list. A test that scans "every screen" and finds no
 * screens has not proven anything about screens, and the assertion that follows
 * would pass. A wrong path, a moved directory or a tightened filter all land
 * here instead of silently downgrading the suite.
 */
export function fichiersSource(racine: string, motif = /\.(ts|tsx)$/): string[] {
  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((nom) => {
      const complet = path.join(dir, nom);
      return statSync(complet).isDirectory() ? walk(complet) : [complet];
    });
  }

  const trouves = walk(racine).filter((f) => motif.test(f));
  expect(
    trouves.length,
    `no files matched ${motif} under ${racine} — the scan below would prove nothing`
  ).toBeGreaterThan(0);
  return trouves;
}

/**
 * The vacuity guard.
 *
 * Wrap any collection an assertion is about to loop over, or derive a
 * `toEqual([])` from. Returns it unchanged when it has members, and fails with a
 * message naming what was being counted when it does not.
 *
 *   for (const m of nonVide(messages, 'error messages')) { ... }
 *   expect(nonVide(fichiers, 'screens').filter(mauvais)).toEqual([]);
 *
 * `minimum` is the smallest count that makes the test meaningful. Default 1;
 * pass a real floor where one is known, because "at least one" is a weak claim
 * about a scan that should find thirty.
 */
export function nonVide<T>(collection: T[], quoi: string, minimum = 1): T[] {
  expect(
    collection.length,
    `expected at least ${minimum} ${quoi} to check, found ${collection.length} — ` +
      'this assertion would pass without testing anything'
  ).toBeGreaterThanOrEqual(minimum);
  return collection;
}
