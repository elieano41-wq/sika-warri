// PIN rules, phrased for someone who has never had an account before.
//
// The rules are shown BEFORE typing and checked live while typing. Rejecting a
// PIN after the fact teaches nothing and reads as the app being awkward — the
// person tries 1234, is refused, tries 0000, is refused, and concludes the
// thing is broken. Saying what a good code looks like first costs one screen.
//
// Wording is deliberately concrete. "Évitez les codes trop simples" means
// nothing; "pas 0000, pas 1234" is a rule someone can follow.

import { checkPin, pinLengthFor, type Role } from '../../supabase/functions/_shared/identity';

export interface Regle {
  /** Short label, shown as a checklist item. */
  texte: string;
  /** Satisfied by the PIN typed so far. */
  ok: (pin: string, role: Role) => boolean;
}

export function reglesPour(role: Role): Regle[] {
  const n = pinLengthFor(role);

  return [
    {
      texte: `${n} chiffres`,
      ok: (pin) => pin.length === n,
    },
    {
      texte: 'Pas le même chiffre répété — pas 0000',
      // Only judged once something is typed, so the checklist does not start
      // out looking like a list of failures.
      ok: (pin) => pin.length === 0 || !/^(\d)\1*$/.test(pin),
    },
    {
      texte: 'Pas des chiffres qui se suivent — pas 1234',
      ok: (pin, r) => pin.length < pinLengthFor(r) || checkPin(pin, r)?.code !== 'PIN_SEQUENTIAL',
    },
    {
      texte: 'Pas deux chiffres en alternance — pas 1212',
      ok: (pin, r) => pin.length < pinLengthFor(r) || checkPin(pin, r)?.code !== 'PIN_REPEATED_PAIR',
    },
  ];
}

/** One sentence explaining WHY, before the checklist. */
export function pourquoiPour(role: Role): string {
  return role === 'vendor'
    ? 'Ce code protège votre boutique. Vous le taperez à chaque ouverture.'
    : 'Ce code vous sert à confirmer, sur votre propre téléphone, quand un commerçant utilise votre monnaie.';
}

/** The warning that matters most, in both flows. */
export const NE_PARTAGEZ_JAMAIS =
  'Ne donnez ce code à personne, même pas à un commerçant.';

/** Is this PIN acceptable, per the server's own policy? */
export function pinValide(pin: string, role: Role): boolean {
  return checkPin(pin, role) === null;
}

/** The server's message for an unacceptable PIN, or null. */
export function pinProbleme(pin: string, role: Role): string | null {
  return checkPin(pin, role)?.message ?? null;
}

export { pinLengthFor };
