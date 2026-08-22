// POST /confirm-debt — the customer agrees to owe money, on their own device.
//
// ============================================================================
// THE HIGHEST-RISK CONFIRMATION IN THE SYSTEM.
//
// Everywhere else, a vendor who lies loses money: a fabricated change credit
// means they owe someone change they never held. A fabricated DEBT earns them
// money. So this endpoint is the one that has to be hardest to fake, and the
// design says so in three places:
//
//   1. It runs on the CUSTOMER's phone. The PIN travels from that device to this
//      function and nowhere else — not to the vendor, not entered on the
//      vendor's device, not observable by it.
//   2. There is NO vendor-device fallback. Amendment I lets a customer type
//      their code on the vendor's phone for a purchase, because a purchase spends
//      change the customer already holds. It is forbidden for debt: a vendor who
//      can type the customer's PIN can mint a debt from nothing. There is no
//      value to pass that would enable it — see migration 0029.
//   3. The SQL side refuses any session-bound caller outright (SW027), so this
//      function's service-role client is the ONLY path to a confirmed debt.
//
// Both factors are demanded, as in confirm-debit: the session proves who is
// asking, the PIN proves they are present and consenting right now.
// ============================================================================
//
// Two actions, because there are two things a customer can be asked to agree to:
//
//   'debt'         — accept a new debt (pending_debts)
//   'compensation' — offset change against an existing debt (pending_compensations)
//
// Each dispatches to exactly one SQL function reading exactly one table, so a
// mismatched id cannot be redirected: a compensation id passed as a debt simply
// is not found in pending_debts.

import {
  handler, json, fail, readJson, requireCaller, serviceClient, peppers,
} from '../_runtime/runtime.ts';
import { verifyPin, upgradePepper } from '../_runtime/verify.ts';
import { needsPepperUpgrade } from '../_shared/identity.ts';

interface Body {
  action?: 'debt' | 'compensation';
  pendingId?: string;
  pin?: string;
}

Deno.serve(handler(async (req) => {
  const caller = await requireCaller(req);
  const body = await readJson<Body>(req);
  const db = serviceClient();

  const action = body.action ?? 'debt';
  if (action !== 'debt' && action !== 'compensation') {
    return fail('ACTION_INVALID', 'Action inconnue');
  }

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
    // Not fed into the login lockout counter, same reasoning as confirm-debit:
    // coupling them would let anyone holding a stolen session lock the owner out
    // by guessing badly. And here it would be worse — a vendor could lock a
    // customer out of the very account they need to dispute a claim.
    return fail('BAD_PIN', 'Code incorrect', 401);
  }

  // ----- convert the proposal ---------------------------------------------
  if (action === 'debt') {
    // confirm_pending_debt re-checks under lock that this customer is the
    // addressee, that the proposal is neither consumed nor cancelled, and that
    // it has not expired — judged on the database clock, never the client's.
    const { data: rows, error } = await db.rpc('confirm_pending_debt', {
      p_pending_id: pendingId,
      p_actor_user_id: caller.authUserId,
    });
    if (error) throw error;

    const entry = Array.isArray(rows) ? rows[0] : rows;

    if (check.version !== null && needsPepperUpgrade(pepperSet, check.version)) {
      await upgradePepper(db, caller.authUserId, pin, pepperSet, 'customer');
    }

    return json({
      ok: true,
      action: 'debt',
      entryId: entry.id,
      amountCfa: entry.amount_cfa,
      // own_device. Reported back so the client can show the state it will see
      // everywhere else, rather than assuming it.
      confirmationMethod: entry.confirmation_method,
      message: 'Dette confirmée',
    });
  }

  // ----- compensation: the paired write ------------------------------------
  //
  // One transaction writes the change-side debit, the debt-side repayment, and
  // the compensations row whose two foreign keys tie them together. Both legs
  // re-check their own balance guard, so a stale proposal cannot overdraw the
  // change or overpay the debt.
  const { data: rows, error } = await db.rpc('confirm_pending_compensation', {
    p_pending_id: pendingId,
    p_actor_user_id: caller.authUserId,
  });
  if (error) throw error;

  const comp = Array.isArray(rows) ? rows[0] : rows;

  if (check.version !== null && needsPepperUpgrade(pepperSet, check.version)) {
    await upgradePepper(db, caller.authUserId, pin, pepperSet, 'customer');
  }

  // Both figures afterwards, separately. Never a single net number: the whole
  // point of the compensation is that it moved money between two registers that
  // stay two registers.
  const { data: solde } = await db
    .from('v_balances')
    .select('balance_cfa')
    .eq('vendor_id', comp.vendor_id)
    .eq('customer_id', comp.customer_id)
    .maybeSingle();

  const { data: detteRows } = await db
    .from('debt_entries')
    .select('direction, amount_cfa')
    .eq('vendor_id', comp.vendor_id)
    .eq('customer_id', comp.customer_id);

  const dette = (detteRows ?? []).reduce(
    (t: number, r: { direction: string; amount_cfa: number }) =>
      t + (r.direction === 'owed' ? r.amount_cfa : -r.amount_cfa),
    0
  );

  return json({
    ok: true,
    action: 'compensation',
    compensationId: comp.id,
    amountCfa: comp.amount_cfa,
    ledgerEntryId: comp.ledger_entry_id,
    debtEntryId: comp.debt_entry_id,
    remainingChangeCfa: solde?.balance_cfa ?? 0,
    remainingDebtCfa: dette,
    message: 'Compensation enregistrée',
  });
}));
