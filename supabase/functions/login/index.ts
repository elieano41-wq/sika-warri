// POST /login — exchange a phone number and PIN for a session.
//
// verify_jwt = false (amendment K). Nobody is authenticated yet, so this
// endpoint is publicly reachable, which makes the throttling below the ONLY
// thing standing in front of a PIN brute-force. Treated accordingly.

import {
  handler, json, fail, readJson, clientIp, recordAttempt,
  serviceClient, throwawayClient, peppers,
} from '../_runtime/runtime.ts';
import {
  normaliseMsisdn, authEmailFor, derivePassword, lockoutDecision,
  needsPepperUpgrade, NormalisationError, type Role,
} from '../_shared/identity.ts';

interface Body {
  phone?: string;
  pin?: string;
  role?: Role;
}

/** Per-IP failure ceiling, across all phone numbers. Per-phone counting cannot
 *  see one host working through a list. */
const MAX_IP_FAILURES = 40;

Deno.serve(handler(async (req) => {
  const body = await readJson<Body>(req);
  const ip = clientIp(req);
  const db = serviceClient();

  const role = body.role;
  if (role !== 'vendor' && role !== 'customer') {
    return fail('ROLE_INVALID', 'Type de compte invalide');
  }

  let msisdn: string;
  try {
    msisdn = normaliseMsisdn(body.phone ?? '');
  } catch (err) {
    if (err instanceof NormalisationError) return fail(err.code, err.message);
    throw err;
  }

  const pin = body.pin ?? '';
  if (!/^\d{4,6}$/.test(pin)) {
    // Shape only. A wrong-length PIN is still a failed attempt and must be
    // counted, or the lockout is trivially bypassed by sending junk.
    await recordAttempt(db, msisdn, false, ip);
    return fail('PIN_INVALID', 'Numéro ou code incorrect', 401);
  }

  // ----- lockout ----------------------------------------------------------
  const { data: lockRows, error: lockErr } = await db.rpc('auth_lock_state', {
    p_phone: msisdn,
  });
  if (lockErr) throw lockErr;

  const lock = Array.isArray(lockRows) ? lockRows[0] : lockRows;
  if (lock?.is_locked) {
    // Deliberately NOT recorded as another failure. The window slides over the
    // five most recent failures, so counting attempts made while already locked
    // would let a third party hammering the endpoint keep a legitimate user
    // locked out indefinitely.
    return fail(
      'ACCOUNT_LOCKED',
      lockoutDecision(lock.recent_failures ?? 5).message ?? 'Compte temporairement bloqué',
      423
    );
  }

  if (ip) {
    const { data: ipFailures } = await db.rpc('auth_ip_failure_count', { p_ip: ip });
    if (typeof ipFailures === 'number' && ipFailures >= MAX_IP_FAILURES) {
      return fail('RATE_LIMITED', 'Trop de tentatives, patientez quelques minutes', 429);
    }
  }

  // ----- find the profile -------------------------------------------------
  const table = role === 'vendor' ? 'vendors' : 'customers';
  const { data: profile } = await db
    .from(table)
    .select('id, auth_user_id, pepper_version')
    .eq('phone', msisdn)
    .maybeSingle();

  if (!profile?.auth_user_id) {
    // Same message as a wrong PIN, on purpose: distinguishing them turns this
    // endpoint into a phone-number oracle. The app offers a registration link
    // alongside so a genuinely new user is not stuck.
    await recordAttempt(db, msisdn, false, ip);
    return fail('BAD_CREDENTIALS', 'Numéro ou code incorrect', 401);
  }

  const email = authEmailFor(msisdn);
  const pepperSet = peppers();
  const storedVersion: number = profile.pepper_version ?? 1;

  // ----- verify the PIN ---------------------------------------------------
  //
  // Tries the version the row claims first, then every other configured
  // version. That second part is not belt-and-braces, it is crash safety: the
  // upgrade below writes to Supabase Auth and to Postgres, and those cannot
  // share a transaction. If the process dies between them, the row and the
  // credential disagree — and without this fallback the user would be
  // permanently unable to log in, with "wrong PIN" as their only clue.
  //
  // Trying a handful of HMACs costs microseconds and makes a half-finished
  // rotation self-healing.
  const candidates = [
    storedVersion,
    ...[...pepperSet.byVersion.keys()].filter((v) => v !== storedVersion),
  ];

  let session: { access_token: string; refresh_token: string } | null = null;
  let matchedVersion: number | null = null;

  for (const version of candidates) {
    const pepper = pepperSet.byVersion.get(version);
    if (!pepper) continue;

    const password = await derivePassword(pin, pepper, version);
    const client = throwawayClient();
    const { data, error } = await client.auth.signInWithPassword({ email, password });

    if (!error && data?.session) {
      session = {
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
      };
      matchedVersion = version;
      break;
    }
  }

  if (!session || matchedVersion === null) {
    await recordAttempt(db, msisdn, false, ip);

    // Re-read so the warning reflects this failure, not the state before it.
    const { data: afterRows } = await db.rpc('auth_lock_state', { p_phone: msisdn });
    const after = Array.isArray(afterRows) ? afterRows[0] : afterRows;
    const decision = lockoutDecision(after?.recent_failures ?? 0);

    return json(
      {
        ok: false,
        code: decision.locked ? 'ACCOUNT_LOCKED' : 'BAD_CREDENTIALS',
        message: decision.locked
          ? decision.message
          : 'Numéro ou code incorrect',
        // The 4th failure warns that the next one locks (acceptance test 9).
        warning: decision.warn ? decision.message : null,
        attemptsLeft: decision.attemptsLeft,
      },
      decision.locked ? 423 : 401
    );
  }

  await recordAttempt(db, msisdn, true, ip);

  // ----- lazy pepper upgrade  (amendment J, acceptance test 16) ------------
  //
  // This is the only moment the plaintext PIN legitimately exists on the
  // server, so it is the only moment the credential can be re-derived under a
  // newer pepper.
  let pepperUpgraded = false;

  if (needsPepperUpgrade(pepperSet, matchedVersion) || matchedVersion !== storedVersion) {
    const target = pepperSet.current;
    try {
      const newPassword = await derivePassword(
        pin,
        pepperSet.byVersion.get(target)!,
        target
      );

      // Auth first, then the row. If the process dies between the two, the
      // fallback loop above still finds the credential on the next login and
      // reconciles then.
      const { error: updErr } = await db.auth.admin.updateUserById(
        profile.auth_user_id,
        { password: newPassword }
      );
      if (updErr) throw updErr;

      const { error: recErr } = await db.rpc('record_pepper_upgrade', {
        p_auth_user_id: profile.auth_user_id,
        p_new_version: target,
        p_role: role,
      });
      if (recErr) throw recErr;

      pepperUpgraded = true;
    } catch (err) {
      // A failed upgrade must never fail the login. The user typed the right
      // PIN; they get their session, and the next login tries again.
      console.error('PEPPER_UPGRADE_FAILED', (err as Error)?.message);
    }
  }

  // ----- customer PIN hygiene  (amendment I) ------------------------------
  let pinChangeRequired = false;
  let vendorDeviceEntries = 0;

  if (role === 'customer') {
    const { data: cust } = await db
      .from('customers')
      .select('pin_change_required, vendor_device_notice_seen_at')
      .eq('id', profile.id)
      .maybeSingle();

    pinChangeRequired = Boolean(cust?.pin_change_required);

    if (pinChangeRequired) {
      // Surface the vendor_device history prominently at this first own-device
      // login, so the customer learns their PIN was typed on someone's till.
      const { count } = await db
        .from('ledger_entries')
        .select('id', { count: 'exact', head: true })
        .eq('customer_id', profile.id)
        .eq('confirmation_method', 'vendor_device');

      vendorDeviceEntries = count ?? 0;

      if (!cust?.vendor_device_notice_seen_at) {
        await db
          .from('customers')
          .update({ vendor_device_notice_seen_at: new Date().toISOString() })
          .eq('id', profile.id);
      }
    }
  }

  return json({
    ok: true,
    role,
    msisdn,
    session,
    pepperUpgraded,
    pinChangeRequired,
    vendorDeviceEntries,
    notice: pinChangeRequired
      ? "Votre code a déjà été saisi sur l'appareil d'un commerçant. Changez-le maintenant."
      : null,
  });
}));
