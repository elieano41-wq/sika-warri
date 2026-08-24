// POST /change-pin — change your own PIN.
//
// verify_jwt = false (amendment K), so the caller is authenticated here in code
// via requireCaller. The current PIN is demanded as well as the session: a
// stolen phone with a live session must not be enough to lock the real owner
// out of their own account.
//
// This is also the path that clears pin_change_required (amendment I) — the
// obligation a customer picks up when their PIN was typed on a vendor's till.

import {
  handler, json, fail, readJson, requireCaller, serviceClient, peppers,
} from '../_runtime/runtime.ts';
import { verifyPin } from '../_runtime/verify.ts';
import { checkPin, derivePassword, type Role } from '../_shared/identity.ts';

interface Body {
  role?: Role;
  currentPin?: string;
  newPin?: string;
}

Deno.serve(handler(async (req) => {
  const caller = await requireCaller(req);
  const body = await readJson<Body>(req);
  const db = serviceClient();

  // No role. `body.role` may still arrive from a cached bundle; ignored.

  const currentPin = body.currentPin ?? '';
  const newPin = body.newPin ?? '';

  // Policy on the NEW pin only. The current one is whatever it is.
  // Six digits, always. This is the gate the 4-digit accounts drain through:
  // login still accepts theirs, but the replacement can only be six, so a code
  // that was four can never be four again.
  const rejection = checkPin(newPin);
  if (rejection) return fail(rejection.code, rejection.message);

  if (newPin === currentPin) {
    return fail('PIN_UNCHANGED', 'Le nouveau code doit être différent de l\'ancien');
  }

  // ----- who is this ------------------------------------------------------
  // Both halves share one credential, so either identifies the account. Both are
  // read: the pepper version has to be recorded on each, and the obligation is
  // cleared on the customers row.
  const [{ data: moitieV }, { data: moitieC }] = await Promise.all([
    db.from('vendors').select('id, phone, pepper_version')
      .eq('auth_user_id', caller.authUserId).maybeSingle(),
    db.from('customers').select('id, phone, pepper_version')
      .eq('auth_user_id', caller.authUserId).maybeSingle(),
  ]);

  const profile = moitieV ?? moitieC;

  if (!profile) {
    return fail('PROFILE_NOT_FOUND', 'Compte introuvable', 404);
  }

  // ----- prove they know the current PIN ----------------------------------
  const pepperSet = peppers();
  const check = await verifyPin(
    profile.phone,
    currentPin,
    pepperSet,
    profile.pepper_version ?? 1
  );

  if (!check.ok) {
    // Not counted toward the login lockout: this is an authenticated action,
    // and letting it feed that counter would give anyone holding a session a
    // way to lock the owner out.
    return fail('BAD_CURRENT_PIN', 'Code actuel incorrect', 401);
  }

  // ----- write the new credential -----------------------------------------
  const target = pepperSet.current;
  const password = await derivePassword(newPin, pepperSet.byVersion.get(target)!, target);

  const { error: authErr } = await db.auth.admin.updateUserById(caller.authUserId, {
    password,
  });
  if (authErr) {
    console.error('PIN_CHANGE_AUTH_FAILED', authErr.message);
    return fail('PIN_CHANGE_FAILED', 'Changement impossible, réessayez', 500);
  }

  // Record the version the credential now uses. If this fails the credential
  // still works — verifyPin's candidate loop finds it — so the change is not
  // rolled back.
  for (const r of [
    moitieV ? 'vendor' : null,
    moitieC ? 'customer' : null,
  ].filter(Boolean) as string[]) {
    const { error: recErr } = await db.rpc('record_pepper_upgrade', {
      p_auth_user_id: caller.authUserId,
      p_new_version: target,
      p_role: r,
    });
    if (recErr) console.error('PEPPER_VERSION_RECORD_FAILED', r, recErr.message);
  }

  // ----- clear the obligation  (amendment I) ------------------------------
  // Whatever the reason was — a code seen on somebody else's phone, or four
  // digits from before there was one length — it has now been dealt with, so
  // the reason is cleared alongside the flag. Leaving it set would make the
  // next diagnosis of a stale banner considerably harder.
  let clearedPinWarning = false;
  if (moitieC) {
    const { error } = await db
      .from('customers')
      .update({ pin_change_required: false, pin_change_reason: null })
      .eq('id', moitieC.id);

    if (error) {
      // The PIN did change, so say so — but do not claim the flag cleared.
      console.error('PIN_FLAG_CLEAR_FAILED', error.message);
    } else {
      clearedPinWarning = true;
    }
  }

  return json({
    ok: true,
    pepperVersion: target,
    clearedPinWarning,
    // All existing sessions keep working: only the credential changed. The
    // client should sign in again if it wants a session derived from the new
    // PIN, but nothing is broken if it does not.
    message: 'Votre code a été changé',
  });
}));
