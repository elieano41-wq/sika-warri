# SIKA WARRI — Phase 1 build spec

Place this file in the project root. In Claude Code, say:

> Read SIKA_WARRI_BUILD.md and execute Phase 1. Stop at the hard stop.

Keep this file in the repository — it is the reference for later phases.

---

## 0. What you are building

A closed-loop change-credit ledger for informal retail in Côte d'Ivoire.

When a vendor cannot give change, they record the reliquat as a credit the customer holds **against that vendor only**. The cash never leaves the vendor's till. Sika Warri holds no funds and is never a party to the debt — it is a record-keeping service.

This is not a wallet. It is not e-money. Read section 1 before writing any code.

---

## 1. Standing rules — non-negotiable, apply to every phase

These are legal and integrity constraints, not preferences. Violating any of them is a build failure.

1. **No cross-vendor spend, ever.** A balance exists for a `(customer, vendor)` pair. There is no global customer balance, no netting, no pooling, no transfer between vendors. Enforce structurally in the schema and in RLS, not just in application code.
2. **Balances can never go negative.** Negative balance = credit extension = a different regulatory regime entirely. Enforce in the database with a locking transaction that raises on violation.
3. **The ledger is append-only.** Never `UPDATE` or `DELETE` a ledger entry. Corrections are new reversing entries that reference the original. Revoke update/delete privileges at the role level.
4. **Balance is always derived, never stored.** `balance = SUM(credits) - SUM(debits)`. Do not keep a mutable balance column that can drift from the entries.
5. **Amounts are integer FCFA.** No floats, no decimals, no centimes. `integer` columns throughout.
6. **Fail loudly on missing config.** No silent fallbacks, no default vendor, no implicit "unknown customer". If a required env var or record is absent, throw with a message naming exactly what is missing.
7. **Debits require connectivity.** Credits may be queued offline. Debits may NOT — you cannot verify an available balance offline and you will create double-spend. Block the debit flow when offline with a clear message.
8. **Every write carries an idempotency key.** Offline queues resend. A replayed key must be a no-op returning the original entry, never a duplicate.
9. **The customer can always demand cash back.** A vendor can record a `refund` debit to settle a balance in cash. This must exist in the UI from Phase 1 — it is what keeps the credit a plain commercial debt.
10. **Never write anything to the UI implying Sika Warri holds funds.** No "your balance", no "wallet", no "deposit". Copy is specified in section 6.
11. **Never commit secrets.** `.env.local` is gitignored from the first commit. No key, PIN, or password appears in source, logs, error messages, or telemetry.

---

## 2. Stack

- Vite + React + TypeScript, PWA (installable, offline-capable via service worker)
- Supabase — Postgres, Auth, Row Level Security, Edge Functions where server logic is needed
- Deployment target: Cloudflare Pages (do not use Vercel Hobby — its terms prohibit commercial use)
- IndexedDB (`idb` package) for the offline credit queue
- No SMS provider. No paid service of any kind in Phase 1.

Language of the entire user interface: **French**. Code, comments, and identifiers in English.

**Portability requirement.** Keep every schema object, RPC, and RLS policy in plain SQL migration files under `supabase/migrations/`. Do not use Supabase-specific SQL extensions anywhere in the data layer. Supabase Auth is the only accepted lock-in; the ledger itself must be restorable onto any stock Postgres 15+ instance from the migration files alone. This keeps a later move to Neon or self-hosted Postgres an afternoon's work rather than a rewrite.

---

## 3. Authentication — no SMS, no OTP

Phone number is the identity. A short numeric PIN is the credential. This mirrors mobile money, so it needs no explanation to users.

Implement over Supabase Auth using a synthetic email:

- Normalise the phone to E.164 without `+` (e.g. `2250701020304`)
- Auth email = `{msisdn}@id.sikawarri.app`
- Auth password = `{PIN}` concatenated with a server-side pepper from `SIKA_PIN_PEPPER`
- Vendors use a **6-digit** PIN, customers a **4-digit** PIN

Required protections, all of which must be implemented:

- Lock the account for 15 minutes after 5 consecutive failed PIN attempts
- Rate-limit login attempts per phone number and per IP
- Reject sequential and repeated PINs (`1234`, `0000`, `1111`, etc.) at registration
- Never log a PIN, never include one in an error message or telemetry payload

Note in `README.md` that a 4-digit PIN is deliberately weak-but-appropriate: exposure is capped at 3 000 F per vendor by design, and the alternative (SMS OTP) costs money the product does not have.

---

## 4. Data model

```
vendors
  id                        uuid pk
  auth_user_id              uuid unique not null
  phone                     text unique not null
  business_name             text not null
  quartier                  text not null
  commune                   text
  max_balance_per_customer  integer not null default 3000
  is_active                 boolean not null default true
  created_at                timestamptz not null default now()

customers
  id            uuid pk
  auth_user_id  uuid unique          -- nullable: vendor can create a customer who has not registered
  phone         text unique not null
  display_name  text
  created_at    timestamptz not null default now()

ledger_entries
  id                uuid pk
  vendor_id         uuid not null references vendors(id)
  customer_id       uuid not null references customers(id)
  direction         text not null check (direction in ('credit','debit'))
  kind              text not null check (kind in ('change','purchase','refund','reversal'))
  amount_cfa        integer not null check (amount_cfa > 0)
  idempotency_key   text not null
  reverses_entry_id uuid references ledger_entries(id)
  note              text
  created_at        timestamptz not null default now()
  created_by        uuid not null   -- auth user who performed it

  unique (vendor_id, idempotency_key)
  index on (vendor_id, customer_id, created_at desc)

heartbeat
  id          bigserial pk
  pinged_at   timestamptz not null default now()
```

`kind` semantics: `change` = credit issued when no change available. `purchase` = debit when credit is spent on goods. `refund` = debit when the vendor returns cash. `reversal` = correction of an earlier entry.

**View** `v_balances`: `(vendor_id, customer_id, balance_cfa, last_activity_at)` computed as the signed sum over `ledger_entries`.

### RLS policies

- A vendor may `SELECT` only rows where `vendor_id` matches their own vendor record
- A customer may `SELECT` only rows where `customer_id` matches their own customer record
- Nobody may `UPDATE` or `DELETE` `ledger_entries` — revoke those privileges from `authenticated` entirely
- `INSERT` happens only through the RPC below, never directly

Write a test that proves vendor A cannot read vendor B's entries. This test is the legal position expressed as code — treat it as the most important test in the suite.

### RPC `post_ledger_entry`

A single `SECURITY DEFINER` Postgres function is the only write path. It must, inside one transaction:

1. Verify the calling auth user owns `vendor_id`
2. `SELECT ... FOR UPDATE` to lock the `(vendor_id, customer_id)` pair
3. Recompute the current balance from entries
4. On `credit`: raise if `balance + amount > vendors.max_balance_per_customer`
5. On `debit`: raise if `amount > balance`
6. Return the existing entry unchanged if `(vendor_id, idempotency_key)` already exists
7. Insert and return the new entry

Raise with distinct, named error codes so the client can show a specific message. No generic failures.

---

## 5. Screens

### Vendor (primary user — build first, most polish here)

- **Connexion** — phone + 6-digit PIN
- **Accueil** — monnaie en circulation (total owed), nombre de clients concernés, activité du jour, big primary action button
- **Garder la monnaie** — enter customer phone → enter amount → confirm. If the phone is unknown, create the customer inline with just a first name. Show a 4-digit receipt code on success that the customer can note down.
- **Utiliser la monnaie** — enter customer phone → show their balance with you → enter amount to apply → **customer types their own PIN on the vendor's device to confirm** → done. Blocked when offline.
- **Rembourser en espèces** — settle a balance in cash, records a `refund` debit
- **Mes clients** — list of customers with an outstanding balance, sorted by amount, searchable by phone
- **Historique** — all entries, filterable by day and by customer

### Customer

- **Connexion / inscription** — phone + 4-digit PIN
- **Ma monnaie** — one card per shop showing the balance held there. A total may be displayed as information only, with the line *"Répartie chez 4 commerçants — utilisable dans chaque boutique séparément"*. It must never be presented as a single spendable sum.
- **Détail par boutique** — history of credits and debits with that vendor
- **Changer mon code**

### Public

- Landing page explaining the product to vendors, with a registration link
- `/conditions` — terms of use containing the disclosure in section 6

---

## 6. Copy rules and required legal text

Never use: *portefeuille*, *solde Sika Warri*, *dépôt*, *recharger*, *votre argent chez nous*.

Use instead: *votre monnaie chez [boutique]*, *monnaie gardée*, *utiliser ma monnaie*, *se faire rembourser*.

The following must appear in the terms of use and in the vendor onboarding flow, verbatim:

> Sika Warri est un service d'enregistrement. Sika Warri ne détient, ne reçoit et ne transfère aucun fonds. La monnaie enregistrée reste physiquement chez le commerçant et constitue une dette commerciale de ce commerçant envers son client. Elle est utilisable uniquement auprès de ce même commerçant. Le client peut à tout moment demander le remboursement en espèces auprès du commerçant concerné.

The vendor must tick an explicit acknowledgement of this at registration, and the acknowledgement must be timestamped and stored.

---

## 7. Visual direction

Deep green and gold. Modern, high contrast, built for outdoor daylight and cheap screens.

```
--vert-nuit    #0B2E22   page background
--vert-foret   #14503A   cards, raised surfaces
--or-sika      #C9A227   primary action, amounts, the brand
--or-clair     #E8C558   hover, focus rings
--craie        #F4F1E8   primary text on dark
--sauge        #8FA79A   secondary text on dark
--alerte       #D96A4A   errors, blocked actions
```

Type:
- Display — **Bricolage Grotesque** (600), used only for headings and the balance figure
- Body — **Inter** (400/500)
- Amounts — **IBM Plex Mono**, `font-variant-numeric: tabular-nums`, always

All from Google Fonts, subset to `latin` + `latin-ext`.

**Cards — plain, not paper.** Each shop balance renders as a card: the shop name in the display face, the amount large in mono, on `--vert-foret` over the night background.

This started as a skeuomorph of the paper *cahier* a vendor already keeps — a gold margin rule down the left edge and a faint ruled-paper texture — and that was dropped. A ledger which has to be trusted with money should not look like a school exercise book, and an imitation ages badly beside the real thing it imitates. Vendors are moving *off* paper; the app should not be nostalgic about it.

What holds the design together instead is restraint, and it is enforceable rather than a matter of taste:

- **One accent, reserved.** Gold marks amounts, the primary action, and the single most important card on a screen (`.carte--principale`, a 3px gold top edge). **At most one per screen** — used twice it means nothing. That variant *is* the visual hierarchy: a vendor glancing at their phone should find the figure that matters without reading.
- **Separation by hairline, never by shadow.** A 1px `--trait` border, the same device the tab bar uses. A shadow is invisible in direct sunlight and costs a paint on a cheap Android.
- **No gradients, no glass, no blur.** All three cost GPU, none says anything.
- **Generous padding and a real radius**, so a card reads as a deliberate object rather than a div with a background colour.
- **Labels above figures** are uppercase and letterspaced — the one typographic device running through the whole app, so a label reads as a label everywhere without needing a colour of its own.

The test suite asserts the absence of the paper treatment as well as the presence of the replacement, so neither drifts back.

Non-negotiable UI quality floor: minimum 48px touch targets, minimum 16px body text, amounts always formatted with a space as the thousands separator and the `F` suffix (`2 500 F`), visible keyboard focus, full function down to a 320px viewport.

---

## 8. Offline behaviour

- Service worker caches the app shell; the app must open with no network
- Credits queue in IndexedDB with a client-generated idempotency key and sync on reconnect
- A persistent banner shows queue depth when entries are pending
- Debits are disabled offline with the message *"Connexion requise pour utiliser la monnaie"*
- On sync, surface any server rejection (cap exceeded, insufficient balance) to the vendor individually — never swallow a failure silently

---

## 9. Operations — keepalive and backups

Both of these are required in Phase 1, not later.

**Keepalive.** `.github/workflows/keepalive.yml`, running twice weekly. Inserts a row into `heartbeat`, deletes rows older than 7 days. Supabase free-tier projects pause after 7 days with no activity and must be restored manually. Document this in `README.md`.

**Backups.** `.github/workflows/backup.yml`, running nightly:
- `pg_dump` the database
- encrypt with GPG using a passphrase from repository secrets
- commit the encrypted dump to `backups/`, keeping 30 days and pruning older files

The Supabase free tier has zero backup retention. This is the only backup that exists. Write and test the restore procedure, and document it in `README.md` under a heading **Restauration**. A backup whose restore path has never been executed is not a backup.

---

## 10. Acceptance tests — all must pass before the phase is complete

1. Vendor A cannot read, write, or infer any ledger entry belonging to vendor B
2. A debit greater than the available balance is rejected and no entry is written
3. A credit that would push the balance above `max_balance_per_customer` is rejected
4. Replaying the same `(vendor_id, idempotency_key)` returns the original entry and creates no duplicate
5. Two concurrent debits against the same balance cannot both succeed
6. `UPDATE` and `DELETE` on `ledger_entries` fail for the `authenticated` role
7. A reversal entry restores the balance exactly and both entries remain visible in history
8. A customer with balances at three vendors sees three separate figures; no code path sums them into a spendable amount
9. Six failed PIN attempts lock the account; the fifth failure warns
10. The app opens offline, queues a credit, blocks a debit, and syncs cleanly on reconnect with no duplicate
11. All migrations apply cleanly to a bare Postgres 15 container, and tests 1–9 pass against it with no Supabase-specific dependency in the data layer

Add a seed script that provisions 3 vendors and 8 customers with realistic Abidjan data for manual testing.

---

## 11. Deliverable for this phase

A running application reachable at a real URL, not an API and not a set of endpoints. It must be possible to open the link on a phone, register a vendor, register a customer, record a credit, and spend it — end to end, in the browser, without touching a terminal.

Include a `README.md` covering local setup, the Supabase migration steps, required environment variables, how to run the test suite, and the restore procedure.

---

## HARD STOP

Stop here. Do not start Phase 2. Do not add reporting, analytics, vendor subscriptions, payment collection, SMS, or any multi-vendor feature.

Report back with:
- what was built and what was skipped, and why
- the test results, listed individually
- the deployed URL
- anything in this spec that turned out to be wrong, ambiguous, or unbuildable as written
