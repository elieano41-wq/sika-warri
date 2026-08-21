// POST /register — create a vendor or a customer.
//
// verify_jwt = false, and not by choice: the platform's built-in check only
// understands the legacy JWT keys, which are disabled on this project
// (amendment K). Nobody is authenticated here anyway — that is the point of
// registering — so this endpoint is publicly reachable and throttles itself.
//
// Registration happens ONCE, globally (amendment H). One phone, one PIN, valid
// at every vendor. There is no per-vendor enrolment and no per-vendor code.

import {
  handler, json, fail, readJson, clientIp, recordAttempt,
  serviceClient, peppers, requireEnv,
} from '../_runtime/runtime.ts';
import {
  normaliseMsisdn, authEmailFor, checkPin, derivePassword,
  NormalisationError, type Role,
} from '../_shared/identity.ts';

/** The disclosure a vendor must acknowledge. Version is stored alongside the
 *  timestamp so a later revision does not inherit consent given to this one. */
const TERMS_VERSION = 'v1';

interface Body {
  phone?: string;
  pin?: string;
  role?: Role;
  /** A customer's own first name. The only personal detail collected. */
  displayName?: string;
  businessName?: string;
  quartier?: string;
  commune?: string;
  termsAccepted?: boolean;
}

/** Trim and cap a free-text name. Empty becomes null rather than ''. */
function cleanName(value: string | undefined): string | null {
  const trimmed = (value ?? '').trim().replace(/\s+/g, ' ');
  return trimmed === '' ? null : trimmed.slice(0, 60);
}

/** Registration abuse ceiling per IP. Generous for a shared connection in a
 *  market, fatal to a script creating accounts in bulk. */
const MAX_REGISTRATIONS_PER_IP = 20;

Deno.serve(handler(async (req) => {
  const body = await readJson<Body>(req);
  const ip = clientIp(req);
  const db = serviceClient();

  // ----- role -------------------------------------------------------------
  const role = body.role;
  if (role !== 'vendor' && role !== 'customer') {
    return fail('ROLE_INVALID', 'Type de compte invalide');
  }

  // ----- phone ------------------------------------------------------------
  let msisdn: string;
  try {
    msisdn = normaliseMsisdn(body.phone ?? '');
  } catch (err) {
    if (err instanceof NormalisationError) return fail(err.code, err.message);
    throw err;
  }

  // ----- PIN --------------------------------------------------------------
  const pin = body.pin ?? '';
  const rejection = checkPin(pin, role);
  if (rejection) return fail(rejection.code, rejection.message);

  // ----- vendor-only requirements -----------------------------------------
  if (role === 'vendor') {
    if (!body.businessName?.trim()) {
      return fail('BUSINESS_NAME_REQUIRED', 'Nom de la boutique requis');
    }
    if (!body.quartier?.trim()) {
      return fail('QUARTIER_REQUIRED', 'Quartier requis');
    }
    // Section 6: the acknowledgement is explicit, timestamped and stored. A
    // vendor who has not ticked it cannot be created at all.
    if (body.termsAccepted !== true) {
      return fail('TERMS_REQUIRED', "Vous devez accepter les conditions d'utilisation");
    }
  }

  // ----- throttle ---------------------------------------------------------
  if (ip) {
    const { data: recent } = await db.rpc('auth_ip_failure_count', { p_ip: ip });
    if (typeof recent === 'number' && recent >= MAX_REGISTRATIONS_PER_IP) {
      return fail('RATE_LIMITED', 'Trop de tentatives, patientez quelques minutes', 429);
    }
  }

  // ----- one phone, one role ----------------------------------------------
  // The auth user is keyed on the phone number, and a vendor PIN is 6 digits
  // where a customer's is 4 — so one auth user cannot serve both roles. If the
  // number is taken by the other role we say so plainly rather than producing a
  // half-usable account. Flagged as a known limitation.
  const otherTable = role === 'vendor' ? 'customers' : 'vendors';
  const { data: conflict } = await db
    .from(otherTable)
    .select('id')
    .eq('phone', msisdn)
    .maybeSingle();

  if (conflict) {
    return fail(
      'PHONE_OTHER_ROLE',
      role === 'vendor'
        ? 'Ce numéro est déjà utilisé comme compte client'
        : 'Ce numéro est déjà utilisé comme compte commerçant',
      409
    );
  }

  const table = role === 'vendor' ? 'vendors' : 'customers';
  const { data: existing } = await db
    .from(table)
    .select('id, auth_user_id')
    .eq('phone', msisdn)
    .maybeSingle();

  if (existing?.auth_user_id) {
    return fail('ALREADY_REGISTERED', 'Ce numéro est déjà inscrit, connectez-vous', 409);
  }

  // ----- credential -------------------------------------------------------
  const pepperSet = peppers();
  const version = pepperSet.current;
  const password = await derivePassword(pin, pepperSet.byVersion.get(version)!, version);
  const email = authEmailFor(msisdn);

  const { data: created, error: createErr } = await db.auth.admin.createUser({
    email,
    password,
    // No mailbox exists behind this address, so there is nothing to confirm.
    email_confirm: true,
    user_metadata: { role, msisdn },
  });

  if (createErr || !created?.user) {
    if (ip) await recordAttempt(db, msisdn, false, ip);
    // An auth user may already exist from a previous half-finished attempt.
    if ((createErr?.message ?? '').toLowerCase().includes('already')) {
      return fail('ALREADY_REGISTERED', 'Ce numéro est déjà inscrit, connectez-vous', 409);
    }
    console.error('AUTH_CREATE_FAILED', createErr?.message);
    return fail('REGISTRATION_FAILED', "Inscription impossible, réessayez", 500);
  }

  const authUserId = created.user.id;

  // ----- profile row ------------------------------------------------------
  // existing.id means a vendor already created this customer inline while
  // recording change for them. That row owns real ledger history, so it must be
  // LINKED, never replaced — replacing it would orphan the balance they are
  // registering to see.
  let profileError: unknown = null;

  if (existing?.id) {
    // Linking a stub a vendor created inline. The customer's own name takes
    // precedence over nothing, but never overwrites a name already there with
    // an empty one.
    const patch: Record<string, unknown> = {
      auth_user_id: authUserId,
      pepper_version: version,
    };
    const nom = cleanName(body.displayName);
    if (role === 'customer' && nom) patch.display_name = nom;

    const { error } = await db.from(table).update(patch).eq('id', existing.id);
    profileError = error;
  } else if (role === 'vendor') {
    const { error } = await db.from('vendors').insert({
      auth_user_id: authUserId,
      phone: msisdn,
      business_name: body.businessName!.trim(),
      quartier: body.quartier!.trim(),
      commune: body.commune?.trim() ?? null,
      pepper_version: version,
      terms_accepted_at: new Date().toISOString(),
      terms_version: TERMS_VERSION,
    });
    profileError = error;
  } else {
    const { error } = await db.from('customers').insert({
      auth_user_id: authUserId,
      phone: msisdn,
      // The customer's own name, set by them. Distinct from
      // vendor_customer_labels, which is what a vendor privately calls them
      // and is never shown to anyone else (amendment F).
      display_name: cleanName(body.displayName),
      pepper_version: version,
    });
    profileError = error;
  }

  if (profileError) {
    // Roll the auth user back. Leaving it behind would make the phone number
    // permanently unregisterable: createUser would keep reporting "already
    // exists" while no profile row exists to log in against.
    await db.auth.admin.deleteUser(authUserId).catch((e) => {
      console.error('ORPHAN_AUTH_USER', authUserId, e?.message);
    });
    console.error('PROFILE_INSERT_FAILED', profileError);
    return fail('REGISTRATION_FAILED', "Inscription impossible, réessayez", 500);
  }

  await recordAttempt(db, msisdn, true, ip);

  return json({
    ok: true,
    role,
    msisdn,
    linkedExistingRecord: Boolean(existing?.id),
    // Never the PIN, never the password, never the pepper (standing rule 11).
  });
}));
