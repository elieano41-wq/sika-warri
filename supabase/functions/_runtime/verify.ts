// PIN verification against Supabase Auth.
//
// Extracted because login, change-pin and confirm-debit all need it, and three
// copies of a credential check would drift. The pepper-candidate loop in
// particular must behave identically everywhere or a half-finished rotation
// would self-heal on one path and lock the user out on another.

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { authEmailFor, derivePassword, type PepperSet } from '../_shared/identity.ts';
import { throwawayClient } from './runtime.ts';

export interface VerifyResult {
  ok: boolean;
  /** Which pepper version actually matched, when ok. */
  version: number | null;
  session: { access_token: string; refresh_token: string } | null;
}

/**
 * Check a PIN by attempting a sign-in on a throwaway client.
 *
 * Uses a client with persistSession disabled, discarded immediately, so the
 * caller's own session is never touched. That is what amendment H depends on:
 * verifying a customer's PIN must not disturb whoever is already signed in.
 *
 * Tries the stored version first, then every other configured version. See the
 * comment in login/index.ts — this is crash safety for the rotation, not
 * defensive padding.
 */
export async function verifyPin(
  msisdn: string,
  pin: string,
  peppers: PepperSet,
  storedVersion: number
): Promise<VerifyResult> {
  const email = authEmailFor(msisdn);

  const candidates = [
    storedVersion,
    ...[...peppers.byVersion.keys()].filter((v) => v !== storedVersion),
  ];

  for (const version of candidates) {
    const pepper = peppers.byVersion.get(version);
    if (!pepper) continue;

    const password = await derivePassword(pin, pepper, version);
    const { data, error } = await throwawayClient().auth.signInWithPassword({
      email,
      password,
    });

    if (!error && data?.session) {
      return {
        ok: true,
        version,
        session: {
          access_token: data.session.access_token,
          refresh_token: data.session.refresh_token,
        },
      };
    }
  }

  return { ok: false, version: null, session: null };
}

/**
 * Re-derive a credential under the current pepper and record it.
 *
 * Auth is updated before the row, deliberately: the two cannot share a
 * transaction, and if this dies in between, verifyPin's candidate loop finds
 * the credential next time and reconciles. The reverse order would leave the
 * row claiming a version the credential does not use.
 */
export async function upgradePepper(
  db: SupabaseClient,
  authUserId: string,
  msisdnPin: string,
  peppers: PepperSet,
  role: 'vendor' | 'customer'
): Promise<boolean> {
  const target = peppers.current;
  const pepper = peppers.byVersion.get(target);
  if (!pepper) return false;

  try {
    const password = await derivePassword(msisdnPin, pepper, target);

    const { error: authErr } = await db.auth.admin.updateUserById(authUserId, { password });
    if (authErr) throw authErr;

    const { error: recErr } = await db.rpc('record_pepper_upgrade', {
      p_auth_user_id: authUserId,
      p_new_version: target,
      p_role: role,
    });
    if (recErr) throw recErr;

    return true;
  } catch (err) {
    // Never fail the caller's operation because a background upgrade failed.
    console.error('PEPPER_UPGRADE_FAILED', (err as Error)?.message);
    return false;
  }
}
