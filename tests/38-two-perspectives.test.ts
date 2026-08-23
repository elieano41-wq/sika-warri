// What you are owed is never labelled as what you owe.
//
// ============================================================================
// THE BUG. DeuxRegistres printed one fixed pair of labels — "Monnaie gardée"
// and "Dette à payer" — and both roles rendered it. So the vendor's own home
// screen announced "Dette à payer" over the money customers owed THEM.
//
// The comment directly above that call site explained the distinction
// correctly: what the vendor holds is a liability, what they are owed is an
// asset. The code beneath it then said the opposite. A shared component with
// one hard-coded viewpoint will always end up on the other side's screen.
//
// The same screen carried a second one: the account screen closed with "ce que
// chaque commerçant vous doit" for everybody, so a vendor read a sentence about
// what shops owed them, on their own account.
// ============================================================================
//
// Confusing the two directions is the worst error this app can make. A wrong
// amount is arguable; a right amount pointing the wrong way turns a creditor
// into a debtor in the only record either party has.
//
// So the rule is structural: the component cannot be rendered without saying
// whose screen it is, and there is no default to inherit by accident.

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { lireSource, fichiersSource, nonVide, sansCommentaires } from './helpers/source';

const SRC = path.join(process.cwd(), 'src');
const VENDEUR = path.join(SRC, 'screens', 'vendeur');
const CLIENT = path.join(SRC, 'screens', 'client');

const dette = lireSource(path.join(SRC, 'components', 'Dette.tsx'));

describe('the component cannot be rendered without a side', () => {
  it('vue is required, not optional', () => {
    // `vue?:` would let a call site say nothing and get whichever pair the
    // component happened to prefer — which is the bug, with extra steps.
    expect(dette).toMatch(/\bvue:\s*Vue;/);
    expect(dette, 'vue must not be optional').not.toMatch(/\bvue\?:/);
  });

  it('and there is no default to fall back to', () => {
    // A default is worse than an optional prop: it reads as a decision.
    const destructure = /export function DeuxRegistres\(\{([\s\S]*?)\}:/.exec(dette);
    expect(destructure, 'DeuxRegistres signature not found').not.toBeNull();
    expect(destructure![1]).toMatch(/\bvue,/);
    expect(destructure![1], 'vue must not have a default').not.toMatch(/vue\s*=/);
  });

  it('the rendered labels come from the table, not from the JSX', () => {
    // The assertion that would have caught the original bug directly. Both
    // labels were literals inside the spans, so the table could say whatever it
    // liked and the screen would still print one fixed pair. Interpolation is
    // what makes `vue` mean anything.
    const spans = dette.match(/<span className="registre__etiquette">([\s\S]*?)<\/span>/g) ?? [];
    nonVide(spans, 'registre labels', 2);
    for (const s of spans) {
      expect(s, `a register label is hard-coded: ${s}`).toMatch(/\{e\.(monnaie|dette)\}/);
    }
  });

  it('both label pairs are declared together, in one table', () => {
    // Side by side, because the mistake is only visible when you can read both
    // readings of the same figure at once.
    const table = /const ETIQUETTES[\s\S]*?\n\};/.exec(dette);
    expect(table, 'ETIQUETTES table not found').not.toBeNull();
    expect(table![0]).toMatch(/vendeur:/);
    expect(table![0]).toMatch(/client:/);
  });
});

describe('each side gets its own direction', () => {
  const table = /const ETIQUETTES[\s\S]*?\n\};/.exec(dette)![0];
  const ligne = (vue: string) =>
    new RegExp(`${vue}:\\s*\\{[^}]*\\}`).exec(table)![0];

  it("the vendor is OWED, and never told they owe it", () => {
    const v = ligne('vendeur');
    // "on vous doit" — somebody owes you.
    expect(v).toMatch(/on vous doit/i);
    // Nothing in the vendor's debt label may say the vendor pays it.
    expect(v, "the vendor's debt label reads as a debt they owe")
      .not.toMatch(/à payer|que vous devez/i);
  });

  it('the customer OWES, and is never told it is owed to them', () => {
    const c = ligne('client');
    expect(c).toMatch(/vous devez/i);
    expect(c, "the customer's debt label reads as money owed to them")
      .not.toMatch(/on vous doit|vous doivent/i);
  });

  it('and the two debt labels are not the same string', () => {
    // The failure mode was one label serving both. If they ever converge again
    // this is the assertion that notices.
    const v = /dette:\s*'([^']*)'/.exec(ligne('vendeur'))![1];
    const c = /dette:\s*'([^']*)'/.exec(ligne('client'))![1];
    expect(v).not.toBe(c);
  });
});

describe('every call site declares which screen it is on', () => {
  function appels(racine: string) {
    return nonVide(
      fichiersSource(racine).filter((f) => lireSource(f).includes('<DeuxRegistres')),
      `screens under ${path.basename(racine)} rendering DeuxRegistres`
    );
  }

  it('vendor screens pass vue="vendeur"', () => {
    for (const f of appels(VENDEUR)) {
      const src = lireSource(f);
      const rendus = src.match(/<DeuxRegistres[\s\S]{0,1200}?\/>/g) ?? [];
      nonVide(rendus, `DeuxRegistres renders in ${path.basename(f)}`);
      for (const r of rendus) {
        expect(r, `${path.basename(f)} renders DeuxRegistres without vue="vendeur"`)
          .toMatch(/vue="vendeur"/);
      }
    }
  });

  it('customer screens pass vue="client"', () => {
    for (const f of appels(CLIENT)) {
      const src = lireSource(f);
      const rendus = src.match(/<DeuxRegistres[\s\S]{0,1200}?\/>/g) ?? [];
      nonVide(rendus, `DeuxRegistres renders in ${path.basename(f)}`);
      for (const r of rendus) {
        expect(r, `${path.basename(f)} renders DeuxRegistres without vue="client"`)
          .toMatch(/vue="client"/);
      }
    }
  });
});

describe("no screen carries the other side's debt wording", () => {
  // NARROW ON PURPOSE. Both parties owe something — the vendor owes the change
  // they are holding, the customer owes the debt — so "vous devez" is legitimate
  // on a vendor screen and always will be. Only the DEBT register has one true
  // direction per side, so only that pairing is forbidden.
  const DETTE_DU_CLIENT = /dette[^.<>]{0,24}(à payer|que vous devez|vous devez)/i;
  const DETTE_DU_VENDEUR = /dette[^.<>]{0,24}(on vous doit|vous doivent|qu’on vous doit)/i;

  it('vendor screens never describe the debt as theirs to pay', () => {
    const fichiers = nonVide(fichiersSource(VENDEUR), 'vendor screens', 5);
    const fautifs = fichiers.filter((f) => DETTE_DU_CLIENT.test(sansCommentaires(lireSource(f))));
    expect(fautifs.map((f) => path.basename(f))).toEqual([]);
  });

  it('customer screens never describe the debt as owed to them', () => {
    const fichiers = nonVide(fichiersSource(CLIENT), 'customer screens', 5);
    const fautifs = fichiers.filter((f) => DETTE_DU_VENDEUR.test(sansCommentaires(lireSource(f))));
    expect(fautifs.map((f) => path.basename(f))).toEqual([]);
  });
});

describe('the screens both roles share say it twice, once per role', () => {
  const compte = sansCommentaires(lireSource(path.join(SRC, 'screens', 'Compte.tsx')));

  it("the account screen's closing note is written per role", () => {
    // It used to be one sentence about what shops owe you, shown to shopkeepers.
    expect(compte).toMatch(/vendeur\s*\n?\s*\?/);
    expect(compte, 'the customer sentence is shown to everyone')
      .not.toMatch(/note seulement ce que chaque[\s\S]{0,40}commerçant vous doit\.\s*\n?\s*<\/Message>/);
  });
});

describe('shared movement labels stay directionless', () => {
  // The one place where NOT taking a side is right: a vendor and a customer
  // discussing the same receipt must read the same words for it. That only
  // works while the words belong to neither of them.
  const mouvements = sansCommentaires(lireSource(path.join(SRC, 'lib', 'mouvements.ts')));

  it('libelleMouvement addresses nobody', () => {
    const fn = /export function libelleMouvement[\s\S]*?\n\}/.exec(mouvements);
    expect(fn, 'libelleMouvement not found').not.toBeNull();
    const libelles = fn![0].match(/'[^']+'/g) ?? [];
    nonVide(libelles, 'movement labels', 4);
    for (const l of libelles) {
      expect(l, `${l} takes a side; both parties read this label`)
        .not.toMatch(/\bvous\b|\bvotre\b|\bvos\b/i);
    }
  });
});
