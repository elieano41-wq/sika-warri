# Sika Warri

Un service d'enregistrement de la monnaie gardée chez le commerçant, pour le
commerce de détail informel en Côte d'Ivoire.

> Sika Warri est un service d'enregistrement. Sika Warri ne détient, ne reçoit
> et ne transfère aucun fonds. La monnaie enregistrée reste physiquement chez le
> commerçant et constitue une dette commerciale de ce commerçant envers son
> client. Elle est utilisable uniquement auprès de ce même commerçant. Le client
> peut à tout moment demander le remboursement en espèces auprès du commerçant
> concerné.

That paragraph is not marketing copy. It is the legal position, it is enforced
structurally in the database rather than in the interface, and it must appear
verbatim in `/conditions` and in vendor onboarding.

---

## What is built

| Layer | State |
|---|---|
| Data layer — 14 migrations, RLS, ledger RPC | Built, 183 tests green in CI |
| Edge Functions — register, login, change-pin, initiate-debit, confirm-debit | Built and deployed; verified end to end against the live project |
| Vendor PWA | Not started |
| Customer PWA | Not started |
| Keepalive workflow | **Not built** |
| Backup workflow | **Not built** |

---

## Local setup

Requires Node 24+. Docker is **not** required for anything in this repository.

```bash
npm install
npm run smoke          # applies all migrations to an embedded Postgres (PGlite)
npm run portability    # asserts no Supabase dependency in the data layer
npx tsc --noEmit       # typecheck
```

`npm test` needs a real Postgres 15+ and reads `DATABASE_URL`. There is no
default: a missing variable fails loudly rather than silently targeting
something unintended. CI provides one as a service container — see
`.github/workflows/ci.yml`. Without a local Postgres, `npm run smoke` is the
fast substitute (real Postgres parser, single connection, no RLS).

### Migrations

```bash
npx supabase login --token <personal access token>
npx supabase link --project-ref <ref>
npx supabase db push --linked
```

`scripts/migrate.mjs` applies the same files to any stock Postgres from
`DATABASE_URL`, with no Supabase tooling involved. That is deliberate: the
ledger must be restorable onto plain Postgres 15+ from the migration files
alone.

### Edge Functions

```bash
npx supabase functions deploy --use-api
```

`--use-api` bundles server-side. Without it the CLI requires Docker.

---

## Secret placement

Getting this wrong is the difference between a public key and a compromised
ledger. Anything `VITE_`-prefixed is compiled into the JavaScript that ships to
the phone.

| Value | Lives in | Reaches the browser? |
|---|---|---|
| `VITE_SUPABASE_URL` | `.env.local` | Yes — public |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | `.env.local` | Yes — public by design |
| `SIKA_SUPABASE_SECRET_KEY` | Supabase Edge Function secrets | **Never** |
| `SIKA_PIN_PEPPER_CURRENT` | Supabase Edge Function secrets | **Never** |
| `SIKA_PIN_PEPPER_V1`, `V2`, … | Supabase Edge Function secrets | **Never** |
| `DATABASE_URL` | CI secret only | **Never** |

The publishable key must be sent on the `apikey` header only. Placed on
`Authorization: Bearer`, the platform parses it as a JWT and rejects the request
with a bare "invalid JWT"; `requireCaller` detects that specific mistake and
names it, because it is otherwise baffling to debug.

Legacy JWT `anon` / `service_role` keys are disabled on this project and must
not be reintroduced.

---

## Le code à 4 chiffres

Customers use a 4-digit PIN, vendors 6. Four digits is deliberately
weak-but-appropriate: exposure is capped at 3 000 F per vendor by design, and
the alternative — SMS OTP — costs money this product does not have. The
mitigations that make it defensible are lockout (5 consecutive failures locks
for 15 minutes, the 4th warns), per-IP throttling across phone numbers, and
rejection of trivially guessable PINs at registration.

---

## Rotation du poivre

The stored auth password is derived from the PIN and a **pepper**. A single
fixed pepper could never be changed: rotating it would invalidate every
credential in the country at once, with no migration path. That is unacceptable
for a credential protecting a money ledger, so peppers are versioned and
migrate lazily, per user, on successful login.

To rotate:

1. Generate a new value. In PowerShell:

   ```powershell
   [Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 })) -replace '\+','-' -replace '/','_' -replace '=',''
   ```

2. Add it as `SIKA_PIN_PEPPER_V<n>` in Edge Function secrets. **Keep every older
   pepper in place.**
3. Set `SIKA_PIN_PEPPER_CURRENT` to `V<n>`.
4. New registrations and PIN changes use the new version immediately. Existing
   users migrate the next time they log in: that is the only moment the server
   legitimately holds the plaintext PIN, so it is the only moment the credential
   can be re-derived.
5. Watch progress:

   ```sql
   select * from pepper_version_usage();
   ```

6. A pepper may be **removed only once no row references its version.** Deleting
   one early does not fail loudly — it silently makes those users' PINs
   unverifiable, which is indistinguishable from a forgotten PIN and would send
   them to re-register for nothing.

Login tries the version a row claims first, then every other configured version.
That is crash safety, not redundancy: the upgrade writes to Supabase Auth and to
Postgres, which cannot share a transaction, so a crash between them would
otherwise leave a user permanently unable to log in with "wrong PIN" as their
only clue.

---

## Corriger une erreur

The ledger is append-only. A correction is always a new reversing entry, never
an edit, and both entries stay visible in the customer's history forever.

A vendor who mistypes an amount has two routes:

- **Within 15 minutes**, and only while the full amount is still in the balance,
  the vendor reverses it alone. Recorded as
  `confirmation_method = 'vendor_correction'` with no `customer_confirmed_at`,
  because no customer saw it. `v_correctable_entries` shows what is still
  correctable and for how long.
- **After that**, the customer must agree, through the same two-device handshake
  as a purchase.

The exact-amount rule is what makes the unilateral window safe: if the customer
has spent even one franc of the change, the reversal no longer fits the balance
and is refused. A vendor cannot claw back change that has already bought
something.

---

## Restauration

**NOT YET IMPLEMENTED.** The backup workflow described in section 9 of the build
spec is not built, so there is currently **no backup of this database at all.**
The Supabase free tier has zero backup retention.

This section will document the restore procedure once `backup.yml` exists and
the restore path has actually been executed. A backup whose restore has never
been run is not a backup, and this heading will not claim otherwise before then.

---

## Keepalive

**NOT YET IMPLEMENTED.** Supabase free-tier projects pause after 7 days with no
activity and must be restored manually from the dashboard. The `heartbeat` table
exists; the workflow that writes to it twice weekly does not.

---

## Known gaps

Recorded so they are not quietly forgotten.

1. **Expired-token rejection is reasoned, not proven.** Every authenticated
   function validates the caller through `auth.getUser()`, which sends the token
   to Supabase, where signature and expiry are both checked. Rejection has been
   verified live for a missing token, a malformed token, a tampered signature,
   and a valid token belonging to a different user. It has **not** been verified
   for a genuinely expired but validly signed token: manufacturing one requires
   the project's signing key, and real access tokens last an hour. The gap is
   narrow — the same code path is exercised by the tampered-token case — but it
   is not evidence.

2. **No backups, no keepalive.** See above. Both are required by section 9 and
   neither exists.

3. **One phone number, one role.** The auth user is keyed on the phone number
   and a vendor PIN is 6 digits where a customer's is 4, so a single number
   cannot be both. Registration says so plainly rather than creating a
   half-usable account.

4. **Phone enumeration is possible by design.** A vendor must be able to tell
   whether a number is already known before offering to create it inline.
   Minimised rather than eliminated: the lookup returns existence plus the
   asking vendor's own label, never a name entered by another vendor, and is
   rate limited to 60 lookups per 10 minutes per vendor.

5. **`v_vendor_confirmation_mix` is a signal, not a verdict.** A vendor
   legitimately serving customers without smartphones shows a high
   `vendor_device` share; so does a vendor harvesting PINs. The number says
   where to look, nothing more.

6. **Acceptance test 8 is half-proven.** The database keeps per-vendor balances
   structurally separate and no query sums them. The promise that no *screen*
   ever presents a single spendable total cannot be tested until the customer
   app exists.

7. **Acceptance test 10 is not started.** Offline queueing, service worker, and
   sync-on-reconnect all belong to the app layer.

---

## Tests

```bash
npm test               # full suite, needs DATABASE_URL
npm run smoke          # migrations only, no external Postgres
npm run e2e:live       # exercises the DEPLOYED functions; writes real rows
```

`e2e:live` is not a unit test. It registers accounts and records entries on
whatever project `.env.local` points at.

The most important test in the suite is `tests/01-vendor-isolation.test.ts`. It
is the legal position expressed as code: no vendor may read, write, or infer
another vendor's ledger. Treat a failure there as a stop-the-line event.
