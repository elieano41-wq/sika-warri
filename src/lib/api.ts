// The only place the app talks to the server.
//
// Deliberately plain fetch rather than supabase-js for the function calls: the
// header discipline matters more than the convenience. The publishable key goes
// on `apikey` and NOWHERE else — placed on Authorization, the platform parses it
// as a JWT and rejects the request with a bare "invalid JWT" (amendment K).
// Authorization carries a user session token, or nothing at all.

// Standing rule 6: fail loudly on missing config, naming exactly what is
// absent. No silent fallback to a default project.
const URL_BASE = import.meta.env.VITE_SUPABASE_URL;
const CLE = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!URL_BASE) {
  throw new Error('Configuration manquante : VITE_SUPABASE_URL');
}
if (!CLE) {
  throw new Error('Configuration manquante : VITE_SUPABASE_PUBLISHABLE_KEY');
}
if (!CLE.startsWith('sb_publishable_')) {
  // Catches a legacy JWT anon key left in place after the key migration. Those
  // are disabled on this project, and the resulting failures are obscure.
  throw new Error(
    'VITE_SUPABASE_PUBLISHABLE_KEY doit être une clé sb_publishable_ (les clés JWT héritées sont désactivées)'
  );
}

export type Role = 'vendor' | 'customer';

export interface Session {
  accessToken: string;
  refreshToken: string;
  role: Role;
  msisdn: string;
}

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly extra: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Anything the user reads is French; this is the last-resort wording. */
const ERREUR_RESEAU = 'Pas de connexion. Vérifiez votre réseau.';

async function request(
  path: string,
  init: RequestInit,
  token?: string | null
): Promise<unknown> {
  const headers = new Headers(init.headers);
  headers.set('apikey', CLE);
  headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);

  let res: Response;
  try {
    res = await fetch(`${URL_BASE}${path}`, { ...init, headers });
  } catch {
    // Offline, DNS failure, or the project paused. Distinguished from a server
    // rejection so the UI can say something true.
    throw new ApiError('OFFLINE', ERREUR_RESEAU, 0);
  }

  const text = await res.text();
  let body: any = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = null; }
  }

  if (!res.ok || body?.ok === false) {
    throw new ApiError(
      body?.code ?? `HTTP_${res.status}`,
      body?.message ?? "Une erreur est survenue, réessayez",
      res.status,
      body ?? {}
    );
  }

  return body;
}

const fn = (name: string, payload: unknown, token?: string | null) =>
  request(`/functions/v1/${name}`, { method: 'POST', body: JSON.stringify(payload) }, token);

const rpc = (name: string, args: unknown, token: string) =>
  request(`/rest/v1/rpc/${name}`, { method: 'POST', body: JSON.stringify(args) }, token);

const get = (query: string, token: string) =>
  request(`/rest/v1/${query}`, { method: 'GET' }, token);

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export async function login(role: Role, phone: string, pin: string) {
  const r = (await fn('login', { role, phone, pin })) as any;
  return {
    session: {
      accessToken: r.session.access_token,
      refreshToken: r.session.refresh_token,
      role,
      msisdn: r.msisdn,
    } as Session,
    pinChangeRequired: Boolean(r.pinChangeRequired),
    vendorDeviceEntries: Number(r.vendorDeviceEntries ?? 0),
    notice: (r.notice ?? null) as string | null,
  };
}

export async function register(input: {
  role: Role;
  phone: string;
  pin: string;
  businessName?: string;
  quartier?: string;
  commune?: string;
  termsAccepted?: boolean;
}) {
  return (await fn('register', input)) as { ok: true; msisdn: string };
}

export async function changePin(
  token: string,
  role: Role,
  currentPin: string,
  newPin: string
) {
  return (await fn('change-pin', { role, currentPin, newPin }, token)) as { ok: true };
}

// ---------------------------------------------------------------------------
// Vendor
// ---------------------------------------------------------------------------

export interface VendorProfile {
  id: string;
  authUserId: string;
  businessName: string;
  quartier: string;
  maxBalancePerCustomer: number;
}

export async function myVendor(token: string): Promise<VendorProfile> {
  const rows = (await get(
    'vendors?select=id,auth_user_id,business_name,quartier,max_balance_per_customer',
    token
  )) as any[];
  if (!rows?.length) throw new ApiError('NOT_A_VENDOR', 'Compte commerçant introuvable', 403);
  const v = rows[0];
  return {
    id: v.id,
    authUserId: v.auth_user_id,
    businessName: v.business_name,
    quartier: v.quartier,
    maxBalancePerCustomer: v.max_balance_per_customer,
  };
}

/** Existence plus this vendor's own label. Never another vendor's name. */
export async function lookupCustomer(
  token: string,
  vendorId: string,
  actorUserId: string,
  phone: string
) {
  const rows = (await rpc(
    'lookup_customer_for_vendor',
    { p_vendor_id: vendorId, p_phone: phone, p_actor_user_id: actorUserId },
    token
  )) as any[];
  const r = Array.isArray(rows) ? rows[0] : rows;
  return {
    exists: Boolean(r?.exists_in_system),
    customerId: (r?.customer_id ?? null) as string | null,
    yourLabel: (r?.your_label ?? null) as string | null,
    hasRelationship: Boolean(r?.has_relationship),
  };
}

/**
 * Garder la monnaie — record change the vendor could not give.
 *
 * A credit, so the vendor may post it directly with their own session: it only
 * ever increases what the customer holds and claims nothing about their consent.
 * Confirmed debits cannot be posted this way (migration 0014).
 */
export async function recordCredit(
  token: string,
  input: {
    vendorId: string;
    customerId: string;
    actorUserId: string;
    amountCfa: number;
    idempotencyKey: string;
    note?: string | null;
  }
) {
  const row = (await rpc(
    'post_ledger_entry',
    {
      p_vendor_id: input.vendorId,
      p_customer_id: input.customerId,
      p_direction: 'credit',
      p_kind: 'change',
      p_amount_cfa: input.amountCfa,
      p_idempotency_key: input.idempotencyKey,
      p_actor_user_id: input.actorUserId,
      p_customer_confirmed: false,
      p_reverses_entry_id: null,
      p_note: input.note ?? null,
      p_confirmation_method: null,
    },
    token
  )) as any;
  return row as { id: string; amount_cfa: number; created_at: string };
}

export async function receiptCode(token: string, entryId: string): Promise<string> {
  const r = (await rpc('entry_receipt_code', { p_entry_id: entryId }, token)) as any;
  return String(r);
}

export async function balanceWith(
  token: string,
  vendorId: string,
  customerId: string
): Promise<number> {
  const rows = (await get(
    `v_balances?select=balance_cfa&vendor_id=eq.${vendorId}&customer_id=eq.${customerId}`,
    token
  )) as any[];
  return rows?.[0]?.balance_cfa ?? 0;
}

/** Utiliser la monnaie — propose a debit for the customer to confirm. */
export async function initiateDebit(
  token: string,
  input: {
    customerPhone: string;
    amountCfa: number;
    kind?: 'purchase' | 'refund';
    idempotencyKey?: string;
  }
) {
  return (await fn('initiate-debit', input, token)) as {
    ok: true;
    pendingId: string;
    amountCfa: number;
    expiresAt: string;
  };
}

export interface PendingWatch {
  id: string;
  consumedEntryId: string | null;
  cancelledAt: string | null;
  expiresAt: string;
}

/** The vendor's screen polls this to know when the debit has landed. */
export async function watchPending(token: string, pendingId: string): Promise<PendingWatch | null> {
  const rows = (await get(
    `pending_debits?select=id,consumed_entry_id,cancelled_at,expires_at&id=eq.${pendingId}`,
    token
  )) as any[];
  const r = rows?.[0];
  if (!r) return null;
  return {
    id: r.id,
    consumedEntryId: r.consumed_entry_id,
    cancelledAt: r.cancelled_at,
    expiresAt: r.expires_at,
  };
}

export async function cancelPending(token: string, pendingId: string, actorUserId: string) {
  return rpc('cancel_pending_debit', { p_pending_id: pendingId, p_actor_user_id: actorUserId }, token);
}

// ---------------------------------------------------------------------------
// Customer
// ---------------------------------------------------------------------------

export interface CustomerProfile {
  id: string;
  authUserId: string;
}

export async function myCustomer(token: string): Promise<CustomerProfile> {
  const rows = (await get('customers?select=id,auth_user_id', token)) as any[];
  if (!rows?.length) throw new ApiError('NOT_A_CUSTOMER', 'Compte client introuvable', 403);
  return { id: rows[0].id, authUserId: rows[0].auth_user_id };
}

export interface PendingRequest {
  id: string;
  vendorId: string;
  businessName: string;
  kind: string;
  amountCfa: number;
  currentBalance: number;
  resultingBalance: number;
  secondsLeft: number;
}

/** What is waiting for this customer right now. Polled while the app is open. */
export async function pendingForMe(
  token: string,
  actorUserId: string
): Promise<PendingRequest[]> {
  const rows = (await rpc(
    'pending_debits_for_customer',
    { p_actor_user_id: actorUserId },
    token
  )) as any[];
  return (rows ?? []).map((r) => ({
    id: r.id,
    vendorId: r.vendor_id,
    businessName: r.business_name,
    kind: r.kind,
    amountCfa: r.amount_cfa,
    currentBalance: r.current_balance,
    resultingBalance: r.resulting_balance,
    secondsLeft: r.seconds_left,
  }));
}

/** Confirm on the customer's OWN device, with their own PIN. */
export async function confirmDebit(token: string, pendingId: string, pin: string) {
  return (await fn('confirm-debit', { pendingId, pin }, token)) as {
    ok: true;
    entryId: string;
    amountCfa: number;
    confirmationMethod: string;
    remainingCfa: number | null;
  };
}

/**
 * Rows for the customer's shop cards.
 *
 * Returns raw rows for lib/balances.ts to shape. This function does not sum,
 * fold or total anything — see acceptance test 8.
 */
export async function myShopBalances(token: string) {
  return (await get(
    'v_balances?select=vendor_id,balance_cfa,last_activity_at&order=balance_cfa.desc',
    token
  )) as Array<{ vendor_id: string; balance_cfa: number; last_activity_at: string | null }>;
}
