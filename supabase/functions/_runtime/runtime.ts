// Deno-side plumbing for the Edge Functions.
//
// Kept apart from _shared/identity.ts on purpose: that file is pure and is
// covered by the CI suite, this one touches Deno.env, the network and Supabase
// Auth and therefore cannot be. Anything worth testing belongs next door.

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { readPepperSet, type PepperSet } from '../_shared/identity.ts';
import { parseBearer } from '../_shared/bearer.ts';

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/** Read a required variable, failing loudly and naming it (standing rule 6). */
export function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value || value.trim() === '') {
    throw new ConfigError(`Missing required environment variable: ${name}`);
  }
  return value;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Snapshot the environment as a plain object so pure code can read it. */
export function envRecord(): Record<string, string | undefined> {
  return Deno.env.toObject();
}

export function peppers(): PepperSet {
  return readPepperSet(envRecord());
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

/**
 * Service-role client. Bypasses RLS entirely, so it is used only for the
 * privileged RPCs and Auth admin calls that genuinely need it.
 *
 * Amendment K: the new secret key format. Never the legacy service_role JWT,
 * which is disabled on this project.
 */
export function serviceClient(): SupabaseClient {
  return createClient(
    requireEnv('SUPABASE_URL'),
    requireEnv('SIKA_SUPABASE_SECRET_KEY'),
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

/**
 * A throwaway client used only to check a PIN by attempting a sign-in.
 *
 * persistSession is false and every instance is discarded immediately. That is
 * what lets a PIN be verified without touching the caller's own session — the
 * property amendment H depends on, since a vendor's session must survive a
 * customer confirming a debit, and neither party may end up holding the other's
 * token.
 */
export function throwawayClient(): SupabaseClient {
  return createClient(
    requireEnv('SUPABASE_URL'),
    requireEnv('SIKA_SUPABASE_SECRET_KEY'),
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

export function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS });
}

export interface ApiFailure {
  ok: false;
  code: string;
  message: string;
}

export function fail(code: string, message: string, status = 400): Response {
  return json({ ok: false, code, message } satisfies ApiFailure, status);
}

/** French messages for the SQLSTATEs raised by the data layer. */
const SQLSTATE_MESSAGES: Record<string, string> = {
  SW001: "Cette opération ne vous appartient pas",
  SW002: "Identité incohérente, reconnectez-vous",
  SW003: "Session invalide, reconnectez-vous",
  SW004:
    "Le client doit confirmer sur son téléphone. " +
    "Demandez-lui d'ouvrir Sika Warri.",
  SW005:
    "Vous gardez déjà le maximum pour ce client. " +
    "Il faut qu'il utilise sa monnaie avant que vous en gardiez plus.",
  SW006:
    "Le client n'a pas assez de monnaie gardée ici. " +
    "Vérifiez le montant, ou demandez-lui le reste en espèces.",
  SW007: "Demande incomplète. Vérifiez le montant et le numéro, puis réessayez.",
  SW008:
    "Introuvable. Vérifiez le numéro du client, ou demandez-lui de " +
    "rouvrir son application.",
  SW009: "Trop de recherches, patientez un instant",
  SW010: "Le client doit changer son code avant le prochain achat",
  SW011: "Cette demande n'est plus valable",
  SW012: "Demande expirée, le commerçant doit recommencer",
  SW013: "Le délai de correction est dépassé. Le client doit confirmer.",
  SW014: "Cette opération doit passer par la confirmation du client",
  SW015: "Trop de réinitialisations demandées aujourd'hui",
  SW016: "Cette réinitialisation n'est plus valable",
  // The cooling-off after vouching for a reset. A vendor hitting this needs to
  // know it is deliberate and temporary, not a fault — otherwise they retry,
  // then conclude the app is broken.
  SW017:
    "Vous avez demandé la réinitialisation du code de ce client. " +
    "Vous pourrez utiliser sa monnaie dans une heure.",

  // ---- the debt register --------------------------------------------------
  //
  // EVERY ONE OF THESE WAS FALLING THROUGH to "Une erreur est survenue,
  // réessayez" until the field-readiness pass. Nine of them are reachable by a
  // vendor standing at a counter — the cap, the rate limit, the repayment floor
  // — so a vendor hitting the 10 000 F ceiling was told nothing about the
  // ceiling and had no way to work out what to change.
  //
  // Each says what happened AND what to do. "Plafond atteint" alone is a fact
  // about the system; "réglez une partie d'abord" is an instruction.

  SW018: "Un compte support ne peut pas être aussi un compte client",

  // Defensive: only a direct database write reaches this.
  SW019: "Une dette ne peut pas être modifiée. Enregistrez un paiement ou une annulation.",

  SW020:
    "Plafond de dette atteint pour ce client. " +
    "Encaissez une partie de ce qu'il vous doit avant d'en ajouter.",

  SW021:
    "Le montant dépasse ce que ce client vous doit. " +
    "Vérifiez le montant reçu.",

  SW022:
    "Vous avez enregistré beaucoup de dettes en peu de temps. " +
    "Attendez un moment avant d'en ajouter une autre.",

  // The vendor-device path for debt. Unreachable from the app — there is no
  // parameter for it — so this is for a hand-built request.
  SW023:
    "Une dette doit être confirmée par le client sur SON téléphone. " +
    "Vous ne pouvez pas saisir son code.",

  SW024: "Seul le client concerné peut répondre à cette écriture",

  SW025:
    "Vous avez déjà répondu à cette écriture. " +
    "Contactez le commerçant si vous voulez la corriger.",

  SW026:
    "Rien à compenser ici : il faut à la fois de la monnaie gardée " +
    "et une dette chez ce commerçant.",

  SW027: "Cette dette doit être confirmée par le client sur son téléphone",

  SW028:
    "Montant trop élevé. Choisissez au maximum le plus petit des deux " +
    "montants : la monnaie gardée ou la dette.",

  SW029: "Cette réponse ne correspond pas à ce type d'écriture",

  SW030:
    "Vous ne devez rien à ce commerçant, il n'y a donc pas de paiement " +
    "à déclarer.",

  SW031: "Cette réclamation a déjà été traitée",

  SW032: "Vous ne pouvez pas répondre à cette réclamation",

  // Names the next action, like every other message a user meets at a counter.
  // "Refused" on its own teaches nothing and gets tried again.
  SW033:
    "Vous devez d'abord accepter les conditions pour garder l'argent de " +
    "quelqu'un. Ouvrez « Compte » puis « Conditions ».",
};

/**
 * Turn a Postgres error into a specific French message.
 *
 * Never returns a generic failure when the data layer named one, and never
 * leaks the raw Postgres detail to the client — the detail strings carry
 * balances and caps, which is more than the caller is entitled to.
 */
export function mapPostgresError(err: unknown): { code: string; message: string; status: number } {
  const e = err as { code?: string; message?: string };
  const raw = e?.code ?? '';

  // Our own named codes arrive either as the SQLSTATE or inside the message.
  for (const sqlstate of Object.keys(SQLSTATE_MESSAGES)) {
    if (raw === sqlstate || (e?.message ?? '').includes(sqlstate)) {
      return {
        code: sqlstate,
        message: SQLSTATE_MESSAGES[sqlstate]!,
        status: sqlstate === 'SW009' ? 429 : 400,
      };
    }
  }

  if (raw === '42501') {
    return { code: 'FORBIDDEN', message: 'Opération non autorisée', status: 403 };
  }

  return { code: 'UNEXPECTED', message: "Une erreur est survenue, réessayez", status: 500 };
}

// ---------------------------------------------------------------------------
// Caller identity
// ---------------------------------------------------------------------------

export interface Caller {
  authUserId: string;
  jwt: string;
}

/**
 * Establish who is calling, from the Authorization header.
 *
 * Amendment K makes this mandatory rather than optional. The platform's
 * verify_jwt only understands the legacy JWT keys, so it is disabled on every
 * function in this project — which means NOTHING has validated the caller
 * before this runs. Each function proves identity itself, here.
 */
export async function requireCaller(req: Request): Promise<Caller> {
  // Shape check first, in pure code covered by CI (see _shared/bearer.ts).
  const parsed = parseBearer(req.headers.get('Authorization'));
  if (!parsed.ok) {
    throw new AuthError(parsed.code, parsed.message);
  }

  // Then the real thing. getUser(jwt) sends the token to Supabase's auth
  // server, which verifies the SIGNATURE and the EXPIRY and resolves the
  // subject. That is deliberately not attempted locally: validating a
  // signature by hand here would mean handling the signing key and getting
  // asymmetric key rotation right, and a mistake would be an authentication
  // bypass rather than a bug.
  //
  // The returned id is the ONLY source of caller identity in this codebase.
  // No handler reads a user id, vendor id or customer id from the request
  // body — checked by tests/18-caller-identity.test.ts.
  const { data, error } = await serviceClient().auth.getUser(parsed.jwt);
  if (error || !data?.user) {
    throw new AuthError('INVALID_TOKEN', 'Session expirée, reconnectez-vous');
  }

  return { authUserId: data.user.id, jwt: parsed.jwt };
}

export class AuthError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

export async function readJson<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new AuthError('BAD_BODY', 'Requête invalide');
  }
}

/** Best-effort client IP, for per-IP throttling. */
export function clientIp(req: Request): string | null {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) {
    const first = fwd.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.headers.get('cf-connecting-ip');
}

/**
 * Record a login attempt.
 *
 * Standing rule 11: this records THAT an attempt happened and whether it
 * succeeded. The PIN is never passed in and never stored.
 */
export async function recordAttempt(
  db: SupabaseClient,
  phone: string,
  succeeded: boolean,
  ip: string | null
): Promise<void> {
  await db.from('auth_attempts').insert({ phone, succeeded, ip });
}

/** Wrap a handler so no thrown error ever escapes as an opaque 500. */
export function handler(fn: (req: Request) => Promise<Response>): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    if (req.method === 'OPTIONS') return preflight();
    if (req.method !== 'POST') return fail('METHOD', 'Méthode non autorisée', 405);

    try {
      return await fn(req);
    } catch (err) {
      if (err instanceof AuthError) {
        return fail(err.code, err.message, err.code === 'BAD_BODY' ? 400 : 401);
      }
      if (err instanceof ConfigError) {
        // Misconfiguration is ours, not the caller's. Log it server-side and
        // say nothing specific to the client.
        console.error('CONFIG', err.message);
        return fail('MISCONFIGURED', 'Service indisponible', 503);
      }
      if (err && typeof err === 'object' && 'code' in err) {
        const mapped = mapPostgresError(err);
        return fail(mapped.code, mapped.message, mapped.status);
      }
      console.error('UNHANDLED', err);
      return fail('UNEXPECTED', "Une erreur est survenue, réessayez", 500);
    }
  };
}
