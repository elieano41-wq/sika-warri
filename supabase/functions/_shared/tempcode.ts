// The temporary reset code.
//
// Pure and testable. The operator must not be able to choose it, reuse one, or
// look one up afterwards — so:
//
//   * generated from a CSPRNG, never from a timestamp, a counter, or anything
//     an operator supplies;
//   * uniformly distributed over the 6-digit space, with no modulo bias;
//   * stored only as a salted hash, so a database leak yields no working code
//     and the operator cannot retrieve one they have already read out;
//   * verified in constant time, so timing cannot narrow the search.

/** Six digits: short enough to read down a phone line, and rate-limited. */
export const LONGUEUR_CODE = 6;

/**
 * A uniformly random 6-digit code.
 *
 * Rejection sampling, not modulo. `value % 1000000` over a 32-bit draw would
 * make low codes very slightly likelier — irrelevant to a guesser in practice,
 * but there is no reason to introduce bias when discarding a few draws is free.
 */
export function genererCode(): string {
  const LIMITE = 1_000_000;
  // Largest multiple of LIMITE inside 2^32, so anything above it is discarded.
  const SEUIL = Math.floor(0xffffffff / LIMITE) * LIMITE;

  const buf = new Uint32Array(1);
  let n: number;
  do {
    crypto.getRandomValues(buf);
    n = buf[0]!;
  } while (n >= SEUIL);

  return String(n % LIMITE).padStart(LONGUEUR_CODE, '0');
}

/** A fresh salt per grant, so two identical codes never share a hash. */
export function genererSel(): string {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** SHA-256 over salt + code. */
export async function hacherCode(code: string, sel: string): Promise<string> {
  const octets = new TextEncoder().encode(`${sel}:${code}`);
  const digest = await crypto.subtle.digest('SHA-256', octets);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Compare two hex digests without leaking where they diverge.
 *
 * A plain === returns as soon as it finds a difference, and the timing of that
 * is measurable. It matters little for a 6-digit code behind a five-attempt
 * ceiling, but constant-time comparison is the correct habit and costs nothing.
 */
export function egal(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Shape check before any lookup. Six digits, nothing else. */
export function formeValide(code: string): boolean {
  return typeof code === 'string' && new RegExp(`^\\d{${LONGUEUR_CODE}}$`).test(code);
}
