// Standing rules, audited the way finding 1 was found: not "is it enforced?"
// but "can a person at a counter actually reach it?"
//
// ============================================================================
// THE QUESTION THIS FILE ASKS. Rule 8 was enforced everywhere and defeated
// everywhere, because the key was minted per attempt. 482 tests never touched
// it, because every one of them called a write the way a developer calls a
// write — once, or twice with the same key deliberately — and never the way a
// vendor does, which is twice with a bad signal in between.
//
// So the other rules got the same treatment: imagine the stall, not the spec.
// Two were satisfied in the data layer and unreachable in the app.
// ============================================================================

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const SRC = path.join(process.cwd(), 'src');

function lire(...p: string[]): string {
  return readFileSync(path.join(...p), 'utf8').replace(/\r\n/g, '\n');
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]
  );
}

const ecrans = walk(path.join(SRC, 'screens')).filter((f) => f.endsWith('.tsx'));

describe('the scan is not vacuous', () => {
  it('found screens to check', () => {
    expect(ecrans.length).toBeGreaterThan(8);
  });
});

// ---------------------------------------------------------------------------
// Rule 9 — the customer can ALWAYS demand cash back
// ---------------------------------------------------------------------------

describe('rule 9: a refund is reachable, not just supported', () => {
  // THE GAP THIS CLOSES. kind: 'refund' has existed in the ledger since 0003.
  // GarderLaMonnaie promises the customer "son remboursement en espèces à tout
  // moment". And UtiliserLaMonnaie hardcoded kind: 'purchase', so no screen
  // could record one — a vendor handing back cash had to file it as a purchase,
  // mislabelling it in both parties' history. The rule held in the data layer
  // and the promise was unkeepable at a counter.

  const utiliser = lire(SRC, 'screens', 'vendeur', 'UtiliserLaMonnaie.tsx');

  it('the debit kind is chosen, not hardcoded', () => {
    expect(utiliser).not.toMatch(/kind:\s*'purchase'\s*,/);
    expect(utiliser).toMatch(/kind:\s*motif/);
  });

  it('the vendor is offered cash back as an option', () => {
    expect(utiliser).toMatch(/'refund'/);
    expect(utiliser).toMatch(/Rendu en esp[èe]ces/i);
  });

  it('the promise made on the other screen is still made', () => {
    // If this ever disappears, the reachability above stops mattering: nobody
    // would know to ask.
    const garder = lire(SRC, 'screens', 'vendeur', 'GarderLaMonnaie.tsx');
    expect(garder).toMatch(/remboursement en esp[èe]ces/i);
  });

  it('the CUSTOMER sees which kind they are confirming', () => {
    // A purchase and a cash refund move the same money in the same direction and
    // mean opposite things: in one the customer receives goods, in the other
    // they must receive banknotes. Confirming a "refund" without the money in
    // hand leaves them with no recourse, so the distinction belongs on the
    // screen where they decide.
    const conf = lire(SRC, 'screens', 'client', 'Confirmation.tsx');
    // Through the shared predicate, not an inline string comparison: one module
    // decides what 'refund' means, so a vendor recording and a customer
    // confirming cannot end up reading different words for the same entry.
    expect(conf).toMatch(/estRemboursement\(demande\)/);
    expect(conf).toMatch(/apr[èe]s avoir re[çc]u l['’]argent/i);
  });
});

// ---------------------------------------------------------------------------
// Rule 7 — debits require connectivity
// ---------------------------------------------------------------------------

describe('rule 7: every flow that needs the server checks for it', () => {
  // Only UtiliserLaMonnaie had a gate. NoterUneDette creates an OBLIGATION and
  // had none — and the cap and the running total both live server-side, so
  // offline a vendor could write a claim breaching a ceiling the whole design
  // rests on, and find out later.

  const FLUX_SERVEUR = [
    ['vendeur', 'UtiliserLaMonnaie.tsx'],
    ['vendeur', 'NoterUneDette.tsx'],
  ] as const;

  it.each(FLUX_SERVEUR)('%s/%s refuses to start offline', (dossier, fichier) => {
    const src = lire(SRC, 'screens', dossier, fichier);
    expect(src).toMatch(/navigator\.onLine/);
    expect(src).toMatch(/Connexion requise/);
  });

  it.each(FLUX_SERVEUR)('%s/%s listens for the connection coming back', (dossier, fichier) => {
    // A one-shot navigator.onLine read at mount leaves a vendor stuck on the
    // offline screen after the signal returns, which is worse than no gate:
    // they would close the app and use paper.
    const src = lire(SRC, 'screens', dossier, fichier);
    expect(src).toMatch(/addEventListener\('online'/);
    expect(src).toMatch(/addEventListener\('offline'/);
  });

  it('recording change is NOT gated, because it must work offline', () => {
    // The other half of rule 7, and the reason the gate is per-flow rather than
    // global: a credit only ever increases what the customer holds, so it is
    // safe to queue. Gating it would break the case the product exists for.
    const garder = lire(SRC, 'screens', 'vendeur', 'GarderLaMonnaie.tsx');
    expect(garder).not.toMatch(/Connexion requise/);
  });

  it('the offline wording is the spec section 8 sentence, verbatim', () => {
    const utiliser = lire(SRC, 'screens', 'vendeur', 'UtiliserLaMonnaie.tsx');
    expect(utiliser).toContain('Connexion requise pour utiliser la monnaie');
  });
});

// ---------------------------------------------------------------------------
// Rule 2 — balances never negative, as the SCREENS render them
// ---------------------------------------------------------------------------

describe('rule 2: no screen can display a negative figure', () => {
  // The data layer cannot produce one. The question here is whether a screen
  // could compute one from figures that are each individually fine — which is
  // exactly how −1 500 F would appear.

  it('no screen subtracts one balance from another', () => {
    const coupables = ecrans.filter((f) => {
      const src = lire(f);
      return /(change|monnaie|balance)\w*\s*-\s*(debt|dette)\w*/i.test(src)
        || /(debt|dette)\w*\s*-\s*(change|monnaie|balance)\w*/i.test(src);
    }).map((f) => path.relative(process.cwd(), f));

    expect(coupables).toEqual([]);
  });

  it('no screen renders a hardcoded minus before an amount', () => {
    for (const f of ecrans) {
      const src = lire(f);
      // A literal "-{" or "−{" before an interpolated amount. The sign a debit
      // row shows comes from signeMouvement(), which returns it for a direction
      // rather than for a computed value.
      expect(src, path.relative(process.cwd(), f)).not.toMatch(/[-−]\s*\{formatCfa/);
      expect(src, path.relative(process.cwd(), f)).not.toMatch(/value=\{-\w/);
    }
  });
});

// ---------------------------------------------------------------------------
// Rule 3 — append-only, as the SCREENS offer it
// ---------------------------------------------------------------------------

describe('rule 3: no screen offers to delete or edit an entry', () => {
  it('nothing in the app calls a delete on the ledger or the debt register', () => {
    for (const f of ecrans) {
      const src = lire(f);
      expect(src, path.relative(process.cwd(), f)).not.toMatch(
        /\.delete\(\)|supprimer(Entree|Ligne|Mouvement)/i
      );
    }
  });

  it('nothing offers deletion in the words the user reads', () => {
    // The wording matters as much as the mechanism: a button saying "Supprimer"
    // that actually writes a reversal teaches the wrong model, and the next
    // person to build on it will assume deletion exists.
    for (const f of ecrans) {
      expect(lire(f), path.relative(process.cwd(), f)).not.toMatch(/Supprimer/i);
    }
  });

  it('a vendor can correct their own typo, inside the window', () => {
    // WAS A KNOWN GAP. Migration 0013 built the 15-minute unilateral window and
    // v_correctable_entries to drive a screen that was never written, so a
    // vendor who typed 5000 instead of 500 in front of a customer had no way out
    // of the app — only the two-device handshake, which needs the customer still
    // there and willing, or the support desk. Mistyping an amount at a counter
    // is the likeliest thing to go wrong on day one.
    const corriger = lire(SRC, 'screens', 'vendeur', 'Corriger.tsx');

    expect(corriger).toMatch(/vendorRecentEntries/);
    expect(corriger).toMatch(/correctOwnEntry/);
    expect(corriger).toMatch(/Corriger/);
  });

  it('the correction screen says it REVERSES rather than deletes', () => {
    // Rule 3, in the words the vendor reads, BEFORE they commit. A vendor who
    // believes they deleted something is surprised by their own history later,
    // and a customer who sees an entry vanish has reason to distrust the ledger.
    const corriger = lire(SRC, 'screens', 'vendeur', 'Corriger.tsx');
    expect(corriger).toMatch(/ne sera pas supprim[ée]e/i);
    expect(corriger).toMatch(/les deux resteront visibles/i);
  });

  it('it explains WHY an entry cannot be corrected, per reason', () => {
    // A greyed-out button teaches nothing and gets tapped again. Each refusal
    // names the route that still works.
    const corriger = lire(SRC, 'screens', 'vendeur', 'Corriger.tsx');
    expect(corriger).toMatch(/blocked_reason === 'expired'/);
    expect(corriger).toMatch(/blocked_reason === 'spent'/);
    expect(corriger).toMatch(/blocked_reason === 'reversed'/);
    // And both blocked paths point at the handshake instead.
    expect(corriger).toMatch(/confirmer.*correction|correction.*confirmer/i);
  });

  it('it is reachable from where the mistake happens', () => {
    // One tap from Accueil. A vendor who has just mistyped is still on that
    // screen, and a fix buried three levels down is a fix nobody finds in front
    // of a waiting customer.
    const accueil = lire(SRC, 'screens', 'vendeur', 'Accueil.tsx');
    expect(accueil).toMatch(/onCorriger/);
    // On the activity block, where the vendor is looking when they notice the
    // mistake — not a utility button below the fold on a 390x844 phone, which is
    // where it was until a screenshot showed it needed a scroll to reach.
    expect(accueil).toMatch(/Corriger une [ée]criture/);
  });
});
