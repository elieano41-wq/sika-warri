// POST /reset-pin — set a new PIN using a vouched reset.
//
// Called from a LOGGED-OUT device, because that is the whole situation: the
// person cannot sign in. So there is no session to validate, and the only thing
// standing behind this endpoint is an open, single-use, short-lived reset that
// somebody vouched for in person.
//
// Two actions:
//   { phone }              -> is there an open claim? (so the UI can say so)
//   { phone, newPin, role } -> claim it and set the PIN
//
// verify_jwt = false, necessarily. Rate limited hard, because a public endpoint
// that changes credentials is exactly what gets hammered.

import {
  handler, json, fail, readJson, clientIp, recordAttempt,
  serviceClient, peppers,
} from '../_runtime/runtime.ts';
import {
  normaliseMsisdn, checkPin, derivePassword, NormalisationError, type Role,
} from '../_shared/identity.ts';

interface Body {
  phone?: string;
  role?: Role;
  newPin?: string;
}

/** Per-IP ceiling. Lower than login: nobody legitimately resets in bulk. */
const MAX_IP_ATTEMPTS = 12;

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
    if (typeof recent === 'number' && recent >= MAX_IP_ATTEMPTS) {
      return fail('RATE_LIMITED', 'Trop de tentatives, patientez quelques minutes', 429);
    }
  }

  // ----- is there an open claim? -------------------------------------------
  const { data: rows, error: lookupErr } = await db.rpc('open_pin_reset_for_phone', {
    p_phone: msisdn,
  });
  if (lookupErr) throw lookupErr;

  const claim = Array.isArray(rows) ? rows[0] : rows;

  if (!claim) {
    // Recorded as a failed attempt so the per-IP counter sees probing.
    await recordAttempt(db, msisdn, false, ip);
    return fail(
      'NO_RESET',
      "Aucune réinitialisation en cours pour ce numéro. Demandez à un commerçant chez qui vous avez de la monnaie.",
      404
    );
  }

  // Enquiry only: tell the UI a claim exists, and who vouched, so the person
  // can see it is the reset they just asked for and not a stranger's.
  if (body.newPin === undefined) {
    return json({
      ok: true,
      pending: true,
      role: claim.target_role,
      vouchedBy: claim.vouched_by ?? null,
      expiresAt: claim.expires_at,
    });
  }

  // ----- claim it ----------------------------------------------------------
  const role: Role = claim.target_role === 'vendor' ? 'vendor' : 'customer';

  // The role is taken from the CLAIM, never from the request body. A caller
  // asking to reset as a vendor when the claim is for a customer would
  // otherwise pick their own PIN length and the credential would not match.
  if (body.role && body.role !== role) {
    return fail('ROLE_MISMATCH', 'Type de compte incohérent', 400);
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

  // Auth first, then mark the claim used. If this dies in between, the claim
  // stays open and the person can try again — the safe direction. The reverse
  // order would consume the claim and leave them locked out with no second
  // chance.
  const { error: authErr } = await db.auth.admin.updateUserById(claim.auth_user_id, {
    password,
  });
  if (authErr) {
    console.error('RESET_AUTH_FAILED', authErr.message);
    return fail('RESET_FAILED', 'Réinitialisation impossible, réessayez', 500);
  }

  const { error: consumeErr } = await db.rpc('consume_pin_reset', {
    p_reset_id: claim.reset_id,
    p_ip: ip,
  });
  if (consumeErr) {
    // The PIN did change. Say so rather than telling them to try again with a
    // code that now works.
    console.error('RESET_CONSUME_FAILED', consumeErr.message);
  }

  const { error: recErr } = await db.rpc('record_pepper_upgrade', {
    p_auth_user_id: claim.auth_user_id,
    p_new_version: target,
    p_role: role,
  });
  if (recErr) console.error('RESET_PEPPER_RECORD_FAILED', recErr.message);

  await recordAttempt(db, msisdn, true, ip);

  return json({
    ok: true,
    role,
    message: 'Votre code a été réinitialisé. Connectez-vous avec votre nouveau code.',
  });
}));
