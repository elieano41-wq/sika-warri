// PIN rules, phrased for someone who has never had an account before.
//
// The rules are shown BEFORE typing and checked live while typing. Rejecting a
// PIN after the fact teaches nothing and reads as the app being awkward — the
// person tries 1234, is refused, tries 0000, is refused, and concludes the
// thing is broken. Saying what a good code looks like first costs one screen.
//
// Wording is deliberately concrete. "Évitez les codes trop simples" means
// nothing; "pas 0000, pas 1234" is a rule someone can follow.

import { checkPin, PIN_LENGTH } from '../../supabase/functions/_shared/identity';

export interface Regle {
  /** Short label, shown as a checklist item. */
  texte: string;
  /** Satisfied by the PIN typed so far. */
  ok: (pin: string) => boolean;
}

/**
 * The rules, for everyone.
 *
 * `role` is gone from every signature in this module. It only ever selected a
 * PIN length, and there is one length now — see PIN_LENGTH.
 */
export function reglesPour(): Regle[] {
  const n = PIN_LENGTH;

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
      ok: (pin) => pin.length < n || checkPin(pin)?.code !== 'PIN_SEQUENTIAL',
    },
    {
      texte: 'Pas deux chiffres en alternance — pas 1212',
      ok: (pin) => pin.length < n || checkPin(pin)?.code !== 'PIN_REPEATED_PAIR',
    },
  ];
}

/**
 * One sentence explaining WHY, before the checklist.
 *
 * One sentence now, not two. The two it replaced each described half of what
 * this code does — "protects your shop" and "lets you confirm on your own
 * phone" — because an account could only ever do one of those. It does both.
 */
export function pourquoiPour(): string {
  return 'Ce code ouvre votre carnet, et c’est lui qui confirme ce que vous devez. Vous le taperez à chaque fois.';
}

/** The warning that matters most, everywhere. */
export const NE_PARTAGEZ_JAMAIS =
  'Ne donnez ce code à personne, même pas à qui tient le carnet.';

/** Is this PIN acceptable, per the server's own policy? */
export function pinValide(pin: string): boolean {
  return checkPin(pin) === null;
}

/** The server's message for an unacceptable PIN, or null. */
export function pinProbleme(pin: string): string | null {
  return checkPin(pin)?.message ?? null;
}

/**
 * The shortest code any screen must still ACCEPT.
 *
 * Four, for as long as accounts registered before the lengths were unified
 * still exist. Every screen that takes a code — login, the change-code screen,
 * and both confirmation keypads — has to honour this or it locks somebody out
 * of their own money. It lives here because it was hardcoded as a literal 4 in
 * four separate files, and two of them were missed the first time.
 */
export const PIN_MIN_ACCEPTE = 4;

/** One length, for everyone. Re-exported so screens have one import. */
export function pinLengthFor(): number {
  return PIN_LENGTH;
}

export { PIN_LENGTH };
