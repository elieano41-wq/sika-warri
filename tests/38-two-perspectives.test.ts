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
  // Scoped to wherever DeuxRegistres is ACTUALLY rendered rather than to a
  // folder with a floor. The vendor home stopped using it — the home screen is a
  // four-register matrix now, with its own labels, asserted further down — and a
  // per-folder floor then failed for the right reason: it found nothing under
  // screens/vendeur and refused to pass on an empty set. Following the component
  // keeps the guard honest without pinning it to a directory layout.
  const rendus = nonVide(
    fichiersSource(path.join(SRC, 'screens'))
      .filter((f) => lireSource(f).includes('<DeuxRegistres')),
    'screens rendering DeuxRegistres'
  );

  it('every render passes a side', () => {
    for (const f of rendus) {
      const blocs = lireSource(f).match(/<DeuxRegistres[\s\S]{0,1200}?\/>/g) ?? [];
      nonVide(blocs, `DeuxRegistres renders in ${path.basename(f)}`);
      for (const b of blocs) {
        expect(b, `${path.basename(f)} renders DeuxRegistres without a vue`)
          .toMatch(/vue="(vendeur|client)"/);
      }
    }
  });

  it('and the side it passes matches the folder it is in', () => {
    // The cheap check that would have caught the original bug at any call site:
    // a screen under client/ showing the vendor's labels, or the reverse.
    for (const f of rendus) {
      const attendu = f.includes(`${path.sep}client${path.sep}`) ? 'client' : 'vendeur';
      const blocs = lireSource(f).match(/<DeuxRegistres[\s\S]{0,1200}?\/>/g) ?? [];
      for (const b of blocs) {
        expect(b, `${path.basename(f)} should pass vue="${attendu}"`)
          .toMatch(new RegExp(`vue="${attendu}"`));
      }
    }
  });
});

describe('the home matrix labels its two directions correctly', () => {
  // THE NEW PLACE THE SAME MISTAKE CAN HAPPEN. The vendor home no longer renders
  // DeuxRegistres; it renders a matrix whose columns ARE the two directions. So
  // the wording that used to be a prop is now a lookup table, and a table is
  // just as easy to get backwards.
  const accueil = lireSource(path.join(SRC, 'screens', 'Accueil.tsx'));

  it('the column names say who owes whom', () => {
    const table = /const NOM_COLONNE[\s\S]*?\n\};/.exec(accueil);
    expect(table, 'NOM_COLONNE not found').not.toBeNull();
    expect(table![0]).toMatch(/jedois:\s*'Je dois'/);
    expect(table![0]).toMatch(/onmedoit:\s*'On me doit'/);
    // Neither may claim the other's direction.
    expect(/jedois:\s*'[^']*on me doit/i.test(table![0]), 'jedois says on me doit').toBe(false);
    expect(/onmedoit:\s*'[^']*je dois/i.test(table![0]), 'onmedoit says je dois').toBe(false);
  });

  it('the full labels used in list mode point the right way', () => {
    // In the grid a cell says "Dettes" and the column above supplies the
    // direction; in list mode there is no column, so the label carries both —
    // which is exactly where a direction gets lost.
    const fn = /function libelleComplet[\s\S]*?\n\}/.exec(accueil);
    expect(fn, 'libelleComplet not found').not.toBeNull();
    const corps = fn![0];

    // Every branch names a direction, and the four are all different.
    // Anchored on a capital, so the branch conditions ('onmedoit') are not
    // mistaken for labels. My first pass counted those and reported a duplicate
    // that was really two copies of an identifier.
    const libelles = corps.match(/'[A-ZÉ][^']*(?:dois|doit|garde|moi)[^']*'/g) ?? [];
    nonVide(libelles, 'direction labels', 4);
    expect(new Set(libelles).size, `duplicated label: ${libelles}`).toBe(libelles.length);

    // The onmedoit branches must never say "je dois", and vice versa.
    for (const l of libelles) {
      const versMoi = /on me doit|pour moi/i.test(l);
      const deMoi = /je dois|je garde/i.test(l);
      expect(versMoi !== deMoi, `${l} points both ways or neither`).toBe(true);
    }
  });

  it('gold marks what is owed to you, not what you owe', () => {
    // Not cosmetic. The first version tied the accent to the register rather
    // than the direction, so both cells of "Je dois" were gold — the brightest
    // number on the screen was a debt, and the money owed to the reader was the
    // dullest thing on it.
    const css = lireSource(path.join(SRC, 'styles', 'base.css'));
    expect(css).toMatch(/\.matrice__cell--onmedoit \.montant\s*\{[^}]*--or-sika/);
    expect(css).toMatch(/\.matrice__cell--jedois \.montant\s*\{[^}]*--craie/);
  });

  it('and no cell is ever added to another', () => {
    // The four figures come from one server row and are rendered one per cell.
    // Any arithmetic joining two of them here would be inventing a fifth.
    const code = sansCommentaires(accueil);
    for (const paire of [
      /gardeCfa\s*\+/, /jeDoisCfa\s*\+/, /onMeDoitCfa\s*\+/, /gardePourMoiCfa\s*\+/,
      /\+\s*resume\.garde/, /\+\s*resume\.jeDois/, /\+\s*resume\.onMeDoit/,
    ]) {
      expect(code, `the home screen adds two registers together: ${paire}`)
        .not.toMatch(paire);
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
