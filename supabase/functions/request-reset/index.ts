// POST /request-reset — a vendor vouches for a customer's PIN reset.
//
// The vendor is authenticated; the customer is standing in front of them. This
// creates a short-lived, single-use claim that the customer then redeems on
// their own device via /reset-pin.
//
// Every request is attributed and logged. The customer sees it in their own
// history, and the frequency per vendor is capped in SQL rather than merely
// reported — a vendor who can reset customers at will is a vendor who can
// drain them.

import {
  handler, json, fail, readJson, requireCaller, serviceClient,
} from '../_runtime/runtime.ts';
import { normaliseMsisdn, NormalisationError } from '../_shared/identity.ts';

interface Body {
  customerPhone?: string;
  reason?: string;
}

Deno.serve(handler(async (req) => {
  const caller = await requireCaller(req);
  const body = await readJson<Body>(req);
  const db = serviceClient();

  let msisdn: string;
  try {
    msisdn = normaliseMsisdn(body.customerPhone ?? '');
  } catch (err) {
    if (err instanceof NormalisationError) return fail(err.code, err.message);
    throw err;
  }

  const { data: vendor } = await db
    .from('vendors')
    .select('id, is_active')
    .eq('auth_user_id', caller.authUserId)
    .maybeSingle();

  if (!vendor) return fail('NOT_A_VENDOR', 'Compte commerçant introuvable', 403);
  if (!vendor.is_active) return fail('VENDOR_INACTIVE', 'Compte désactivé', 403);

  const { data: customer } = await db
    .from('customers')
    .select('id')
    .eq('phone', msisdn)
    .maybeSingle();

  if (!customer) {
    return fail('CUSTOMER_UNKNOWN', "Ce numéro n'a pas de compte", 404);
  }

  // request_customer_pin_reset enforces the rest: that this vendor actually
  // deals with this customer, and the five-per-day cap.
  const { data: rows, error } = await db.rpc('request_customer_pin_reset', {
    p_vendor_id: vendor.id,
    p_customer_id: customer.id,
    p_actor_user_id: caller.authUserId,
    p_reason: body.reason ?? null,
  });
  if (error) throw error;

  const reset = Array.isArray(rows) ? rows[0] : rows;

  return json({
    ok: true,
    expiresAt: reset.expires_at,
    // Said back to the vendor so they tell the customer the right thing, and so
    // it is clear the vendor does not set the code themselves.
    message:
      "Le client peut maintenant choisir un nouveau code sur SON téléphone, " +
      "dans « J'ai oublié mon code ».",
  });
}));
