// POST /register — create ONE account, with both halves.
//
// ============================================================================
// THERE IS NO LONGER A ROLE TO PICK. Every account gets a vendors row AND a
// customers row, so from the first minute it can keep somebody's change, spend
// change somebody keeps for it, write down a debt owed to it, and confirm a debt
// it owes. Which side of a carnet you are on is a property of that carnet, not
// of your account.
//
// WHAT THIS FIXES. Before, only a "vendor" could record a debt owed to them. A
// tailor owed 6 000 F had to open a business-shaped account they did not
// recognise as theirs, and the signup screen made them declare an identity
// ("Je tiens le carnet" / "Je suis sur le carnet") that nobody standing at a
// counter thinks in. Both readings were wrong for somebody.
//
// WHAT MADE IT POSSIBLE. One PIN length. The 6/4 split was the only reason one
// phone number could not hold both halves, because the auth password is derived
// from the PIN. See PIN_LENGTH in _shared/identity.ts.
// ============================================================================
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
  /**
   * The name other people will see. One field now, where there were two.
   *
   * "Chez Awa" for a shop, "Awa" for somebody keeping track of what a
   * neighbour owes. Asking which of those you are was the question that had no
   * good answer, so it is not asked.
   */
  name?: string;
  /** Optional. Helps somebody recognise a name they half remember. */
  quartier?: string;
  commune?: string;
  termsAccepted?: boolean;

  /** Accepted and ignored, so an old client build does not break. */
  role?: Role;
  displayName?: string;
  businessName?: string;
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

  // No role gate. `body.role` is read nowhere; older builds may still send it
  // and it is deliberately ignored rather than rejected, so a phone running a
  // cached bundle can still create an account.
  //
  // `name` supersedes businessName and displayName, both of which are still
  // accepted for the same reason.
  const nom = cleanName(body.name ?? body.businessName ?? body.displayName);

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
  const rejection = checkPin(pin);
  if (rejection) return fail(rejection.code, rejection.message);

  // ----- what everybody must give ----------------------------------------
  // A name, because the other party has to recognise you on their own screen,
  // and the disclosure, because every account can now keep somebody else's
  // money. Section 6 required the acknowledgement of whoever holds change; that
  // is now everybody, so everybody ticks it. Stricter than before, and correct.
  //
  // The quartier is NOT required. It was mandatory because a shop has an
  // address; a person noting what a neighbour owes may not have an answer in
  // the doorway, and a required field with no answer is where a signup ends.
  if (!nom) {
    return fail('NAME_REQUIRED', 'Nom requis');
  }
  if (body.termsAccepted !== true) {
    return fail('TERMS_REQUIRED', "Vous devez accepter les conditions d'utilisation");
  }

  // ----- throttle ---------------------------------------------------------
  if (ip) {
    const { data: recent } = await db.rpc('auth_ip_failure_count', { p_ip: ip });
    if (typeof recent === 'number' && recent >= MAX_REGISTRATIONS_PER_IP) {
      return fail('RATE_LIMITED', 'Trop de tentatives, patientez quelques minutes', 429);
    }
  }

  // ----- already registered? ---------------------------------------------
  // PHONE_OTHER_ROLE is gone. There is no other role for a number to be taken
  // by; that error existed only to explain a limitation that no longer exists.
  //
  // Either half carrying an auth_user_id means this number has an account.
  const [{ data: dejaV }, { data: dejaC }] = await Promise.all([
    db.from('vendors').select('id, auth_user_id').eq('phone', msisdn).maybeSingle(),
    db.from('customers').select('id, auth_user_id').eq('phone', msisdn).maybeSingle(),
  ]);

  if (dejaV?.auth_user_id || dejaC?.auth_user_id) {
    return fail('ALREADY_REGISTERED', 'Ce numéro est déjà inscrit, connectez-vous', 409);
  }

  // A customers row with no auth_user_id is a STUB somebody created inline
  // while recording change for this number before it ever registered. It owns
  // real ledger history, so it must be linked, never replaced — replacing it
  // would orphan the balance they are registering in order to see.
  const existing = dejaC ?? null;

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
    // No role. It described a kind of account, and there is one kind now.
    user_metadata: { msisdn },
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

  // ----- both halves ------------------------------------------------------
  // ONE account, TWO rows, inserted together. Creating only the half the signup
  // screen happened to ask about is exactly the bug being fixed: it decided, at
  // the moment somebody typed a phone number, which of the two things they would
  // be allowed to write down for the rest of the account's life.
  //
  // The vendors row carries the name and the terms acknowledgement, because that
  // is the half that keeps other people's money. The customers row carries the
  // same name so the other party sees the same words whichever direction the
  // carnet runs in.
  let profileError: unknown = null;

  const { error: errV } = await db.from('vendors').insert({
    auth_user_id: authUserId,
    phone: msisdn,
    business_name: nom,
    // Nullable since 0042. '' would be a value nobody chose; null is honest.
    quartier: body.quartier?.trim() || null,
    commune: body.commune?.trim() || null,
    pepper_version: version,
    terms_accepted_at: new Date().toISOString(),
    terms_version: TERMS_VERSION,
  });
  profileError = errV;

  if (!profileError) {
    if (existing?.id) {
      // Linking the stub. Its ledger history survives; only the identity and
      // the name are filled in. A name already there is never overwritten with
      // an empty one — cleanName() has already turned '' into null.
      const patch: Record<string, unknown> = {
        auth_user_id: authUserId,
        pepper_version: version,
      };
      if (nom) patch.display_name = nom;
      const { error } = await db.from('customers').update(patch).eq('id', existing.id);
      profileError = error;
    } else {
      const { error } = await db.from('customers').insert({
        auth_user_id: authUserId,
        phone: msisdn,
        // The account's own name, set by them. Still distinct from
        // vendor_customer_labels, which is what somebody else privately calls
        // them and is never shown to anyone else (amendment F).
        display_name: nom,
        pepper_version: version,
      });
      profileError = error;
    }
  }

  if (profileError) {
    // Roll BOTH halves back, then the auth user. Leaving any of it behind would
    // make the phone number permanently unregisterable: createUser would keep
    // reporting "already exists" while the account was too broken to log in
    // against. A half-created account is worse than none — it would have a
    // ledger side and no way to reach it.
    //
    // The stub case deliberately un-links rather than deleting: the row predates
    // this attempt and owns somebody else's ledger history.
    await db.from('vendors').delete().eq('auth_user_id', authUserId).catch(() => {});
    if (existing?.id) {
      await db.from('customers')
        .update({ auth_user_id: null }).eq('id', existing.id).catch(() => {});
    } else {
      await db.from('customers').delete().eq('auth_user_id', authUserId).catch(() => {});
    }

    await db.auth.admin.deleteUser(authUserId).catch((e) => {
      console.error('ORPHAN_AUTH_USER', authUserId, e?.message);
    });
    console.error('PROFILE_INSERT_FAILED', profileError);
    return fail('REGISTRATION_FAILED', "Inscription impossible, réessayez", 500);
  }

  await recordAttempt(db, msisdn, true, ip);

  return json({
    ok: true,
    msisdn,
    linkedExistingRecord: Boolean(existing?.id),
    // Never the PIN, never the password, never the pepper (standing rule 11).
  });
}));
