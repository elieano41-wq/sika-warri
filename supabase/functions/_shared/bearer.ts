// Bearer token parsing.
//
// Pure and dependency-free so CI can test it. This is the front door of every
// authenticated function: with verify_jwt disabled (amendment K), nothing has
// looked at the caller before this runs. A bug here does not degrade security
// slightly — it means anyone on the internet is treated as a valid user.
//
// This file decides only whether something LOOKS like a session token worth
// sending to Supabase. Signature and expiry are checked by the auth server;
// nothing here can or should attempt that.

export type BearerResult =
  | { ok: true; jwt: string }
  | { ok: false; code: string; message: string };

/** Rejects an API key used where a session token belongs. */
const API_KEY_PREFIXES = ['sb_publishable_', 'sb_secret_', 'sbp_'];

/**
 * Pull the session token out of an Authorization header.
 *
 * Fails closed on anything it does not positively recognise: no header, wrong
 * scheme, empty token, an API key, or a string that is not three
 * dot-separated segments. The last check is not cosmetic — a caller sending an
 * opaque string would otherwise reach the auth server, and any ambiguity there
 * becomes an authentication bypass here.
 */
export function parseBearer(header: string | null): BearerResult {
  if (header === null || header.trim() === '') {
    return { ok: false, code: 'NO_TOKEN', message: 'Session requise' };
  }

  const match = /^Bearer[ \t]+(\S.*)$/i.exec(header.trim());
  if (!match) {
    // Covers a bare token with no scheme, "Basic ...", and "Bearer" alone.
    return { ok: false, code: 'NO_TOKEN', message: 'Session requise' };
  }

  const token = match[1]!.trim();
  if (token === '') {
    return { ok: false, code: 'NO_TOKEN', message: 'Session requise' };
  }

  // Naming this specifically matters: the platform rejects an API key on this
  // header with a bare "invalid JWT", which is baffling to debug. Keys belong
  // on the apikey header.
  for (const prefix of API_KEY_PREFIXES) {
    if (token.startsWith(prefix)) {
      return {
        ok: false,
        code: 'KEY_ON_AUTH_HEADER',
        message: "Clé d'API envoyée à la place du jeton de session",
      };
    }
  }

  // A JWT is header.payload.signature. Anything else is not worth forwarding.
  const segments = token.split('.');
  if (segments.length !== 3 || segments.some((s) => s === '')) {
    return { ok: false, code: 'MALFORMED_TOKEN', message: 'Session invalide' };
  }

  return { ok: true, jwt: token };
}
