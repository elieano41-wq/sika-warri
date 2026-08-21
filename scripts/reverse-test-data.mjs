// Reverse the end-to-end test entries on the live project.
//
// Uses the paths a real vendor would use, not a delete. Rule 3 stands: nothing
// is edited or removed, the corrections are new entries, and the full history
// stays visible. The accounts remain; only the balances go to zero.
//
// Two different routes are needed, which is exactly the point:
//
//   * the 400 F DEBIT is reversed unilaterally. That reversal is a credit — it
//     hands money back — so it needs no confirmation and no window.
//   * the 1000 F CREDIT is older than the 15-minute correction window, so the
//     vendor cannot undo it alone. It goes through the two-device handshake and
//     the customer confirms with their own PIN.

import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => /^[A-Z]/.test(l))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);

const BASE = env.VITE_SUPABASE_URL;
const APIKEY = env.VITE_SUPABASE_PUBLISHABLE_KEY;

// From the e2e run. The customer's PIN was changed to 5062 during that run.
const VENDOR_PHONE = '0797085500';
const VENDOR_PIN = '481627';
const CUSTOMER_PHONE = '0597085500';
const CUSTOMER_PIN = '5062';

const fn = (n) => `${BASE}/functions/v1/${n}`;
const rest = (p) => `${BASE}/rest/v1/${p}`;

async function callFn(name, body, token) {
  const headers = { apikey: APIKEY, 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(fn(name), { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function rpc(name, args, token) {
  const res = await fetch(rest(`rpc/${name}`), {
    method: 'POST',
    headers: { apikey: APIKEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function get(path, token) {
  const res = await fetch(rest(path), {
    headers: { apikey: APIKEY, Authorization: `Bearer ${token}` },
  });
  return await res.json().catch(() => null);
}

// ---------------------------------------------------------------------------

const vLogin = await callFn('login', { role: 'vendor', phone: VENDOR_PHONE, pin: VENDOR_PIN });
const vToken = vLogin.body?.session?.access_token;
if (!vToken) throw new Error(`vendor login failed: ${JSON.stringify(vLogin.body)}`);

const vendor = (await get('vendors?select=id,auth_user_id', vToken))[0];
const entries = await get(
  'ledger_entries?select=id,direction,kind,amount_cfa,created_at,confirmation_method&order=created_at',
  vToken
);

console.log('Entries before:');
for (const e of entries) {
  console.log(`  ${e.created_at}  ${e.direction.padEnd(6)} ${e.kind.padEnd(9)} ${String(e.amount_cfa).padStart(5)} F`);
}

const balBefore = await get('v_balances?select=customer_id,balance_cfa', vToken);
console.log('Balance before:', JSON.stringify(balBefore));

const customerId = balBefore[0]?.customer_id;
const alreadyReversed = new Set(entries.filter((e) => e.kind === 'reversal').map(() => null));

// ---- step 1: reverse the debit, unilaterally -------------------------------
const debit = entries.find((e) => e.direction === 'debit' && e.kind === 'purchase');

if (debit) {
  const r = await rpc('post_ledger_entry', {
    p_vendor_id: vendor.id,
    p_customer_id: customerId,
    p_direction: 'credit', // inverts the debit
    p_kind: 'reversal',
    p_amount_cfa: debit.amount_cfa,
    p_idempotency_key: `undo-debit-${debit.id}`,
    p_actor_user_id: vendor.auth_user_id,
    p_customer_confirmed: false,
    p_reverses_entry_id: debit.id,
    p_note: 'annulation données de test',
    p_confirmation_method: null,
  }, vToken);
  console.log(`\nStep 1 — reverse the ${debit.amount_cfa} F debit: ${r.status === 200 ? 'OK' : 'FAILED'}`);
  if (r.status !== 200) console.log('  ', JSON.stringify(r.body));
} else {
  console.log('\nStep 1 — no purchase debit found, skipping');
}

// ---- step 2: the credit, via the handshake --------------------------------
const credit = entries.find((e) => e.direction === 'credit' && e.kind === 'change');

if (credit) {
  // Prove the unilateral path is genuinely closed for this entry before using
  // the consent route, rather than assuming the window has passed.
  const unilateral = await rpc('post_ledger_entry', {
    p_vendor_id: vendor.id, p_customer_id: customerId,
    p_direction: 'debit', p_kind: 'reversal', p_amount_cfa: credit.amount_cfa,
    p_idempotency_key: `probe-${credit.id}`,
    p_actor_user_id: vendor.auth_user_id, p_customer_confirmed: false,
    p_reverses_entry_id: credit.id, p_note: null,
    p_confirmation_method: 'vendor_correction',
  }, vToken);
  console.log(`\nStep 2a — unilateral correction attempt: ${unilateral.status === 200 ? 'ALLOWED (still in window)' : 'refused as expected'}`);
  if (unilateral.status !== 200) console.log('  ', unilateral.body?.message ?? JSON.stringify(unilateral.body));

  if (unilateral.status !== 200) {
    const proposal = await callFn('initiate-debit', {
      customerPhone: CUSTOMER_PHONE,
      amountCfa: credit.amount_cfa,
      kind: 'reversal',
      reversesEntryId: credit.id,
      idempotencyKey: `undo-credit-${credit.id}`,
    }, vToken);
    console.log(`Step 2b — vendor proposes the reversal: ${proposal.status === 200 ? 'OK' : 'FAILED'}`);
    if (proposal.status !== 200) console.log('  ', JSON.stringify(proposal.body));

    if (proposal.body?.pendingId) {
      const cLogin = await callFn('login', {
        role: 'customer', phone: CUSTOMER_PHONE, pin: CUSTOMER_PIN,
      });
      const cToken = cLogin.body?.session?.access_token;
      if (!cToken) throw new Error(`customer login failed: ${JSON.stringify(cLogin.body)}`);

      const confirmed = await callFn('confirm-debit', {
        pendingId: proposal.body.pendingId, pin: CUSTOMER_PIN,
      }, cToken);
      console.log(`Step 2c — customer confirms on their own device: ${confirmed.status === 200 ? 'OK' : 'FAILED'}`);
      if (confirmed.status !== 200) console.log('  ', JSON.stringify(confirmed.body));
    }
  }
}

// ---- result ---------------------------------------------------------------
const after = await get(
  'ledger_entries?select=direction,kind,amount_cfa,confirmation_method,created_at&order=created_at',
  vToken
);
console.log('\nEntries after:');
for (const e of after) {
  console.log(`  ${e.direction.padEnd(6)} ${e.kind.padEnd(9)} ${String(e.amount_cfa).padStart(5)} F  ${e.confirmation_method ?? '-'}`);
}

const balAfter = await get('v_balances?select=balance_cfa', vToken);
console.log('\nBalance after:', JSON.stringify(balAfter));
console.log(`History preserved: ${entries.length} entries before, ${after.length} after (nothing deleted)`);
