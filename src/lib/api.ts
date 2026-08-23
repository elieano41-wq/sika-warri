// The only place the app talks to the server.
//
// Deliberately plain fetch rather than supabase-js for the function calls: the
// header discipline matters more than the convenience. The publishable key goes
// on `apikey` and NOWHERE else — placed on Authorization, the platform parses it
// as a JWT and rejects the request with a bare "invalid JWT" (amendment K).
// Authorization carries a user session token, or nothing at all.

import { normaliseMsisdn } from '../../supabase/functions/_shared/identity';

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
    isAdmin: Boolean(r.isAdmin),
    pinChangeRequired: Boolean(r.pinChangeRequired),
    vendorDeviceEntries: Number(r.vendorDeviceEntries ?? 0),
    notice: (r.notice ?? null) as string | null,
  };
}

export async function register(input: {
  role: Role;
  phone: string;
  pin: string;
  displayName?: string;
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
  /** The debt ceiling for one customer. Configurable, default 10 000 F. */
  maxDebtPerCustomer: number;
}

export async function myVendor(token: string): Promise<VendorProfile> {
  const rows = (await get(
    'vendors?select=id,auth_user_id,business_name,quartier,max_balance_per_customer,max_debt_per_customer',
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
    maxDebtPerCustomer: v.max_debt_per_customer,
  };
}

/**
 * Existence plus this vendor's own label. Never another vendor's name.
 *
 * Normalises the number HERE rather than trusting the caller. The database
 * stores the E.164 form (2250701020304) and the lookup is an exact match, so a
 * screen passing the local 10 digits a vendor typed finds nothing and reports
 * "not registered" about a customer who plainly is. The Edge Functions normalise
 * their own input; this direct PostgREST path had no such step.
 *
 * Shared with the Edge Functions rather than reimplemented: two copies of phone
 * normalisation is how one person ends up with two accounts holding separate
 * balances at the same shop.
 */
export async function lookupCustomer(
  token: string,
  vendorId: string,
  actorUserId: string,
  phone: string
) {
  const msisdn = normaliseMsisdn(phone);
  const rows = (await rpc(
    'lookup_customer_for_vendor',
    { p_vendor_id: vendorId, p_phone: msisdn, p_actor_user_id: actorUserId },
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
  /**
   * Their code was typed on a VENDOR'S phone, so somebody else has seen it.
   *
   * Read from the profile on load, not from the login response. It is set at the
   * counter — while the customer is using the app — so a warning delivered only
   * at login waits for a sign-out that may never come. The one message that says
   * "change your code" must not depend on that.
   */
  pinChangeRequired: boolean;
}

export async function myCustomer(token: string): Promise<CustomerProfile> {
  const rows = (await get(
    'customers?select=id,auth_user_id,pin_change_required', token
  )) as any[];
  if (!rows?.length) throw new ApiError('NOT_A_CUSTOMER', 'Compte client introuvable', 403);
  return {
    id: rows[0].id,
    authUserId: rows[0].auth_user_id,
    pinChangeRequired: Boolean(rows[0].pin_change_required),
  };
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

// ---------------------------------------------------------------------------
// Reading balances and history
//
// These go through definer functions (migration 0015) rather than plain
// selects, because a customer cannot read the vendors table and a vendor cannot
// read the customers table — each row carries names belonging to other people
// (amendment F). The functions disclose exactly what an existing relationship
// justifies.
// ---------------------------------------------------------------------------

export interface ShopRow {
  vendor_id: string;
  business_name: string;
  quartier: string | null;
  commune: string | null;
  balance_cfa: number;
  last_activity_at: string | null;
  entry_count: number;
  /** Shown to the customer: an unverified shop is visibly unverified. */
  vendor_verified: boolean;
}

/**
 * One row per shop holding this customer's change. Never a total.
 *
 * This is a PAGE, not the whole truth. Anything that needs a figure covering
 * every shop must call myShopSummary() instead of adding these up.
 */
export async function myShops(token: string, actorUserId: string): Promise<ShopRow[]> {
  const rows = (await rpc(
    'customer_shop_balances',
    { p_actor_user_id: actorUserId, p_limit: 100 },
    token
  )) as ShopRow[];
  return rows ?? [];
}

export interface CustomerSummary {
  total_cfa: number;
  shop_count: number;
  last_activity_at: string | null;
}

/**
 * The informational total and the shop count, aggregated server-side.
 *
 * One row, so it cannot be truncated. Exists because both figures used to be
 * folded out of myShops() above, which is bounded.
 */
export async function myShopSummary(
  token: string,
  actorUserId: string
): Promise<CustomerSummary> {
  const rows = (await rpc(
    'customer_summary',
    { p_actor_user_id: actorUserId },
    token
  )) as CustomerSummary[];
  const r = Array.isArray(rows) ? rows[0] : rows;
  return r ?? { total_cfa: 0, shop_count: 0, last_activity_at: null };
}

export interface EntryRow {
  id: string;
  direction: 'credit' | 'debit';
  kind: string;
  amount_cfa: number;
  confirmation_method: string | null;
  note: string | null;
  created_at: string;
  receipt_code: string;
  running_balance: number;
}

export async function myShopHistory(
  token: string,
  actorUserId: string,
  vendorId: string
): Promise<EntryRow[]> {
  const rows = (await rpc(
    'customer_shop_history',
    { p_actor_user_id: actorUserId, p_vendor_id: vendorId, p_limit: 100 },
    token
  )) as EntryRow[];
  return rows ?? [];
}

/**
 * Every movement, across every counterparty.
 *
 * NO running_balance, unlike the per-pair histories above, and that is the
 * design rather than an omission. A running balance down a list that mixes
 * vendors would be a cross-vendor total accumulated one row at a time —
 * standing rule 1 broken in a column, where it would look like arithmetic
 * instead of a claim about who owes what. Each row carries its own amount and
 * names its counterparty; nothing adds up.
 */
export interface MovementRow {
  id: string;
  direction: 'credit' | 'debit';
  kind: string;
  amount_cfa: number;
  confirmation_method: string | null;
  note: string | null;
  created_at: string;
  receipt_code: string;
  /** The true number of movements, so a truncated page is visibly truncated. */
  total_count: number;
}

export interface VendorMovementRow extends MovementRow {
  customer_id: string;
  customer_phone: string;
  customer_label: string | null;
}

export interface CustomerMovementRow extends MovementRow {
  vendor_id: string;
  business_name: string;
}

/** A vendor's whole ledger, newest first. Bounded. */
export async function vendorHistory(
  token: string,
  actorUserId: string,
  vendorId: string,
  limit = 100
): Promise<VendorMovementRow[]> {
  const rows = (await rpc(
    'vendor_history',
    { p_vendor_id: vendorId, p_actor_user_id: actorUserId, p_limit: limit },
    token
  )) as VendorMovementRow[];
  return rows ?? [];
}

/** A customer's movements at every shop, newest first. Bounded. */
export async function myHistory(
  token: string,
  actorUserId: string,
  limit = 100
): Promise<CustomerMovementRow[]> {
  const rows = (await rpc(
    'customer_history',
    { p_actor_user_id: actorUserId, p_limit: limit },
    token
  )) as CustomerMovementRow[];
  return rows ?? [];
}

export interface ClientRow {
  customer_id: string;
  phone: string;
  your_label: string | null;
  balance_cfa: number;
  last_activity_at: string | null;
  entry_count: number;
  is_registered: boolean;
  /** How many customers this vendor has in total, not how many rows came back. */
  total_count: number;
}

/** Who this vendor owes, largest first. */
export async function myClients(
  token: string,
  vendorId: string,
  actorUserId: string
): Promise<ClientRow[]> {
  const rows = (await rpc(
    'vendor_customers',
    { p_vendor_id: vendorId, p_actor_user_id: actorUserId, p_limit: 200 },
    token
  )) as ClientRow[];
  return rows ?? [];
}

export async function clientHistory(
  token: string,
  vendorId: string,
  customerId: string,
  actorUserId: string
): Promise<EntryRow[]> {
  const rows = (await rpc(
    'vendor_customer_history',
    {
      p_vendor_id: vendorId,
      p_customer_id: customerId,
      p_actor_user_id: actorUserId,
      p_limit: 100,
    },
    token
  )) as EntryRow[];
  return rows ?? [];
}

export interface VendorSummary {
  circulation_cfa: number;
  customers_owed: number;
  today_credit_cfa: number;
  today_credit_count: number;
  today_debit_cfa: number;
  today_debit_count: number;
  last_activity_at: string | null;
}

/** What the vendor home screen shows: what they owe, and today's activity. */
export async function vendorSummary(
  token: string,
  vendorId: string,
  actorUserId: string
): Promise<VendorSummary> {
  const rows = (await rpc(
    'vendor_home_summary',
    { p_vendor_id: vendorId, p_actor_user_id: actorUserId },
    token
  )) as VendorSummary[];
  const r = Array.isArray(rows) ? rows[0] : rows;
  return (
    r ?? {
      circulation_cfa: 0, customers_owed: 0,
      today_credit_cfa: 0, today_credit_count: 0,
      today_debit_cfa: 0, today_debit_count: 0,
      last_activity_at: null,
    }
  );
}

// ---------------------------------------------------------------------------
// Customer labels (per vendor, private to that vendor)
// ---------------------------------------------------------------------------

/**
 * Name a customer, for this vendor only.
 *
 * Written to vendor_customer_labels, never to customers.display_name: that one
 * belongs to the customer, and a label written here is never visible to another
 * vendor or to the customer themselves (amendment F).
 */
export async function setCustomerLabel(
  token: string,
  vendorId: string,
  customerId: string,
  label: string,
  actorUserId: string
): Promise<string | null> {
  const r = (await rpc(
    'set_vendor_customer_label',
    {
      p_vendor_id: vendorId,
      p_customer_id: customerId,
      p_label: label,
      p_actor_user_id: actorUserId,
    },
    token
  )) as string | null;
  return r ?? null;
}

// ---------------------------------------------------------------------------
// PIN recovery
// ---------------------------------------------------------------------------

/**
 * Ask the support desk for a reset.
 *
 * The reply is IDENTICAL whether or not the number is registered, so this
 * cannot be used to discover which numbers have accounts.
 */
export async function requestSupportReset(phone: string) {
  return (await fn('reset-pin', { phone, request: true })) as {
    ok: true;
    requested: true;
    message: string;
  };
}

/** Check a temporary code before asking the person for a new PIN. */
export async function checkTempCode(phone: string, code: string) {
  return (await fn('reset-pin', { phone, code })) as {
    ok: true;
    valid: true;
    role: Role;
  };
}

/** Redeem the code and set a new PIN. */
export async function redeemTempCode(phone: string, code: string, newPin: string) {
  return (await fn('reset-pin', { phone, code, newPin })) as {
    ok: true;
    role: Role;
    message: string;
  };
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export interface ResetRequest {
  request_id: string;
  phone: string;
  requested_at: string;
  account_exists: boolean;
  role: 'vendor' | 'customer' | null;
  nom: string | null;
  quartier: string | null;
  registered_at: string | null;
  contexte: string | null;
  derniers: string[] | null;
  prior_resets: number;
}

export interface AdminVendor {
  /** Total vendors, regardless of how many rows this page returned. */
  total_count?: number;
  vendor_id: string;
  business_name: string;
  quartier: string;
  commune: string | null;
  phone: string;
  is_active: boolean;
  phone_verified_at: string | null;
  verification_method: string | null;
  joined_at: string;
  circulation_cfa: number;
  customers_owed: number;
  entry_count: number;
  last_activity_at: string | null;
  debits: number;
  vendor_device_debits: number;
  vendor_device_pct: number | null;
  vendor_corrections: number;
}

const admin = (token: string, payload: unknown) => fn('admin', payload, token);

export async function adminResetQueue(token: string): Promise<ResetRequest[]> {
  const r = (await admin(token, { action: 'reset_queue' })) as any;
  return r.requests ?? [];
}

/**
 * Issue a temporary code.
 *
 * The code is generated server-side by a CSPRNG and returned exactly once. It
 * is stored only as a salted hash, so it cannot be looked up again — by anyone,
 * including the operator who issued it.
 */
export async function adminIssueReset(token: string, requestId: string) {
  return (await admin(token, { action: 'issue_reset', requestId })) as {
    ok: true;
    code: string;
    expiresAt: string;
    role: Role;
    message: string;
  };
}

export async function adminRejectReset(token: string, requestId: string, note?: string) {
  return (await admin(token, { action: 'reject_reset', requestId, note })) as { ok: true };
}

export async function adminVendorList(token: string): Promise<AdminVendor[]> {
  const r = (await admin(token, { action: 'vendor_list' })) as any;
  return r.vendors ?? [];
}

export async function adminVerifyPhone(
  token: string,
  role: 'vendor' | 'customer',
  targetId: string,
  method: 'in_person' | 'sms' = 'in_person'
) {
  return (await admin(token, { action: 'verify_phone', role, targetId, method })) as {
    ok: true;
    verifiedAt: string;
  };
}

export async function adminSetVendorActive(token: string, vendorId: string, active: boolean) {
  return (await admin(token, { action: 'set_vendor_active', vendorId, active })) as {
    ok: true;
    active: boolean;
  };
}

/** Resets performed on my own account, so the customer can see them. */
export async function myResets(token: string, actorUserId: string) {
  const rows = (await rpc('my_pin_resets', { p_actor_user_id: actorUserId }, token)) as Array<{
    id: string;
    reset_at: string;
    libelle: string;
  }>;
  return rows ?? [];
}

// ---------------------------------------------------------------------------
// The debt register
//
// THE FRAUD MODEL INVERTS HERE. Everything above assumes a vendor loses money by
// lying, which is why recordCredit posts straight through with the vendor's own
// session. A fabricated debt EARNS the vendor money, so there is no equivalent
// of recordCredit for debt: creating one against a registered customer goes
// through proposeDebt() and is confirmed by the CUSTOMER on the customer's own
// device, and the only direct write is declareDebt(), which produces a CLAIM
// that every screen labels as one.
//
// There is deliberately no function here that returns change minus debt. See
// customerPositions(): two figures, never one.
// ---------------------------------------------------------------------------

/**
 * confirmed — confirmée. The customer agreed on their own device. A record.
 * declared  — déclarée. Vendor-entered, unanswered. A claim.
 * disputed  — contestée. The customer said no. Still stands as a figure,
 *             flagged to both parties and to the support panel.
 */
export type DebtState = 'confirmed' | 'declared' | 'disputed';

export interface DebtorRow {
  customer_id: string;
  phone: string;
  your_label: string | null;
  is_registered: boolean;
  debt_cfa: number;
  confirmed_cfa: number;
  declared_cfa: number;
  disputed_cfa: number;
  /**
   * Ageing buckets, FIFO — a payment clears the oldest debt first, which is what
   * a shopkeeper means and what crossing entries off a carte does. The four
   * always sum to debt_cfa; if they ever do not, one of the two figures on the
   * screen is wrong and there is no way to tell which.
   */
  bucket_0_7: number;
  bucket_8_30: number;
  bucket_31_90: number;
  bucket_90: number;
  oldest_days: number;
  over_30_cfa: number;
  last_settled_at: string | null;
  /** The customer says they paid something that was never recorded. */
  open_claim: boolean;
  last_activity_at: string | null;
  entry_count: number;
  total_count: number;
}

/** Who owes this vendor, largest first then oldest. A PAGE, not a total. */
export async function vendorDebtors(
  token: string,
  vendorId: string,
  actorUserId: string,
  limit = 200,
  /**
   * Two different jobs: "who owes me most" when deciding who to chase, "what has
   * gone stale" when deciding what to write off. Whitelisted server-side — an
   * unknown key falls back to amount rather than reaching SQL.
   */
  sort: 'amount' | 'age' = 'amount'
): Promise<DebtorRow[]> {
  const rows = (await rpc(
    'vendor_debtors',
    { p_vendor_id: vendorId, p_actor_user_id: actorUserId, p_limit: limit, p_sort: sort },
    token
  )) as DebtorRow[];
  return rows ?? [];
}

export interface VendorDebtSummary {
  debt_cfa: number;
  debtors: number;
  confirmed_cfa: number;
  declared_cfa: number;
  disputed_cfa: number;
  disputed_count: number;
  /** The share worth worrying about, BESIDE the total rather than inside it. */
  over_30_cfa: number;
  oldest_days: number;
  /**
   * Books that turn over versus books that only grow. Two counts rather than a
   * ratio, because a ratio hides the scale.
   */
  settled_count: number;
  ageing_count: number;
  open_claims: number;
}

/**
 * What the vendor is owed, aggregated in SQL. One row, so it cannot be
 * truncated — the same reason the circulation figure comes from the server.
 */
export async function vendorDebtSummary(
  token: string,
  vendorId: string,
  actorUserId: string
): Promise<VendorDebtSummary> {
  const rows = (await rpc(
    'vendor_debt_summary',
    { p_vendor_id: vendorId, p_actor_user_id: actorUserId },
    token
  )) as VendorDebtSummary[];
  const r = Array.isArray(rows) ? rows[0] : rows;
  return (
    r ?? {
      debt_cfa: 0,
      debtors: 0,
      confirmed_cfa: 0,
      declared_cfa: 0,
      disputed_cfa: 0,
      disputed_count: 0,
      over_30_cfa: 0,
      oldest_days: 0,
      settled_count: 0,
      ageing_count: 0,
      open_claims: 0,
    }
  );
}

export interface DebtEntryRow {
  id: string;
  direction: 'owed' | 'repaid';
  kind: string;
  amount_cfa: number;
  state: DebtState;
  dispute_reason: string | null;
  note: string | null;
  created_at: string;
  /** Only on the customer's own view: whether they can still answer this. */
  reviewable?: boolean;
  running_debt: number;
  total_count: number;
}

export async function vendorDebtHistory(
  token: string,
  vendorId: string,
  customerId: string,
  actorUserId: string,
  limit = 100
): Promise<DebtEntryRow[]> {
  const rows = (await rpc(
    'vendor_debt_history',
    {
      p_vendor_id: vendorId,
      p_customer_id: customerId,
      p_actor_user_id: actorUserId,
      p_limit: limit,
    },
    token
  )) as DebtEntryRow[];
  return rows ?? [];
}

export interface PendingDebtRow {
  id: string;
  vendor_id: string;
  customer_id: string;
  amount_cfa: number;
  note: string | null;
  expires_at: string;
  consumed_at: string | null;
  cancelled_at: string | null;
}

/**
 * Propose a debt to a REGISTERED customer.
 *
 * Returns a pending row the customer must confirm on their own device within
 * 180 seconds. There is no vendor-side way to complete it — that is the point.
 */
export async function proposeDebt(
  token: string,
  input: {
    vendorId: string;
    customerId: string;
    actorUserId: string;
    amountCfa: number;
    idempotencyKey: string;
    note?: string | null;
  }
): Promise<PendingDebtRow> {
  const row = (await rpc(
    'create_pending_debt',
    {
      p_vendor_id: input.vendorId,
      p_customer_id: input.customerId,
      p_amount_cfa: input.amountCfa,
      p_idempotency_key: input.idempotencyKey,
      p_actor_user_id: input.actorUserId,
      p_note: input.note ?? null,
    },
    token
  )) as PendingDebtRow | PendingDebtRow[];
  return Array.isArray(row) ? row[0]! : row;
}

/**
 * Record a DÉCLARÉE debt: the unregistered-customer path, and the
 * customer-is-not-here path.
 *
 * A claim. Never presented as a confirmed record, and when the person registers
 * it surfaces for review rather than becoming fact.
 */
export async function declareDebt(
  token: string,
  input: {
    vendorId: string;
    customerId: string;
    actorUserId: string;
    amountCfa: number;
    idempotencyKey: string;
    note?: string | null;
  }
): Promise<DebtEntryRow> {
  const row = (await rpc(
    'declare_debt',
    {
      p_vendor_id: input.vendorId,
      p_customer_id: input.customerId,
      p_amount_cfa: input.amountCfa,
      p_idempotency_key: input.idempotencyKey,
      p_actor_user_id: input.actorUserId,
      p_note: input.note ?? null,
    },
    token
  )) as DebtEntryRow | DebtEntryRow[];
  return Array.isArray(row) ? row[0]! : row;
}

/** The customer paid cash. Reduces the debt, so no confirmation is required. */
export async function settleDebt(
  token: string,
  input: {
    vendorId: string;
    customerId: string;
    actorUserId: string;
    amountCfa: number;
    idempotencyKey: string;
    note?: string | null;
  }
): Promise<DebtEntryRow> {
  const row = (await rpc(
    'settle_debt',
    {
      p_vendor_id: input.vendorId,
      p_customer_id: input.customerId,
      p_amount_cfa: input.amountCfa,
      p_idempotency_key: input.idempotencyKey,
      p_actor_user_id: input.actorUserId,
      p_note: input.note ?? null,
    },
    token
  )) as DebtEntryRow | DebtEntryRow[];
  return Array.isArray(row) ? row[0]! : row;
}

/** The vendor writes it off. A new entry, never a deletion. */
export async function cancelDebt(
  token: string,
  input: {
    vendorId: string;
    customerId: string;
    actorUserId: string;
    amountCfa: number;
    idempotencyKey: string;
    note?: string | null;
  }
): Promise<DebtEntryRow> {
  const row = (await rpc(
    'cancel_debt',
    {
      p_vendor_id: input.vendorId,
      p_customer_id: input.customerId,
      p_amount_cfa: input.amountCfa,
      p_idempotency_key: input.idempotencyKey,
      p_actor_user_id: input.actorUserId,
      p_note: input.note ?? null,
    },
    token
  )) as DebtEntryRow | DebtEntryRow[];
  return Array.isArray(row) ? row[0]! : row;
}

// ---------------------------------------------------------------------------
// Customer side
// ---------------------------------------------------------------------------

export interface ShopPositionRow {
  vendor_id: string;
  business_name: string;
  quartier: string | null;
  /** Change the customer HOLDS. Never combined with the next field. */
  change_cfa: number;
  /** Debt the customer OWES. */
  debt_cfa: number;
  debt_confirmed_cfa: number;
  debt_declared_cfa: number;
  debt_disputed_cfa: number;
  /**
   * The most that could be offset if the customer asked: min(change, debt).
   * A bound on an ACTION, not a net position. Never negative, and never
   * rendered as a balance.
   */
  compensable_cfa: number;
  /** How old the oldest unpaid franc is. The nudge that gets debts paid. */
  debt_oldest_days: number;
  debt_over_30_cfa: number;
  open_claim: boolean;
  last_activity_at: string | null;
  total_count: number;
}

/**
 * Per shop: what the customer holds AND what they owe, as two figures.
 *
 * There is no third field combining them and there must never be one. 500 F of
 * change against 2 000 F of debt is two true facts; −1 500 F is a false one.
 */
export async function customerPositions(
  token: string,
  actorUserId: string,
  limit = 100
): Promise<ShopPositionRow[]> {
  const rows = (await rpc(
    'customer_shop_positions',
    { p_actor_user_id: actorUserId, p_limit: limit },
    token
  )) as ShopPositionRow[];
  return rows ?? [];
}

export async function customerDebtHistory(
  token: string,
  actorUserId: string,
  vendorId: string,
  limit = 100
): Promise<DebtEntryRow[]> {
  const rows = (await rpc(
    'customer_debt_history',
    { p_actor_user_id: actorUserId, p_vendor_id: vendorId, p_limit: limit },
    token
  )) as DebtEntryRow[];
  return rows ?? [];
}

export interface ReviewRow {
  register: 'debt' | 'change';
  entry_id: string;
  vendor_id: string;
  business_name: string;
  quartier: string | null;
  kind: string;
  amount_cfa: number;
  note: string | null;
  created_at: string;
  total_count: number;
}

/**
 * Everything recorded against this customer that they have never answered.
 *
 * Shown at first login. A vendor can record a claim against any phone number,
 * so if registering silently turned those into established fact, pre-loading
 * debts against a list of numbers would be a working attack. Nothing is ever
 * accepted by signup or by the passage of time.
 */
export async function myReviewQueue(
  token: string,
  actorUserId: string,
  limit = 100
): Promise<ReviewRow[]> {
  const rows = (await rpc(
    'my_review_queue',
    { p_actor_user_id: actorUserId, p_limit: limit },
    token
  )) as ReviewRow[];
  return rows ?? [];
}

/** Accept or dispute one claim. Only the debtor may, and only once. */
export async function reviewEntry(
  token: string,
  input: {
    register: 'debt' | 'change';
    entryId: string;
    decision: 'accepted' | 'disputed';
    actorUserId: string;
    reason?: string | null;
  }
) {
  // Two functions rather than one polymorphic call, matching the two tables.
  const nom = input.register === 'debt' ? 'review_debt_entry' : 'review_ledger_entry';
  return rpc(
    nom,
    {
      p_entry_id: input.entryId,
      p_decision: input.decision,
      p_actor_user_id: input.actorUserId,
      p_reason: input.reason ?? null,
    },
    token
  );
}

/**
 * Propose offsetting change against debt at one shop.
 *
 * Bounded server-side by BOTH balances. The customer confirms on their own
 * device, which writes the pair.
 */
export async function proposeCompensation(
  token: string,
  input: {
    vendorId: string;
    customerId: string;
    actorUserId: string;
    amountCfa: number;
    idempotencyKey: string;
  }
): Promise<PendingDebtRow> {
  const row = (await rpc(
    'create_pending_compensation',
    {
      p_vendor_id: input.vendorId,
      p_customer_id: input.customerId,
      p_amount_cfa: input.amountCfa,
      p_idempotency_key: input.idempotencyKey,
      p_actor_user_id: input.actorUserId,
    },
    token
  )) as PendingDebtRow | PendingDebtRow[];
  return Array.isArray(row) ? row[0]! : row;
}

/**
 * The customer confirms a debt, on their own device.
 *
 * Goes through the Edge Function because the SQL path refuses any session-bound
 * caller: a confirmed debt can only be written by something that has just
 * verified this customer's PIN. There is no vendor-side equivalent and no
 * vendor-device fallback — a vendor who could type the customer's code would be
 * able to mint a debt from nothing.
 */
export async function confirmDebt(
  token: string,
  pendingId: string,
  pin: string
): Promise<{ entryId: string; amountCfa: number; confirmationMethod: string }> {
  const r = (await fn('confirm-debt', { action: 'debt', pendingId, pin }, token)) as any;
  return {
    entryId: r.entryId,
    amountCfa: r.amountCfa,
    confirmationMethod: r.confirmationMethod,
  };
}

/**
 * The customer confirms an offset of change against debt.
 *
 * Returns both remaining figures, separately. There is no combined number in the
 * response and there must not be one: the point of the compensation is that it
 * moved money between two registers which remain two registers.
 */
export async function confirmCompensation(
  token: string,
  pendingId: string,
  pin: string
): Promise<{
  compensationId: string;
  amountCfa: number;
  remainingChangeCfa: number;
  remainingDebtCfa: number;
}> {
  const r = (await fn(
    'confirm-debt',
    { action: 'compensation', pendingId, pin },
    token
  )) as any;
  return {
    compensationId: r.compensationId,
    amountCfa: r.amountCfa,
    remainingChangeCfa: r.remainingChangeCfa,
    remainingDebtCfa: r.remainingDebtCfa,
  };
}

/** Debt proposals waiting for this customer to answer, with time left. */
export async function pendingDebtsForMe(
  token: string,
  actorUserId: string
): Promise<
  Array<{
    id: string;
    vendorId: string;
    businessName: string;
    amountCfa: number;
    note: string | null;
    /**
     * What they owe this shop now, and what they would owe after agreeing.
     * Carried through because agreeing to 2 000 F when it makes 9 000 F is a
     * different decision, and the vendor asking will not always say so.
     */
    currentDebt: number;
    resultingDebt: number;
    secondsLeft: number;
  }>
> {
  const rows = (await rpc(
    'pending_debts_for_customer',
    { p_actor_user_id: actorUserId },
    token
  )) as any[];
  return (rows ?? []).map((r) => ({
    id: r.id,
    vendorId: r.vendor_id,
    businessName: r.business_name,
    amountCfa: r.amount_cfa,
    note: r.note,
    currentDebt: r.current_debt,
    resultingDebt: r.resulting_debt,
    secondsLeft: r.seconds_left,
  }));
}

/**
 * Find the customer behind a phone number, creating the row if it is new.
 *
 * The unregistered path, and the reason the debt register is usable on day one:
 * a vendor must be able to write down what Aya owes whether or not Aya has ever
 * heard of Sika Warri. The row created this way has no auth user, so nothing
 * about it is confirmed and everything recorded against it surfaces for review
 * when that number eventually registers.
 *
 * Normalisation happens server-side. Two spellings of one number is how a person
 * ends up with two rows and a split balance.
 */
export async function ensureCustomerForDebt(
  token: string,
  vendorId: string,
  actorUserId: string,
  phone: string,
  label: string | null
): Promise<{
  customerId: string;
  isRegistered: boolean;
  yourLabel: string | null;
  wasCreated: boolean;
}> {
  const rows = (await rpc(
    'ensure_customer_for_debt',
    {
      p_vendor_id: vendorId,
      p_phone: phone,
      p_actor_user_id: actorUserId,
      p_label: label,
    },
    token
  )) as any[];
  const r = Array.isArray(rows) ? rows[0] : rows;
  return {
    customerId: r.customer_id,
    isRegistered: Boolean(r.is_registered),
    yourLabel: r.your_label ?? null,
    wasCreated: Boolean(r.was_created),
  };
}

/**
 * What one customer owes THIS vendor. Never a figure spanning vendors — that
 * would be the credit-reference product the hard rules forbid.
 */
export async function debtWith(
  token: string,
  vendorId: string,
  customerId: string,
  actorUserId: string
): Promise<number> {
  const rows = (await rpc(
    'vendor_debt_history',
    {
      p_vendor_id: vendorId,
      p_customer_id: customerId,
      p_actor_user_id: actorUserId,
      p_limit: 1,
    },
    token
  )) as DebtEntryRow[];
  // running_debt on the newest row IS the outstanding figure: the window runs
  // oldest-first and the list comes back newest-first, so row zero carries the
  // final total.
  return rows?.[0]?.running_debt ?? 0;
}

/** Either party may withdraw a proposal before it is confirmed. */
export async function cancelPendingDebt(
  token: string,
  pendingId: string,
  actorUserId: string
) {
  return rpc(
    'cancel_pending_debt',
    { p_pending_id: pendingId, p_actor_user_id: actorUserId },
    token
  );
}

export async function cancelPendingCompensation(
  token: string,
  pendingId: string,
  actorUserId: string
) {
  return rpc(
    'cancel_pending_compensation',
    { p_pending_id: pendingId, p_actor_user_id: actorUserId },
    token
  );
}

export interface SettlementRow {
  id: string;
  vendor_id: string;
  business_name: string;
  kind: string;
  amount_cfa: number;
  note: string | null;
  created_at: string;
  state: 'confirmed' | 'acknowledged' | 'declared' | 'disputed';
  answerable: boolean;
  remaining_debt: number;
  total_count: number;
}

/**
 * Settlements recorded against this customer.
 *
 * Informational, not a gate: the money moved when the vendor recorded it. The
 * customer may acknowledge — making the record mutual rather than one party's
 * word — or dispute a payment they never made.
 */
export async function mySettlements(
  token: string,
  actorUserId: string,
  limit = 50
): Promise<SettlementRow[]> {
  const rows = (await rpc(
    'my_settlements',
    { p_actor_user_id: actorUserId, p_limit: limit },
    token
  )) as SettlementRow[];
  return rows ?? [];
}

export interface PaymentClaimRow {
  id: string;
  vendor_id: string;
  business_name: string;
  customer_id: string;
  customer_phone: string;
  customer_label: string | null;
  amount_cfa: number;
  paid_on: string | null;
  note: string | null;
  created_at: string;
  resolved_at: string | null;
  resolution: 'recorded' | 'rejected' | 'withdrawn' | null;
  total_count: number;
}

/**
 * "J'ai payé, ce n'est pas enregistré."
 *
 * The case with no recourse before this: a customer hands over cash, the vendor
 * does not type it in, and a month later there is a disagreement with nothing on
 * either side but memory.
 *
 * IT DOES NOT CHANGE THE DEBT. A customer who could unilaterally reduce what
 * they owe would expose the vendor exactly as the vendor currently exposes them.
 * It is a flag both parties and the support panel can see, created at the time
 * rather than reconstructed afterwards.
 */
export async function claimUnrecordedPayment(
  token: string,
  input: {
    vendorId: string;
    actorUserId: string;
    amountCfa: number;
    paidOn?: string | null;
    note?: string | null;
  }
): Promise<PaymentClaimRow> {
  const row = (await rpc(
    'claim_unrecorded_payment',
    {
      p_vendor_id: input.vendorId,
      p_amount_cfa: input.amountCfa,
      p_actor_user_id: input.actorUserId,
      p_paid_on: input.paidOn ?? null,
      p_note: input.note ?? null,
    },
    token
  )) as PaymentClaimRow | PaymentClaimRow[];
  return Array.isArray(row) ? row[0]! : row;
}

export async function myPaymentClaims(
  token: string,
  actorUserId: string,
  limit = 50
): Promise<PaymentClaimRow[]> {
  const rows = (await rpc(
    'my_payment_claims',
    { p_actor_user_id: actorUserId, p_limit: limit },
    token
  )) as PaymentClaimRow[];
  return rows ?? [];
}

/**
 * Resolve a claim.
 *
 * Only the customer may withdraw; only the vendor may record or reject. A vendor
 * withdrawing a customer's claim would be deleting the complaint against them.
 * A rejected claim STAYS VISIBLE — the disagreement is the thing worth keeping.
 */
export async function resolvePaymentClaim(
  token: string,
  input: {
    claimId: string;
    resolution: 'recorded' | 'rejected' | 'withdrawn';
    actorUserId: string;
    settledEntryId?: string | null;
  }
) {
  return rpc(
    'resolve_payment_claim',
    {
      p_claim_id: input.claimId,
      p_resolution: input.resolution,
      p_actor_user_id: input.actorUserId,
      p_settled_entry_id: input.settledEntryId ?? null,
    },
    token
  );
}

/** Offset proposals waiting for this customer, with all three figures. */
export async function pendingCompensationsForMe(
  token: string,
  actorUserId: string
): Promise<
  Array<{
    id: string;
    vendorId: string;
    businessName: string;
    amountCfa: number;
    currentChange: number;
    currentDebt: number;
    resultingChange: number;
    resultingDebt: number;
    secondsLeft: number;
  }>
> {
  const rows = (await rpc(
    'pending_compensations_for_customer',
    { p_actor_user_id: actorUserId },
    token
  )) as any[];
  return (rows ?? []).map((r) => ({
    id: r.id,
    vendorId: r.vendor_id,
    businessName: r.business_name,
    amountCfa: r.amount_cfa,
    currentChange: r.current_change,
    currentDebt: r.current_debt,
    resultingChange: r.resulting_change,
    resultingDebt: r.resulting_debt,
    secondsLeft: r.seconds_left,
  }));
}

export interface RecentCustomerRow {
  customer_id: string;
  phone: string;
  your_label: string | null;
  is_registered: boolean;
  /** Both figures, separately. A row showing one would have to pick, and either
   *  pick is wrong half the time. */
  change_cfa: number;
  debt_cfa: number;
  last_activity_at: string;
}

/**
 * The last few customers this vendor dealt with.
 *
 * Exists to cut ten taps of a remembered phone number off the commonest
 * transaction in the app. Discloses nothing vendor_customers does not already:
 * this vendor's own label, own balance, own debt.
 */
export async function vendorRecentCustomers(
  token: string,
  vendorId: string,
  actorUserId: string,
  limit = 6
): Promise<RecentCustomerRow[]> {
  const rows = (await rpc(
    'vendor_recent_customers',
    { p_vendor_id: vendorId, p_actor_user_id: actorUserId, p_limit: limit },
    token
  )) as RecentCustomerRow[];
  return rows ?? [];
}

export interface RecentEntryRow {
  id: string;
  customer_id: string;
  customer_phone: string;
  customer_label: string | null;
  direction: 'credit' | 'debit';
  kind: string;
  amount_cfa: number;
  created_at: string;
  receipt_code: string;
  /** Correctable unilaterally RIGHT NOW — window open, unreversed, balance covers it. */
  correctable: boolean;
  seconds_left: number;
  /**
   * Why not, when not: 'ok' | 'expired' | 'reversed' | 'spent'.
   *
   * Carried so the screen can explain instead of greying a button out. A vendor
   * who is told "the customer already used it, they must confirm on their phone"
   * knows what to do next; one shown a dead button taps it again.
   */
  blocked_reason: string;
  total_count: number;
}

/** This vendor's own recent entries, with whether each can still be corrected. */
export async function vendorRecentEntries(
  token: string,
  vendorId: string,
  actorUserId: string,
  limit = 20
): Promise<RecentEntryRow[]> {
  const rows = (await rpc(
    'vendor_recent_entries',
    { p_vendor_id: vendorId, p_actor_user_id: actorUserId, p_limit: limit },
    token
  )) as RecentEntryRow[];
  return rows ?? [];
}

/**
 * Reverse one of this vendor's own entries, inside the 15-minute window.
 *
 * WRITES A REVERSAL. Nothing is deleted or edited — rule 3 — so the original and
 * the correction both stay visible to both parties. The exact-amount rule is
 * what makes it safe without the customer: if they have spent any of a credit,
 * the balance no longer covers the reversal and the server refuses it.
 */
export async function correctOwnEntry(
  token: string,
  input: { entryId: string; actorUserId: string; idempotencyKey: string; note?: string | null }
) {
  return rpc(
    'correct_own_entry',
    {
      p_entry_id: input.entryId,
      p_actor_user_id: input.actorUserId,
      p_idempotency_key: input.idempotencyKey,
      p_note: input.note ?? null,
    },
    token
  );
}

/**
 * Is THIS session an admin?
 *
 * Asked on load, not carried from the login response. The flag used to be
 * captured once at login and held in React state, so a grant made while someone
 * was logged in stayed invisible until they happened to log out — and a page
 * reload restored the session but silently reset the flag to false, which is how
 * the support panel went missing for an account that had the grant all along.
 *
 * Answers only about the caller: admin_is_caller raises SW002 if a session asks
 * about anyone else, so this cannot enumerate admins. And it is not the security
 * boundary — every admin action is gated again in SQL, so a wrong answer here
 * shows or hides a button and nothing more.
 */
export async function amIAdmin(token: string, actorUserId: string): Promise<boolean> {
  try {
    const r = await rpc('admin_is_caller', { p_actor_user_id: actorUserId }, token);
    return r === true;
  } catch {
    // A failed check is not an admin. Never the other way round: on a flaky
    // connection the safe answer is the one that shows less.
    return false;
  }
}
