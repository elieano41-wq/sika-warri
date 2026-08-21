// Copy rules (spec section 6) and amount formatting (section 7).
//
// The copy rules are not style preferences. "Portefeuille", "solde Sika Warri"
// and "dépôt" all assert that Sika Warri holds money. It does not, and saying
// so would misdescribe the product to the person least able to check.
//
// The amount formatting is a legibility requirement with a real failure mode: a
// vendor reading 2500 as 25000 across a stall in glare hands over ten times the
// change.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  formatCfa, formatCfaDigits, groupDigits, appendDigit, removeDigit,
  formatPhoneLocal, formatCountdown, MONTANT_MAX, ESPACE,
} from '../src/lib/format';

const SRC = path.join(process.cwd(), 'src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const sourceFiles = walk(SRC).filter((f) => /\.(ts|tsx|css)$/.test(f));

/** Strip comments: the code documents the forbidden words in order to ban them. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');
}

/**
 * Collapse whitespace before matching user-facing copy.
 *
 * JSX wraps text wherever the line length demands, so "Ne demandez jamais son
 * code" can be split across two lines with arbitrary indentation between the
 * words. A copy assertion must survive reformatting — otherwise it fails on a
 * change that alters nothing the user sees, and someone eventually deletes it.
 */
function copy(src: string): string {
  return code(src).replace(/\s+/g, ' ');
}

// ---------------------------------------------------------------------------
// Copy rules
// ---------------------------------------------------------------------------

describe('copy rules — section 6', () => {
  const INTERDITS: Array<[RegExp, string]> = [
    [/portefeuille/i, 'implies a wallet Sika Warri holds'],
    [/\bsolde\b/i, 'implies a balance held by Sika Warri'],
    [/\bd[ée]p[ôo]t\b/i, 'implies funds were deposited with Sika Warri'],
    [/recharger/i, 'implies topping up an account'],
    [/votre argent chez nous/i, 'states outright that Sika Warri holds funds'],
  ];

  it.each(INTERDITS)('never uses %s (%s)', (pattern) => {
    const offenders = sourceFiles
      .filter((f) => pattern.test(code(readFileSync(f, 'utf8'))))
      .map((f) => path.relative(process.cwd(), f));

    expect(offenders).toEqual([]);
  });

  it('uses the sanctioned wording instead', () => {
    // The replacements the spec prescribes. Their presence is the positive half
    // of the rule: banning words is not the same as saying the right thing.
    const all = sourceFiles.map((f) => readFileSync(f, 'utf8')).join('\n');
    expect(all).toMatch(/monnaie gard[ée]e/i);
    expect(all).toMatch(/utiliser la monnaie/i);
    expect(all).toMatch(/votre monnaie/i);
  });

  it('states plainly that the money stays with the vendor', () => {
    const all = sourceFiles.map((f) => readFileSync(f, 'utf8')).join('\n');
    // The vendor home carries the substance of the disclosure. The verbatim
    // legal text belongs in /conditions and onboarding, neither built yet.
    expect(all).toMatch(/reste chez (vous|le commer[çc]ant)/i);
  });

  it('tells the customer never to hand over their code', () => {
    const client = copy(readFileSync(
      path.join(SRC, 'screens', 'client', 'Confirmation.tsx'), 'utf8'
    ));
    // Amendment H only holds if the customer knows the rule. The screen that
    // takes the PIN is where to say it.
    expect(client).toMatch(/ne le donnez jamais/i);
  });

  it('warns the vendor not to ask for the code', () => {
    const vendeur = copy(readFileSync(
      path.join(SRC, 'screens', 'vendeur', 'UtiliserLaMonnaie.tsx'), 'utf8'
    ));
    expect(vendeur).toMatch(/ne demandez jamais son code/i);
  });

  it('uses the exact offline wording from section 8', () => {
    const vendeur = copy(readFileSync(
      path.join(SRC, 'screens', 'vendeur', 'UtiliserLaMonnaie.tsx'), 'utf8'
    ));
    expect(vendeur).toContain('Connexion requise pour utiliser la monnaie');
  });
});

// ---------------------------------------------------------------------------
// Amounts
// ---------------------------------------------------------------------------

describe('amount formatting — section 7', () => {
  it('groups thousands with a space and suffixes F', () => {
    expect(formatCfa(2500)).toBe(`2${ESPACE}500${ESPACE}F`);
    expect(formatCfa(500)).toBe(`500${ESPACE}F`);
    expect(formatCfa(0)).toBe(`0${ESPACE}F`);
    expect(formatCfa(1000000)).toBe(`1${ESPACE}000${ESPACE}000${ESPACE}F`);
  });

  it('uses a NON-BREAKING space, so an amount never splits across lines', () => {
    // "2 500 F" broken after the 2 reads as two different numbers at a glance.
    expect(ESPACE).toBe(' ');
    expect(formatCfa(2500)).not.toContain(' '); // no plain space anywhere
  });

  it('groups from the right, not the left', () => {
    expect(groupDigits(1)).toBe('1');
    expect(groupDigits(12)).toBe('12');
    expect(groupDigits(123)).toBe('123');
    expect(groupDigits(1234)).toBe(`1${ESPACE}234`);
    expect(groupDigits(12345)).toBe(`12${ESPACE}345`);
    expect(groupDigits(123456)).toBe(`123${ESPACE}456`);
    expect(groupDigits(1234567)).toBe(`1${ESPACE}234${ESPACE}567`);
  });

  it('keeps digits separate from the suffix for independent sizing', () => {
    // The F is rendered at half size; at 4.5rem it would otherwise dominate the
    // digits, which are the part being read.
    expect(formatCfaDigits(2500)).toBe(`2${ESPACE}500`);
    expect(formatCfaDigits(2500)).not.toContain('F');
  });

  it('shows a negative rather than hiding it', () => {
    // The ledger cannot produce one (standing rule 2). If one reaches a screen
    // it is a bug worth seeing, not something to launder through Math.abs.
    expect(formatCfa(-500)).toBe(`-500${ESPACE}F`);
  });

  it('never emits a decimal separator', () => {
    // Integer FCFA only (standing rule 5). No centimes exist.
    for (const v of [0, 1, 999, 1000, 12345, 999999]) {
      expect(formatCfa(v)).not.toMatch(/[.,]/);
    }
  });
});

describe('keypad input', () => {
  it('appends digits left to right', () => {
    let v = 0;
    for (const d of ['2', '5', '0', '0']) v = appendDigit(v, d);
    expect(v).toBe(2500);
  });

  it('refuses a leading zero', () => {
    // "0500" reads as 500 but is a different keystroke count from what the
    // vendor believes they pressed.
    expect(appendDigit(0, '0')).toBe(0);
    expect(appendDigit(0, '5')).toBe(5);
  });

  it('stops at the ceiling rather than wrapping', () => {
    expect(appendDigit(MONTANT_MAX, '9')).toBe(MONTANT_MAX);
    expect(appendDigit(99999, '9')).toBe(999999);
  });

  it('ignores anything that is not a digit', () => {
    expect(appendDigit(25, '.')).toBe(25);
    expect(appendDigit(25, 'a')).toBe(25);
    expect(appendDigit(25, '')).toBe(25);
  });

  it('deletes one digit at a time, down to zero', () => {
    expect(removeDigit(2500)).toBe(250);
    expect(removeDigit(5)).toBe(0);
    expect(removeDigit(0)).toBe(0);
  });
});

describe('phone and countdown display', () => {
  it('renders a stored msisdn in the local grouping a vendor recognises', () => {
    expect(formatPhoneLocal('2250701020304')).toBe(
      `07${ESPACE}01${ESPACE}02${ESPACE}03${ESPACE}04`
    );
  });

  it('leaves anything unexpected untouched rather than mangling it', () => {
    expect(formatPhoneLocal('123')).toBe('123');
  });

  it('formats the confirmation countdown', () => {
    expect(formatCountdown(180)).toBe('3:00');
    expect(formatCountdown(59)).toBe('0:59');
    expect(formatCountdown(0)).toBe('0:00');
    expect(formatCountdown(-5)).toBe('0:00');
  });
});

// ---------------------------------------------------------------------------
// Legibility floors
// ---------------------------------------------------------------------------

describe('sunlight legibility — the floors the spec sets', () => {
  const tokens = readFileSync(path.join(SRC, 'styles', 'tokens.css'), 'utf8');
  const base = readFileSync(path.join(SRC, 'styles', 'base.css'), 'utf8');

  it('uses the exact section 7 palette', () => {
    for (const hex of ['#0B2E22', '#14503A', '#C9A227', '#E8C558', '#F4F1E8', '#8FA79A', '#D96A4A']) {
      expect(tokens).toContain(hex);
    }
  });

  it('body text is at or above the 16px floor', () => {
    const m = /--texte-base:\s*([\d.]+)rem/.exec(tokens);
    expect(m).not.toBeNull();
    expect(Number(m![1]) * 16).toBeGreaterThanOrEqual(16);
  });

  it('touch targets are at or above the 48px floor', () => {
    const min = /--cible-min:\s*(\d+)px/.exec(tokens);
    const primaire = /--cible-primaire:\s*(\d+)px/.exec(tokens);
    expect(Number(min![1])).toBeGreaterThanOrEqual(48);
    expect(Number(primaire![1])).toBeGreaterThanOrEqual(48);
  });

  it('amounts are always tabular mono', () => {
    // Without tabular figures a changing amount shifts width mid-keystroke and
    // the whole line jitters.
    expect(base).toMatch(/\.montant\s*\{[^}]*font-variant-numeric:\s*tabular-nums/);
    expect(base).toMatch(/\.montant\s*\{[^}]*--police-chiffre/);
  });

  it('focus is visible, not a hairline', () => {
    const m = /--anneau:\s*(\d+)px/.exec(tokens);
    expect(Number(m![1])).toBeGreaterThanOrEqual(2);
    expect(base).toMatch(/:focus-visible/);
  });

  it('le carnet has its gold rule down the left edge', () => {
    // The signature element (section 7). If this selector disappears, the card
    // has become a generic panel.
    expect(base).toMatch(/\.carnet::before/);
    expect(base).toMatch(/--or-sika/);
  });
});

// ---------------------------------------------------------------------------
// Regression: the phone-number bug the UI end-to-end run caught
// ---------------------------------------------------------------------------

describe('phone normalisation at the API boundary', () => {
  const api = readFileSync(path.join(SRC, 'lib', 'api.ts'), 'utf8');

  it('normalises before looking a customer up', () => {
    // The bug: the screen passed the local 10 digits the vendor typed, but the
    // database stores the E.164 form and the lookup is an exact match. Every
    // existing customer came back as "not registered". Caught only by driving
    // the real UI — every unit test passed throughout.
    expect(code(api)).toMatch(/const msisdn = normaliseMsisdn\(phone\)/);
    expect(code(api)).toMatch(/p_phone: msisdn/);
  });

  it('shares the normaliser with the Edge Functions rather than copying it', () => {
    // Two implementations of phone normalisation is how one person ends up
    // with two accounts holding separate balances at the same shop.
    expect(code(api)).toMatch(
      /import \{ normaliseMsisdn \} from '\.\.\/\.\.\/supabase\/functions\/_shared\/identity'/
    );
  });
});

// ---------------------------------------------------------------------------
// A loading state must never look like a real answer of zero
// ---------------------------------------------------------------------------

describe('loading is distinguishable from zero', () => {
  // The bug this locks out: Mes clients briefly showed "Monnaie en circulation
  // 0 F · 0 clients" while fetching. A vendor glancing at that reads it as
  // owing nothing — a wrong answer delivered with exactly the confidence of a
  // right one. Zero is a meaningful figure in a ledger, so it must never be
  // what "not yet known" looks like.
  const ECRANS = [
    ['client', 'MaMonnaie.tsx'],
    ['vendeur', 'MesClients.tsx'],
    ['vendeur', 'Accueil.tsx'],
  ] as const;

  it.each(ECRANS)('%s/%s guards its figures behind a null check', (dossier, fichier) => {
    const src = code(readFileSync(path.join(SRC, 'screens', dossier, fichier), 'utf8'));

    // Data starts as null, not as an empty array or a zero: those are real
    // answers and cannot double as "still loading".
    expect(src).toMatch(/useState<[^>]*\|\s*null>\(null\)/);

    // Every screen has an explicit branch for the unknown state.
    expect(src).toMatch(/===\s*null\s*\?/);
  });

  it.each(ECRANS)('%s/%s shows a loading marker, not a number', (dossier, fichier) => {
    const src = readFileSync(path.join(SRC, 'screens', dossier, fichier), 'utf8');
    // Either the word or the em-dash placeholder — something that cannot be
    // mistaken for a balance.
    expect(src).toMatch(/Chargement|—/);
  });

  it('no screen renders a hardcoded 0 as an amount', () => {
    // A literal <Montant value={0} /> would be indistinguishable from a real
    // zero balance and is never the right thing to show.
    for (const [dossier, fichier] of ECRANS) {
      const src = code(readFileSync(path.join(SRC, 'screens', dossier, fichier), 'utf8'));
      expect(src, `${fichier} hardcodes a zero amount`).not.toMatch(/<Montant\s+value=\{0\}/);
    }
  });
});
