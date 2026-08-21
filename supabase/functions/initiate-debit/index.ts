// POST /initiate-debit — the vendor proposes a debit.  (Amendment H, step 1)
//
// Creates a pending_debits row and returns nothing the vendor could use to
// authorise it themselves. The customer's PIN never appears on this path, is
// never sent to this endpoint, and is never observable by the vendor's device.
//
// Nothing moves yet: no balance changes, no ledger entry exists. The proposal
// lives for 180 seconds and is inert if it expires.

import {
  handler, json, fail, readJson, requireCaller, serviceClient,
} from '../_runtime/runtime.ts';
import { normaliseMsisdn, NormalisationError } from '../_shared/identity.ts';

interface Body {
  customerPhone?: string;
  amountCfa?: number;
  kind?: 'purchase' | 'refund' | 'reversal';
  idempotencyKey?: string;
  /**
   * Required when kind is 'reversal'. Only a CREDIT may be reversed this way:
   * the 15-minute unilateral window (0013) covers a typo spotted at the stall,
   * and this covers one noticed later, where the honest route is to ask the
   * customer to agree.
   */
  reversesEntryId?: string;
}

Deno.serve(handler(async (req) => {
  const caller = await requireCaller(req);
  const body = await readJson<Body>(req);
  const db = serviceClient();

  const kind = body.kind ?? 'purchase';
  if (kind !== 'purchase' && kind !== 'refund' && kind !== 'reversal') {
    return fail('KIND_INVALID', 'Type d\'opération invalide');
  }

  // A reversal must name what it reverses; nothing else may.
  if (kind === 'reversal' && !body.reversesEntryId) {
    return fail('REVERSAL_TARGET_REQUIRED', 'Écriture à corriger non précisée');
  }
  if (kind !== 'reversal' && body.reversesEntryId) {
    return fail('ONLY_REVERSAL_MAY_REFERENCE', 'Demande invalide');
  }

  const amount = body.amountCfa;
  if (!Number.isInteger(amount) || (amount as number) <= 0) {
    // Standing rule 5: integer FCFA only. No decimals, no centimes.
    return fail('AMOUNT_INVALID', 'Montant invalide');
  }

  let msisdn: string;
  try {
    msisdn = normaliseMsisdn(body.customerPhone ?? '');
  } catch (err) {
    if (err instanceof NormalisationError) return fail(err.code, err.message);
    throw err;
  }

  // ----- the calling vendor ------------------------------------------------
  const { data: vendor } = await db
    .from('vendors')
    .select('id, is_active')
    .eq('auth_user_id', caller.authUserId)
    .maybeSingle();

  if (!vendor) return fail('NOT_A_VENDOR', 'Compte commerçant introuvable', 403);
  if (!vendor.is_active) return fail('VENDOR_INACTIVE', 'Compte commerçant désactivé', 403);

  // ----- resolve the customer ---------------------------------------------
  // Through the rate-limited lookup (amendment F), which discloses existence
  // and this vendor's own label — never a name entered by another vendor.
  const { data: lookupRows, error: lookupErr } = await db.rpc(
    'lookup_customer_for_vendor',
    { p_vendor_id: vendor.id, p_phone: msisdn, p_actor_user_id: caller.authUserId }
  );
  if (lookupErr) throw lookupErr;

  const found = Array.isArray(lookupRows) ? lookupRows[0] : lookupRows;
  if (!found?.exists_in_system || !found.customer_id) {
    // A debit needs an existing balance, so an unknown number cannot be one.
    return fail('CUSTOMER_UNKNOWN', 'Ce client n\'a pas de monnaie chez vous', 404);
  }

  // ----- propose ----------------------------------------------------------
  const { data: pendingRows, error: pendErr } = await db.rpc('create_pending_debit', {
    p_vendor_id: vendor.id,
    p_customer_id: found.customer_id,
    p_kind: kind,
    p_amount_cfa: amount,
    p_idempotency_key: body.idempotencyKey ?? crypto.randomUUID(),
    p_actor_user_id: caller.authUserId,
    p_reverses_entry_id: body.reversesEntryId ?? null,
  });
  if (pendErr) throw pendErr;

  const pending = Array.isArray(pendingRows) ? pendingRows[0] : pendingRows;

  return json({
    ok: true,
    pendingId: pending.id,
    amountCfa: pending.amount_cfa,
    kind: pending.kind,
    expiresAt: pending.expires_at,
    yourLabel: found.your_label ?? null,
    // The vendor's screen polls pending_debits for this id and updates when
    // consumed_entry_id appears (amendment H, step 4).
    message: 'En attente de confirmation du client sur son téléphone',
  });
}));
