// POST /reset-pin — the support-desk recovery flow, user side.
//
// Three actions, all from a LOGGED-OUT device because being locked out is the
// whole situation:
//
//   { phone, request: true }        -> ask the support desk for a reset
//   { phone, code }                 -> is this code valid? (before asking for a PIN)
//   { phone, code, newPin }         -> redeem it and set a new PIN
//
// The request step NEVER reveals whether a number is registered: the reply is
// identical either way, so this endpoint cannot be used to enumerate accounts.
//
// The code unlocks exactly one thing — setting a new PIN. It cannot authorise a
// debit, and nothing else in the system accepts it.

import {
  handler, json, fail, readJson, clientIp, recordAttempt,
  serviceClient, peppers,
} from '../_runtime/runtime.ts';
import {
  normaliseMsisdn, checkPin, derivePassword, NormalisationError, type Role,
} from '../_shared/identity.ts';
import { formeValide, hacherCode, egal } from '../_shared/tempcode.ts';

interface Body {
  phone?: string;
  request?: boolean;
  code?: string;
  newPin?: string;
}

/** Per-IP ceiling. Lower than login: nobody legitimately resets in bulk. */
const MAX_IP = 12;

/**
 * The one message the request step ever returns.
 *
 * Identical for a registered number, an unregistered one, and one that has hit
 * its daily limit. Anything that varied would be an account oracle.
 */
const REPONSE_UNIFORME =
  "Votre demande est enregistrée. Appelez le support Sika Warri au 07 00 00 00 00 " +
  "pour vérifier votre identité. Le support vous donnera un code temporaire.";

Deno.serve(handler(async (req) => {
  const body = await readJson<Body>(req);
  const ip = clientIp(req);
  const db = serviceClient();

  let msisdn: string;
  try {
    msisdn = normaliseMsisdn(body.phone ?? '');
  } catch (err) {
    if (err instanceof NormalisationError) return fail(err.code, err.message);
    throw err;
  }

  if (ip) {
    const { data: recent } = await db.rpc('auth_ip_failure_count', { p_ip: ip });
    if (typeof recent === 'number' && recent >= MAX_IP) {
      return fail('RATE_LIMITED', 'Trop de tentatives, patientez quelques minutes', 429);
    }
  }

  // ----- ask the support desk ---------------------------------------------
  if (body.request === true) {
    // A failure here — unregistered number, daily limit reached — is swallowed
    // deliberately. The caller gets the same sentence regardless, because the
    // difference between those cases is exactly what an attacker wants.
    const { error } = await db.rpc('create_pin_reset_request', {
      p_phone: msisdn,
      p_ip: ip,
    });
    if (error) console.warn('RESET_REQUEST_REFUSED', msisdn.slice(0, 6), error.code);

    return json({ ok: true, requested: true, message: REPONSE_UNIFORME });
  }

  // ----- redeem ------------------------------------------------------------
  const code = body.code ?? '';
  if (!formeValide(code)) {
    await recordAttempt(db, msisdn, false, ip);
    return fail('CODE_INVALID', 'Code temporaire invalide', 401);
  }

  const { data: rows, error: lookupErr } = await db.rpc('open_grant_for_phone', {
    p_phone: msisdn,
  });
  if (lookupErr) throw lookupErr;

  const grant = Array.isArray(rows) ? rows[0] : rows;

  if (!grant) {
    // Covers no grant, expired, already used, and attempts exhausted. One
    // message for all of them: distinguishing them would tell a guesser
    // whether to keep going.
    await recordAttempt(db, msisdn, false, ip);
    return fail('CODE_INVALID', 'Code temporaire invalide ou expiré', 401);
  }

  const attendu = await hacherCode(code, grant.code_salt);
  if (!egal(attendu, grant.code_hash)) {
    const { data: n } = await db.rpc('record_grant_attempt', { p_grant_id: grant.grant_id });
    await recordAttempt(db, msisdn, false, ip);

    const restants = Math.max(0, (grant.max_attempts ?? 5) - (typeof n === 'number' ? n : 0));
    return fail(
      'CODE_INVALID',
      restants > 0
        ? `Code temporaire incorrect. ${restants} essai(s) restant(s).`
        : 'Trop d\'essais. Rappelez le support pour un nouveau code.',
      401
    );
  }

  const role: Role = grant.target_role === 'vendor' ? 'vendor' : 'customer';

  // Enquiry only: the code is right, so the app may now ask for a new PIN. The
  // grant is NOT consumed yet — consuming it here would burn it if the person
  // then closed the app before choosing a code.
  if (body.newPin === undefined) {
    return json({ ok: true, valid: true, role });
  }

  const rejection = checkPin(body.newPin, role);
  if (rejection) return fail(rejection.code, rejection.message);

  const pepperSet = peppers();
  const target = pepperSet.current;
  const password = await derivePassword(
    body.newPin,
    pepperSet.byVersion.get(target)!,
    target
  );

  // Auth first, then burn the grant. If this dies between the two, the grant
  // stays claimable and the person can retry — the safe direction. The reverse
  // would consume the grant and leave them locked out with no second chance.
  const { error: authErr } = await db.auth.admin.updateUserById(grant.auth_user_id, {
    password,
  });
  if (authErr) {
    console.error('RESET_AUTH_FAILED', authErr.message);
    return fail('RESET_FAILED', 'Réinitialisation impossible, réessayez', 500);
  }

  const { error: consumeErr } = await db.rpc('consume_grant', {
    p_grant_id: grant.grant_id,
    p_ip: ip,
  });
  if (consumeErr) console.error('GRANT_CONSUME_FAILED', consumeErr.message);

  const { error: recErr } = await db.rpc('record_pepper_upgrade', {
    p_auth_user_id: grant.auth_user_id,
    p_new_version: target,
    p_role: role,
  });
  if (recErr) console.error('RESET_PEPPER_RECORD_FAILED', recErr.message);

  await recordAttempt(db, msisdn, true, ip);

  return json({
    ok: true,
    role,
    message: 'Votre code a été changé. Connectez-vous avec votre nouveau code.',
  });
}));
