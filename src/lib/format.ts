// Amount formatting. Pure, no imports, covered by CI.
//
// Spec: integer FCFA only, a SPACE as thousands separator, and the F suffix —
// "2 500 F". Getting this wrong is not cosmetic. A vendor reading 2500 as 25000
// across a stall hands over ten times the change.

/**
 * U+00A0, not a plain space.
 *
 * A regular space lets "2 500 F" break across two lines mid-amount, which at a
 * glance reads as two different numbers. Non-breaking keeps the figure whole
 * and has the same advance width as a space in IBM Plex Mono, so tabular
 * alignment is unaffected.
 */
const ESPACE = ' ';

/** Group digits in threes from the right: 2500 -> "2 500". */
export function groupDigits(value: number): string {
  const n = Math.trunc(Math.abs(value));
  const digits = String(n);
  let out = '';
  for (let i = 0; i < digits.length; i += 1) {
    // Insert a separator before every third digit counted from the right.
    if (i > 0 && (digits.length - i) % 3 === 0) out += ESPACE;
    out += digits[i];
  }
  return out;
}

/**
 * The canonical rendering: "2 500 F".
 *
 * Negative values are formatted with a leading minus, but they should never
 * reach a screen — the ledger cannot produce one (standing rule 2). If one
 * appears it is a bug worth seeing rather than hiding behind Math.abs.
 */
export function formatCfa(value: number): string {
  const sign = value < 0 ? '-' : '';
  return `${sign}${groupDigits(value)}${ESPACE}F`;
}

/** Digits only, for placing the F suffix in its own element. */
export function formatCfaDigits(value: number): string {
  const sign = value < 0 ? '-' : '';
  return `${sign}${groupDigits(value)}`;
}

// ---------------------------------------------------------------------------
// Keypad input
// ---------------------------------------------------------------------------

/** Hard ceiling on a single typed amount, as a guard against a stuck key. */
export const MONTANT_MAX = 999_999;

/**
 * Append a digit to an amount being typed.
 *
 * Rejects a leading zero, so a mis-tap cannot produce "0500" — which reads as
 * 500 but is a different keystroke count from what the vendor believes they
 * pressed.
 */
export function appendDigit(current: number, digit: string): number {
  if (!/^[0-9]$/.test(digit)) return current;
  if (current === 0 && digit === '0') return 0;
  const next = current * 10 + Number(digit);
  return next > MONTANT_MAX ? current : next;
}

export function removeDigit(current: number): number {
  return Math.trunc(current / 10);
}

// ---------------------------------------------------------------------------
// Phone display
// ---------------------------------------------------------------------------

/**
 * Render a stored msisdn back into the local grouping a vendor recognises:
 * 2250701020304 -> "07 01 02 03 04".
 */
export function formatPhoneLocal(msisdn: string): string {
  const digits = msisdn.replace(/\D+/g, '');
  const local = digits.startsWith('225') ? digits.slice(3) : digits;
  if (local.length !== 10) return msisdn;
  return local.replace(/(\d{2})(?=\d)/g, `$1${ESPACE}`);
}

/** Seconds -> "2:59", for the confirmation countdown. */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.trunc(seconds));
  const m = Math.trunc(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

export { ESPACE };
