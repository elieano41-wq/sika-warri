// POST /confirm-debit — the customer accepts, on their own device.
// (Amendment H, step 3)
//
// This endpoint is called from the CUSTOMER's phone, never the vendor's. The
// PIN travels from the customer's own device to this function and nowhere else:
// it is not sent to the vendor, not entered on the vendor's device, and not
// observable by it. That is the entire point of amendment H — a PIN the vendor
// has seen proves nothing about consent to any particular transaction.
//
// verify_jwt = false (amendment K), so the customer's session is validated here
// in code. Both factors are demanded: the session proves who is asking, the PIN
// proves they are present and consenting right now. A stolen unlocked phone
// with a live session is therefore not enough to spend someone's change.

import {
  handler, json, fail, readJson, requireCaller, serviceClient, peppers,
} from '../_runtime/runtime.ts';
import { verifyPin, upgradePepper } from '../_runtime/verify.ts';
import { needsPepperUpgrade } from '../_shared/identity.ts';

interface Body {
  pendingId?: string;
  pin?: string;
}

Deno.serve(handler(async (req) => {
  const caller = await requireCaller(req);
  const body = await readJson<Body>(req);
  const db = serviceClient();

  const pendingId = body.pendingId?.trim();
  if (!pendingId) return fail('PENDING_ID_REQUIRED', 'Demande introuvable');

  const pin = body.pin ?? '';
  if (!/^\d{4,6}$/.test(pin)) return fail('PIN_INVALID', 'Code incorrect', 401);

  // ----- the calling customer ---------------------------------------------
  const { data: customer } = await db
    .from('customers')
    .select('id, phone, pepper_version')
    .eq('auth_user_id', caller.authUserId)
    .maybeSingle();

  if (!customer) return fail('NOT_A_CUSTOMER', 'Compte client introuvable', 403);

  // ----- verify the PIN ---------------------------------------------------
  const pepperSet = peppers();
  const check = await verifyPin(
    customer.phone,
    pin,
    pepperSet,
    customer.pepper_version ?? 1
  );

  if (!check.ok) {
    // Deliberately not fed into the login lockout counter. This is an
    // authenticated action, and coupling it would let anyone holding a stolen
    // session lock the owner out of their own account by guessing badly.
    return fail('BAD_PIN', 'Code incorrect', 401);
  }

  // ----- convert the proposal ---------------------------------------------
  //
  // confirm_pending_debit re-checks everything that matters under a row lock:
  // that this customer is the addressee, that the proposal is neither consumed
  // nor cancelled, and that it has not expired. Expiry is judged against the
  // database clock, never a client's.
  const { data: entryRows, error: confirmErr } = await db.rpc('confirm_pending_debit', {
    p_pending_id: pendingId,
    p_customer_actor_user_id: caller.authUserId,
  });
  if (confirmErr) throw confirmErr;

  const entry = Array.isArray(entryRows) ? entryRows[0] : entryRows;

  // ----- opportunistic pepper upgrade  (amendment J) ----------------------
  // The plaintext PIN is in hand and already verified, so this is a legitimate
  // moment to re-derive the credential. Never blocks the debit.
  if (check.version !== null && needsPepperUpgrade(pepperSet, check.version)) {
    await upgradePepper(db, caller.authUserId, pin, pepperSet, 'customer');
  }

  // ----- what the customer sees -------------------------------------------
  const { data: balanceRow } = await db
    .from('v_balances')
    .select('balance_cfa')
    .eq('vendor_id', entry.vendor_id)
    .eq('customer_id', entry.customer_id)
    .maybeSingle();

  return json({
    ok: true,
    entryId: entry.id,
    amountCfa: entry.amount_cfa,
    kind: entry.kind,
    confirmationMethod: entry.confirmation_method, // own_device
    remainingCfa: balanceRow?.balance_cfa ?? null,
    message: 'Confirmé',
  });
}));
