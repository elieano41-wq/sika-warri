// Pure identity and credential logic.
//
// DELIBERATELY FREE OF DENO GLOBALS. No Deno.env, no imports, no I/O. Every
// value it needs arrives as an argument. That is what lets the CI suite import
// and test this file directly on Node, which matters because Edge Functions
// themselves cannot be run here — there is no Docker for `supabase functions
// serve`. The riskiest logic in the auth path is therefore the part that IS
// covered by tests.

// ---------------------------------------------------------------------------
// Phone numbers
// ---------------------------------------------------------------------------

/** Côte d'Ivoire. Local subscriber numbers have been 10 digits since 2021. */
const CI_COUNTRY_CODE = '225';
const CI_LOCAL_LENGTH = 10;

/** Valid Ivorian mobile prefixes after the 2021 renumbering. */
const CI_MOBILE_PREFIXES = ['01', '05', '07', '25', '27'];

export class NormalisationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'NormalisationError';
  }
}

/**
 * Normalise anything a human might type into E.164 without the plus sign,
 * e.g. "07 01 02 03 04" -> "2250701020304".
 *
 * Phone number IS the identity here, so two spellings of one number must never
 * become two accounts holding two separate balances at the same shop.
 */
export function normaliseMsisdn(input: string): string {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new NormalisationError('PHONE_REQUIRED', 'Numéro de téléphone requis');
  }

  // Keep digits only: strips +, spaces, dots, dashes, parentheses.
  let digits = input.replace(/\D+/g, '');

  if (digits === '') {
    throw new NormalisationError('PHONE_INVALID', 'Numéro de téléphone invalide');
  }

  // International prefix typed as 00 rather than +.
  if (digits.startsWith('00')) digits = digits.slice(2);

  // Already carries the country code.
  if (digits.startsWith(CI_COUNTRY_CODE) && digits.length === CI_COUNTRY_CODE.length + CI_LOCAL_LENGTH) {
    digits = digits.slice(CI_COUNTRY_CODE.length);
  }

  if (digits.length !== CI_LOCAL_LENGTH) {
    throw new NormalisationError(
      'PHONE_INVALID',
      `Numéro invalide : ${CI_LOCAL_LENGTH} chiffres attendus`
    );
  }

  if (!CI_MOBILE_PREFIXES.includes(digits.slice(0, 2))) {
    throw new NormalisationError(
      'PHONE_NOT_MOBILE',
      'Ce numéro ne correspond pas à un mobile ivoirien'
    );
  }

  return CI_COUNTRY_CODE + digits;
}

/** Synthetic auth email. Supabase Auth needs an address; there is no mailbox. */
export function authEmailFor(msisdn: string): string {
  return `${msisdn}@id.sikawarri.app`;
}

// ---------------------------------------------------------------------------
// PIN policy
// ---------------------------------------------------------------------------

export type Role = 'vendor' | 'customer';

/** Vendors use 6 digits, customers 4. */
export function pinLengthFor(role: Role): number {
  return role === 'vendor' ? 6 : 4;
}

export interface PinRejection {
  code: string;
  message: string;
}

/**
 * Reject PINs that are trivially guessable.
 *
 * A 4-digit PIN is deliberately weak-but-appropriate: exposure is capped at
 * 3 000 F per vendor by design, and the alternative (SMS OTP) costs money the
 * product does not have. Given that, refusing the handful of PINs an attacker
 * would try first is cheap and worth doing.
 */
export function checkPin(pin: string, role: Role): PinRejection | null {
  const expected = pinLengthFor(role);

  if (typeof pin !== 'string' || !/^\d+$/.test(pin)) {
    return { code: 'PIN_NOT_NUMERIC', message: 'Le code doit être uniquement des chiffres' };
  }

  if (pin.length !== expected) {
    return {
      code: 'PIN_WRONG_LENGTH',
      message: `Le code doit contenir ${expected} chiffres`,
    };
  }

  // All the same digit: 0000, 1111, 999999.
  if (/^(\d)\1*$/.test(pin)) {
    return { code: 'PIN_REPEATED', message: 'Ce code est trop simple' };
  }

  if (isSequential(pin)) {
    return { code: 'PIN_SEQUENTIAL', message: 'Ce code est trop simple' };
  }

  // Two digits alternating: 1212, 2727, 121212. Reads as varied but is not.
  if (pin.length % 2 === 0 && /^(\d\d)\1+$/.test(pin)) {
    return { code: 'PIN_REPEATED_PAIR', message: 'Ce code est trop simple' };
  }

  return null;
}

/** Ascending or descending runs, including wraparound like 9012 and 1098. */
function isSequential(pin: string): boolean {
  let ascending = true;
  let descending = true;

  for (let i = 1; i < pin.length; i += 1) {
    const prev = Number(pin[i - 1]);
    const cur = Number(pin[i]);
    if ((prev + 1) % 10 !== cur) ascending = false;
    if ((prev + 9) % 10 !== cur) descending = false;
  }

  return ascending || descending;
}

// ---------------------------------------------------------------------------
// Credential derivation  (amendment J)
// ---------------------------------------------------------------------------

/**
 * Derive the Supabase Auth password from a PIN and a versioned pepper.
 *
 * The spec said "PIN concatenated with a pepper". This uses HMAC-SHA256 with
 * the pepper as the key instead. Concatenation leaks structure — the stored
 * credential is literally the PIN with a fixed suffix, so anyone who ever
 * learns the pepper can read every PIN by stripping it. An HMAC gives the same
 * property the design actually wanted (unusable without the pepper) without
 * that. Flagged as a deviation from section 3.
 *
 * The version is inside the HMAC message, so the same PIN under two pepper
 * versions produces two unrelated credentials. That is what makes rotation a
 * real change of credential rather than a relabelling.
 *
 * Returns a printable string safe to hand to Supabase Auth as a password.
 */
export async function derivePassword(
  pin: string,
  pepper: string,
  version: number
): Promise<string> {
  if (!pepper || pepper.trim() === '') {
    // Standing rule 6: fail loudly, naming what is missing. Never fall back to
    // an empty pepper, which would silently make credentials worthless.
    throw new Error(
      `Missing pepper for version ${version}: set SIKA_PIN_PEPPER_V${version}`
    );
  }
  if (!Number.isInteger(version) || version < 1) {
    throw new Error(`Invalid pepper version: ${String(version)}`);
  }

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(pepper),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`sika:v${version}:${pin}`));

  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  return `sw${version}_${hex}`;
}

// ---------------------------------------------------------------------------
// Lockout policy  (acceptance test 9)
// ---------------------------------------------------------------------------

/** Section 3 is normative: lock on the 5th consecutive failure. */
export const MAX_FAILURES = 5;
export const LOCK_MINUTES = 15;

export interface LockoutDecision {
  locked: boolean;
  /** True when the NEXT failure will lock the account. */
  warn: boolean;
  attemptsLeft: number;
  message: string | null;
}

/**
 * Decide what to tell a caller given how many consecutive failures they have.
 *
 * Section 3 says lock after 5 consecutive failures; the spec's own test 9 said
 * six with a warning on the fifth. That was an off-by-one, and section 3 wins:
 * the 5th failure locks, and the 4th warns that one attempt remains.
 */
export function lockoutDecision(recentFailures: number): LockoutDecision {
  const failures = Math.max(0, Math.trunc(recentFailures));
  const attemptsLeft = Math.max(0, MAX_FAILURES - failures);

  if (failures >= MAX_FAILURES) {
    return {
      locked: true,
      warn: false,
      attemptsLeft: 0,
      message: `Compte bloqué pendant ${LOCK_MINUTES} minutes après ${MAX_FAILURES} essais incorrects`,
    };
  }

  if (attemptsLeft === 1) {
    return {
      locked: false,
      warn: true,
      attemptsLeft: 1,
      message: 'Attention : il reste 1 seul essai avant le blocage du compte',
    };
  }

  return { locked: false, warn: false, attemptsLeft, message: null };
}

// ---------------------------------------------------------------------------
// Pepper selection  (amendment J)
// ---------------------------------------------------------------------------

export interface PepperSet {
  current: number;
  byVersion: Map<number, string>;
}

/**
 * Read the pepper set out of a plain environment map.
 *
 * Takes the environment as an argument rather than reading Deno.env, so this is
 * testable. Accepts "V1", "v1", "1" for SIKA_PIN_PEPPER_CURRENT because that
 * value is typed by a human into a dashboard.
 */
export function readPepperSet(env: Record<string, string | undefined>): PepperSet {
  const rawCurrent = env.SIKA_PIN_PEPPER_CURRENT;
  if (!rawCurrent) {
    throw new Error('Missing SIKA_PIN_PEPPER_CURRENT');
  }

  const parsed = Number(String(rawCurrent).replace(/^[vV]/, ''));
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(
      `SIKA_PIN_PEPPER_CURRENT must name a version like "V1"; got "${rawCurrent}"`
    );
  }

  const byVersion = new Map<number, string>();
  for (const [name, value] of Object.entries(env)) {
    const m = /^SIKA_PIN_PEPPER_V(\d+)$/.exec(name);
    if (m && value && value.trim() !== '') {
      byVersion.set(Number(m[1]), value);
    }
  }

  if (!byVersion.has(parsed)) {
    throw new Error(
      `SIKA_PIN_PEPPER_CURRENT is V${parsed} but SIKA_PIN_PEPPER_V${parsed} is not set`
    );
  }

  return { current: parsed, byVersion };
}

/** Look up one pepper, failing loudly if a user references a retired version. */
export function pepperFor(set: PepperSet, version: number): string {
  const pepper = set.byVersion.get(version);
  if (!pepper) {
    // This is what a prematurely retired pepper looks like. It must never be
    // reported to the user as "wrong PIN", which is indistinguishable from a
    // forgotten one and would send them to re-register for no reason.
    throw new Error(
      `No pepper configured for version ${version}. It may have been retired ` +
        `while rows still referenced it — check pepper_version_usage().`
    );
  }
  return pepper;
}

/** True when this row's credential should be re-derived on successful login. */
export function needsPepperUpgrade(set: PepperSet, rowVersion: number): boolean {
  return rowVersion < set.current;
}
