// Every error a real user can reach says something useful, in French.
//
// ============================================================================
// THE BUG THIS CAUGHT. The debt register introduced fifteen error codes,
// SW018–SW032, and mapped none of them. Every one fell through to
//
//     "Une erreur est survenue, réessayez"
//
// Nine were reachable by a vendor standing at a counter: the 10 000 F debt cap,
// the rate limit, a repayment larger than the debt, an offset larger than either
// balance. So a vendor hitting the ceiling was told nothing about a ceiling, and
// had no way to work out what to change. They would tap again, get the same
// thing, and conclude the app was broken — which is the outcome that ends with
// them going back to the paper carnet.
//
// The data layer knew exactly what was wrong every time. The message just never
// carried it.
// ============================================================================
//
// This test reads the codes the MIGRATIONS raise and requires each to have a
// message, so a new SQLSTATE cannot ship mute. Nothing here is a list someone
// has to remember to update.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { sansCommentaires } from './helpers/source';

const MIGRATIONS = path.join(process.cwd(), 'supabase', 'migrations');
const RUNTIME = path.join(
  process.cwd(), 'supabase', 'functions', '_runtime', 'runtime.ts'
);

/**
 * Read with line endings normalised.
 *
 * This repo is checked out on Windows, so sources are CRLF on disk. In
 * JavaScript `.` does not match `\r`, so any `$`-anchored line pattern silently
 * matches NOTHING against a CRLF file — which is exactly what happened here:
 * the extraction below returned an empty list and every check over it passed
 * without testing anything. The vacuity guard caught it; the regex would not
 * have.
 */
function lire(p: string): string {
  return readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
}

const runtime = lire(RUNTIME);

/** Every SW code raised anywhere in the data layer. */
function codesLeves(): string[] {
  const trouves = new Set<string>();
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql'))) {
    const sql = lire(path.join(MIGRATIONS, f));
    for (const m of sql.matchAll(/errcode\s*=\s*'(SW\d{3})'/g)) {
      trouves.add(m[1]!);
    }
  }
  return [...trouves].sort();
}

/** Every SW code the runtime can turn into a French sentence. */
function codesMappes(): string[] {
  const bloc = /const SQLSTATE_MESSAGES[\s\S]*?\n\};/.exec(runtime);
  expect(bloc, 'SQLSTATE_MESSAGES not found').not.toBeNull();
  return [...bloc![0].matchAll(/^\s{2}(SW\d{3}):/gm)].map((m) => m[1]!).sort();
}

describe('every raised error code has a French message', () => {
  it('nothing the database raises falls through to the generic fallback', () => {
    const leves = codesLeves();
    const mappes = codesMappes();

    expect(leves.length).toBeGreaterThan(20);

    const muets = leves.filter((c) => !mappes.includes(c));
    // The failure message names the codes, so a developer adding SW033 without a
    // message is told which one rather than that "a test failed".
    expect(muets, `raised but not mapped: ${muets.join(', ')}`).toEqual([]);
  });

  it('no message is mapped for a code nothing raises', () => {
    // A stale entry is not harmful, but it means the map has drifted from the
    // data layer and the next reader cannot trust it.
    const leves = codesLeves();
    const orphelins = codesMappes().filter((c) => !leves.includes(c));
    expect(orphelins, `mapped but never raised: ${orphelins.join(', ')}`).toEqual([]);
  });
});

describe('the messages are usable by the person reading them', () => {
  const bloc = /const SQLSTATE_MESSAGES[\s\S]*?\n\};/.exec(runtime)![0];

  /**
   * Each code with its message text.
   *
   * Walked line by line rather than matched with one regex: entries span several
   * lines and join literals with +, and a single pattern covering both shapes
   * matched NOTHING on the first attempt — which would have made every check
   * below pass against an empty list. That is what the vacuity guard is for.
   */
  const messages: Array<[string, string]> = (() => {
    const sorties: Array<[string, string]> = [];
    let code: string | null = null;
    let morceaux: string[] = [];

    const vider = () => {
      if (code !== null) {
        sorties.push([code, morceaux.join(' ').replace(/\s+/g, ' ').trim()]);
      }
      code = null;
      morceaux = [];
    };

    const litteraux = (ligne: string): string[] =>
      (ligne.match(/"[^"]*"/g) ?? []).map((x) => x.slice(1, -1));

    for (const ligne of bloc.split('\n')) {
      const debut = /^ {2}(SW\d{3}):(.*)$/.exec(ligne);
      if (debut) {
        vider();
        code = debut[1]!;
        morceaux = litteraux(debut[2]!);
        continue;
      }
      if (code !== null) {
        const suite = litteraux(ligne);
        if (suite.length > 0) morceaux.push(...suite);
      }
    }
    vider();

    return sorties.filter(([, t]) => t.length > 0);
  })();

  it('found them all, so the checks below are not vacuous', () => {
    expect(messages.length).toBeGreaterThanOrEqual(30);
  });

  it.each(messages)('%s is not empty and not the generic fallback', (_c, texte) => {
    expect(texte.length).toBeGreaterThan(10);
    expect(texte).not.toMatch(/Une erreur est survenue/);
  });

  it.each(messages)('%s is in French, not English', (_c, texte) => {
    // A stray English string is the shape a hurried addition takes. Checked
    // against words that would only appear in one.
    expect(texte).not.toMatch(/\b(error|failed|invalid|forbidden|denied|please try)\b/i);
  });

  it.each(messages)('%s uses none of the forbidden words', (_c, texte) => {
    // The copy rules apply to error messages too — they are the sentences a user
    // reads most carefully, because something has just gone wrong.
    expect(texte).not.toMatch(/portefeuille/i);
    expect(texte).not.toMatch(/\bsolde\b/i);
    expect(texte).not.toMatch(/crédit/i);
    expect(texte).not.toMatch(/\bprêts?\b/i);
    expect(texte).not.toMatch(/intérêts?\b/i);
  });

  it('the codes a vendor meets at a counter say what to DO', () => {
    // The distinction that matters. "Plafond atteint" is a fact about the
    // system; "encaissez une partie d'abord" is an instruction. These five are
    // the ones a vendor hits with a customer waiting.
    const AVEC_ACTION = ['SW005', 'SW006', 'SW020', 'SW021', 'SW026', 'SW028'];
    const trouve = new Map(messages);

    for (const code of AVEC_ACTION) {
      const texte = trouve.get(code);
      expect(texte, `${code} has no message`).toBeTruthy();
      // An imperative, a suggestion, or a named next step — something beyond a
      // statement of the refusal.
      expect(
        /vérifiez|encaissez|attendez|demandez|réglez|utilisez|choisissez|contactez|il faut|avant d/i.test(
          texte!
        ),
        `${code} states a refusal without saying what to do: "${texte}"`
      ).toBe(true);
    }
  });
});

describe('the client fallback is a last resort, not a habit', () => {
  it('api.ts has exactly one generic message', () => {
    // Comments stripped first. This guard fired on a comment that QUOTED the
    // message while explaining a bug caused by showing it — counting prose as a
    // second fallback, and pushing the next person to describe the problem
    // vaguely rather than name it. The rule is about what the app can display.
    const api = sansCommentaires(lire(path.join(process.cwd(), 'src', 'lib', 'api.ts')));
    const n = (api.match(/Une erreur est survenue/g) ?? []).length;
    // One, on the HTTP path where the server said nothing usable at all.
    expect(n).toBe(1);
  });

  it('the offline message is distinct from the generic one', () => {
    // "Pas de connexion" is actionable — check your network. Collapsing it into
    // the generic message would lose the only error a user can actually fix.
    const api = lire(path.join(process.cwd(), 'src', 'lib', 'api.ts'));
    expect(api).toMatch(/Pas de connexion/);
    expect(api).toMatch(/OFFLINE/);
  });

  it('no screen writes its own generic error', () => {
    const SRC = path.join(process.cwd(), 'src', 'screens');
    function walk(d: string): string[] {
      return readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]
      );
    }
    for (const f of walk(SRC)) {
      const src = lire(f);
      expect(src, `${path.relative(process.cwd(), f)}`).not.toMatch(
        /Une erreur est survenue/
      );
    }
  });
});
