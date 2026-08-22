// Test harness for the data layer.
//
// The critical detail: migrations and seeding run as the connection's own role,
// which in CI is a superuser. Superusers BYPASS row level security. A test that
// forgot to drop privileges would pass against no policies at all and prove
// nothing. Every assertion about visibility therefore goes through asVendor /
// asCustomer / asAnon, which SET ROLE authenticated first.

import pg from 'pg';
import { randomUUID } from 'node:crypto';

const url = process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL;
if (!url) {
  throw new Error(
    'Missing DATABASE_URL. The data-layer suite needs a real Postgres 15+. ' +
      'CI provides one as a service container; see .github/workflows/ci.yml.'
  );
}

export async function connect(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return client;
}

/** Wipe all application data. Runs privileged, so RLS does not interfere. */
export async function reset(db: pg.Client): Promise<void> {
  await db.query('reset role');
  await db.query(`
    truncate
      public.ledger_entries,
      public.vendor_customer_labels,
      public.vendor_lookup_log,
      public.auth_attempts,
      public.debt_entries,
      public.debt_reviews,
      public.ledger_reviews,
      public.pending_debts,
      public.pending_compensations,
      public.compensations,
      public.vendors,
      public.customers
    restart identity cascade
  `);
}

/**
 * Adopt an end-user identity: drop to the `authenticated` role so policies
 * apply, and declare which auth user we are.
 *
 * On stock Postgres app_current_user_id() reads this GUC. On Supabase it reads
 * auth.uid() and this GUC is inert — which is precisely what the amendment B
 * test asserts, so these helpers are not usable to impersonate there.
 */
export async function actAs(db: pg.Client, authUserId: string): Promise<void> {
  await db.query('reset role');
  await db.query('select set_config($1, $2, false)', [
    'app.current_user_id',
    authUserId,
  ]);
  await db.query('set role authenticated');
}

/** Drop back to the privileged role for seeding or inspection. */
export async function actAsAdmin(db: pg.Client): Promise<void> {
  await db.query('reset role');
  await db.query('select set_config($1, $2, false)', ['app.current_user_id', '']);
}

export interface SeededVendor {
  id: string;
  authUserId: string;
  phone: string;
  businessName: string;
}

export interface SeededCustomer {
  id: string;
  authUserId: string | null;
  phone: string;
}

let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `22507${String(phoneCounter).padStart(8, '0')}`;
}

export async function seedVendor(
  db: pg.Client,
  opts: { cap?: number; businessName?: string; active?: boolean } = {}
): Promise<SeededVendor> {
  await actAsAdmin(db);
  const authUserId = randomUUID();
  const phone = nextPhone();
  const businessName = opts.businessName ?? `Boutique ${phone.slice(-4)}`;
  const { rows } = await db.query(
    `insert into public.vendors
       (auth_user_id, phone, business_name, quartier, commune,
        max_balance_per_customer, is_active, terms_accepted_at, terms_version)
     values ($1, $2, $3, 'Yopougon', 'Abidjan', $4, $5, now(), 'v1')
     returning id`,
    [authUserId, phone, businessName, opts.cap ?? 3000, opts.active ?? true]
  );
  return { id: rows[0].id, authUserId, phone, businessName };
}

export async function seedCustomer(
  db: pg.Client,
  opts: { registered?: boolean } = {}
): Promise<SeededCustomer> {
  await actAsAdmin(db);
  const registered = opts.registered ?? true;
  const authUserId = registered ? randomUUID() : null;
  const phone = nextPhone();
  const { rows } = await db.query(
    `insert into public.customers (auth_user_id, phone, display_name)
     values ($1, $2, $3) returning id`,
    [authUserId, phone, registered ? 'Client' : null]
  );
  return { id: rows[0].id, authUserId, phone };
}

export type ConfirmationMethod =
  | 'own_device'
  | 'vendor_device'
  // A reversal the vendor made alone, inside the correction window. Never
  // carries customer_confirmed_at, because no customer saw it.
  | 'vendor_correction';

export interface PostArgs {
  vendorId: string;
  customerId: string;
  direction: 'credit' | 'debit';
  kind: 'change' | 'purchase' | 'refund' | 'reversal';
  amount: number;
  actorUserId: string;
  idempotencyKey?: string;
  customerConfirmed?: boolean;
  reversesEntryId?: string | null;
  note?: string | null;
  /** Omitted means own_device — the safe value. vendor_device must be explicit. */
  confirmationMethod?: ConfirmationMethod;
}

/** Call the RPC exactly as a client would, positionally. */
export async function postEntry(db: pg.Client, a: PostArgs) {
  const { rows } = await db.query(
    `select * from public.post_ledger_entry(
       $1::uuid, $2::uuid, $3::text, $4::text, $5::integer, $6::text,
       $7::uuid, $8::boolean, $9::uuid, $10::text, $11::text
     )`,
    [
      a.vendorId,
      a.customerId,
      a.direction,
      a.kind,
      a.amount,
      a.idempotencyKey ?? randomUUID(),
      a.actorUserId,
      a.customerConfirmed ?? false,
      a.reversesEntryId ?? null,
      a.note ?? null,
      a.confirmationMethod ?? 'own_device',
    ]
  );
  return rows[0];
}

/** Vendor proposes a debit (amendment H step 1). */
export async function createPendingDebit(
  db: pg.Client,
  a: {
    vendorId: string;
    customerId: string;
    kind: 'purchase' | 'refund' | 'reversal';
    amount: number;
    actorUserId: string;
    idempotencyKey?: string;
    /** Required when kind is 'reversal', forbidden otherwise. */
    reversesEntryId?: string | null;
  }
) {
  const { rows } = await db.query(
    `select * from public.create_pending_debit(
       $1::uuid, $2::uuid, $3::text, $4::integer, $5::text, $6::uuid, $7::uuid)`,
    [
      a.vendorId,
      a.customerId,
      a.kind,
      a.amount,
      a.idempotencyKey ?? randomUUID(),
      a.actorUserId,
      a.reversesEntryId ?? null,
    ]
  );
  return rows[0];
}

/** Customer accepts, on their own device (amendment H step 3). */
export async function confirmPendingDebit(
  db: pg.Client,
  pendingId: string,
  customerAuthUserId: string
) {
  const { rows } = await db.query(
    'select * from public.confirm_pending_debit($1::uuid, $2::uuid)',
    [pendingId, customerAuthUserId]
  );
  return rows[0];
}

/**
 * Force a proposal into the past, to test expiry without waiting 180 seconds.
 *
 * Both timestamps move. Setting expires_at alone cannot work: the row was
 * created milliseconds ago, so created_at + any positive interval is still in
 * the future, and the expiry check would not fire. Pushing expires_at to at or
 * before created_at instead violates pending_debits_expiry_after_creation. So
 * the whole row is backdated, which is what a genuinely stale proposal looks
 * like anyway.
 */
export async function expirePendingDebit(db: pg.Client, pendingId: string) {
  await actAsAdmin(db);
  await db.query(
    `update public.pending_debits
        set created_at = now() - interval '1 hour',
            expires_at = now() - interval '57 minutes'
      where id = $1`,
    [pendingId]
  );
}

export async function customerFlags(
  db: pg.Client,
  customerId: string
): Promise<{ pin_change_required: boolean; vendor_device_notice_seen_at: Date | null }> {
  await actAsAdmin(db);
  const { rows } = await db.query(
    `select pin_change_required, vendor_device_notice_seen_at
       from public.customers where id = $1`,
    [customerId]
  );
  return rows[0];
}

/** Convenience: a confirmed credit, seeded privileged, to set up a balance. */
export async function giveCredit(
  db: pg.Client,
  vendor: SeededVendor,
  customer: SeededCustomer,
  amount: number
) {
  await actAsAdmin(db);
  return postEntry(db, {
    vendorId: vendor.id,
    customerId: customer.id,
    direction: 'credit',
    kind: 'change',
    amount,
    actorUserId: vendor.authUserId,
  });
}

export async function balanceOf(
  db: pg.Client,
  vendorId: string,
  customerId: string
): Promise<number> {
  const { rows } = await db.query(
    `select coalesce(sum(case when direction = 'credit'
                              then amount_cfa else -amount_cfa end), 0)::integer as b
       from public.ledger_entries
      where vendor_id = $1 and customer_id = $2`,
    [vendorId, customerId]
  );
  return rows[0].b;
}

export async function entryCount(db: pg.Client): Promise<number> {
  await actAsAdmin(db);
  const { rows } = await db.query('select count(*)::integer as n from public.ledger_entries');
  return rows[0].n;
}

/** Capture the SQLSTATE of a failing call, or null if it unexpectedly succeeded. */
export async function sqlstateOf(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? 'UNKNOWN';
  }
}

/* ---------------------------------------------------------------------------
   The debt register
   --------------------------------------------------------------------------- */

export type DebtConfirmation = 'own_device' | 'declared';

export interface DebtArgs {
  vendorId: string;
  customerId: string;
  direction: 'owed' | 'repaid';
  kind: 'debt' | 'settlement' | 'cancellation' | 'compensation' | 'reversal';
  amount: number;
  actorUserId: string;
  idempotencyKey?: string;
  /** Omitted means 'declared' — the safe value, and the only one a session may use. */
  confirmation?: DebtConfirmation;
  reversesEntryId?: string | null;
  note?: string | null;
}

/** Call post_debt_entry exactly as a client would, positionally. */
export async function postDebt(db: pg.Client, a: DebtArgs) {
  const { rows } = await db.query(
    `select * from public.post_debt_entry(
       $1::uuid, $2::uuid, $3::text, $4::text, $5::integer, $6::text,
       $7::uuid, $8::text, $9::uuid, $10::text)`,
    [
      a.vendorId,
      a.customerId,
      a.direction,
      a.kind,
      a.amount,
      a.idempotencyKey ?? randomUUID(),
      a.actorUserId,
      a.confirmation ?? 'declared',
      a.reversesEntryId ?? null,
      a.note ?? null,
    ]
  );
  return rows[0];
}

/** The unregistered-customer path: a claim, not a record. */
export async function declareDebt(
  db: pg.Client,
  a: { vendorId: string; customerId: string; amount: number; actorUserId: string;
       idempotencyKey?: string; note?: string | null }
) {
  const { rows } = await db.query(
    `select * from public.declare_debt($1::uuid, $2::uuid, $3::integer, $4::text, $5::uuid, $6::text)`,
    [a.vendorId, a.customerId, a.amount, a.idempotencyKey ?? randomUUID(),
     a.actorUserId, a.note ?? null]
  );
  return rows[0];
}

export async function settleDebt(
  db: pg.Client,
  a: { vendorId: string; customerId: string; amount: number; actorUserId: string;
       idempotencyKey?: string }
) {
  const { rows } = await db.query(
    `select * from public.settle_debt($1::uuid, $2::uuid, $3::integer, $4::text, $5::uuid, null)`,
    [a.vendorId, a.customerId, a.amount, a.idempotencyKey ?? randomUUID(), a.actorUserId]
  );
  return rows[0];
}

/** Vendor proposes a debt; the customer must confirm on their own device. */
export async function createPendingDebt(
  db: pg.Client,
  a: { vendorId: string; customerId: string; amount: number; actorUserId: string;
       idempotencyKey?: string; note?: string | null }
) {
  const { rows } = await db.query(
    `select * from public.create_pending_debt($1::uuid, $2::uuid, $3::integer, $4::text, $5::uuid, $6::text)`,
    [a.vendorId, a.customerId, a.amount, a.idempotencyKey ?? randomUUID(),
     a.actorUserId, a.note ?? null]
  );
  return rows[0];
}

/**
 * The customer confirms. Runs PRIVILEGED, because that is the only way it can
 * run: confirm_pending_debt refuses any session-bound caller, which is what
 * stops a vendor forging the agreement.
 */
export async function confirmPendingDebt(
  db: pg.Client,
  pendingId: string,
  customerAuthUserId: string
) {
  await actAsAdmin(db);
  const { rows } = await db.query(
    'select * from public.confirm_pending_debt($1::uuid, $2::uuid)',
    [pendingId, customerAuthUserId]
  );
  return rows[0];
}

export async function reviewDebt(
  db: pg.Client,
  entryId: string,
  decision: 'accepted' | 'disputed',
  customerAuthUserId: string,
  reason: string | null = null
) {
  const { rows } = await db.query(
    'select * from public.review_debt_entry($1::uuid, $2::text, $3::uuid, $4::text)',
    [entryId, decision, customerAuthUserId, reason]
  );
  return rows[0];
}

/** What the customer owes this vendor, derived the same way the app derives it. */
export async function debtOf(
  db: pg.Client,
  vendorId: string,
  customerId: string
): Promise<number> {
  const { rows } = await db.query(
    `select coalesce(sum(case when direction = 'owed' then amount_cfa else -amount_cfa end), 0)::int as d
       from public.debt_entries where vendor_id = $1 and customer_id = $2`,
    [vendorId, customerId]
  );
  return rows[0].d;
}

/** Register a stub: give an existing customer row an auth user, as signup does. */
export async function claimCustomer(
  db: pg.Client,
  customerId: string
): Promise<string> {
  await actAsAdmin(db);
  const authUserId = randomUUID();
  await db.query('update public.customers set auth_user_id = $1 where id = $2', [
    authUserId,
    customerId,
  ]);
  return authUserId;
}

export async function debtEntryCount(db: pg.Client): Promise<number> {
  const { rows } = await db.query('select count(*)::int as n from public.debt_entries');
  return rows[0].n;
}

export { randomUUID };
