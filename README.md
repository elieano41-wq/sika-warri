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

The Supabase free tier has **zero backup retention**. `backups/` in this
repository is the only backup that exists. Every file in it is a `pg_dump` of the
`public` schema, encrypted with GPG symmetric AES-256.

**The restore path has been executed.** Not reasoned about — run, and it is
re-run weekly by `.github/workflows/restore-drill.yml`, which dumps with the same
flags `backup.yml` uses, encrypts, drops the `public` schema of a throwaway
Postgres 17, replays the archive into it, and then compares an MD5 fingerprint of
every ledger entry — id, vendor, customer, direction, kind, amount, in id order —
against the same fingerprint taken before. It also re-checks that the balance
guard still refuses an over-balance debit afterwards, because a database whose
rows came back but whose constraints did not is not restored.

Weekly rather than once: a restore that worked in August is not evidence about a
schema that has had four migrations since.

**Last executed 2026-08-22**, against Postgres 17.11, `pg_dump` 17.11:

```
1. census before
  before     3v 8c 13e · 12 tables · 47 fn · 2 trg · 5 pol · d09e56dd2ffe
2. pg_dump                    111137 bytes
3. encrypt (AES256)            20656 bytes
4. decrypt                    round trip identical
5. DESTROY                    0v 0c 0e · 0 tables · 0 fn · 0 trg · 0 pol
6. restore (psql)             replayed with ON_ERROR_STOP=1
7. verify
  after      3v 8c 13e · 12 tables · 47 fn · 2 trg · 5 pol · d09e56dd2ffe
  OK  vendors 3->3   customers 8->8   entries 13->13
  OK  empreinte d09e56dd2ffe8d6b4c2c005e22dfa3ab -> (identical)
  OK  tables 12->12  fonctions 47->47  triggers 2->2  policies 5->5
8. OK  an over-balance debit is refused with SW006
```

It took four attempts to get there, and the three failures are the reason this
job exists rather than a documented procedure nobody runs:

1. The seed claimed customer confirmation on a `vendor_correction` and was
   refused — the guard was right, the seed was wrong.
2. `pg_dump` resolved to **16.15 against a Postgres 17 server**. Installing
   `postgresql-client-17` is not enough: the runner already carries client 16 and
   keeps the higher `alternatives` priority for `pg_dump`, so the name on `PATH`
   stayed 16 while `psql` resolved to 17. A `pg_dump` older than the server
   refuses outright — `backup.yml` would have failed the same way on its first
   night, at 02:37, with nothing but a version error.
3. The drill's own post-destroy census still queried `public.vendors`. A subquery
   naming a missing relation fails at *parse* time, so it cannot be guarded with
   `CASE` or `coalesce` — it has to not be in the statement.

None of those would have been visible from a green backup job.

### Restoring for real

You need the dated archive, the `BACKUP_GPG_PASSPHRASE`, and a target database.

```bash
# 1. Decrypt. This writes plaintext containing every phone number and every
#    balance in the system — do it somewhere you are willing to have that.
gpg --batch --decrypt \
    --passphrase "$BACKUP_GPG_PASSPHRASE" \
    --output dump.sql \
    backups/sika-warri-2026-08-22.sql.gpg

# 2. Look at it before you run it. A dump under ~20 KB, or one with no
#    "COPY public.ledger_entries", is a failed dump that encrypted cleanly.
ls -la dump.sql
grep -c 'COPY public\.' dump.sql

# 3. Replay it. ON_ERROR_STOP matters: without it psql carries on past a failed
#    statement and leaves you with a half-restored database that looks fine.
psql "$TARGET_DB_URL" --no-psqlrc --set=ON_ERROR_STOP=1 --file dump.sql

# 4. Shred the plaintext.
shred -u dump.sql
```

The dump is taken with `--clean --if-exists --no-owner --no-privileges`, so it
drops what it is about to recreate and does not insist on the original role
names — a restore into a fresh Supabase project with different roles works.

### After a restore into a NEW project

The database is only part of it. Four things do not travel in the dump:

1. **Auth users.** `auth.users` lives outside the `public` schema and is not
   dumped. Profile rows in `vendors` and `customers` keep their `auth_user_id`,
   but those ids point at users that no longer exist, so **nobody can log in**
   until the auth users are recreated with the same ids. There is no automated
   path for this yet — see Known gaps.
2. **Edge Function secrets.** `SIKA_PIN_PEPPER_V*`, `SIKA_PIN_PEPPER_CURRENT`
   and `SIKA_SUPABASE_SECRET_KEY` must be set on the new project. **The pepper
   must be the same value**, or every stored PIN hash becomes unverifiable and
   every account is locked out permanently. The pepper is the one secret whose
   loss is not recoverable — see "Rotation du poivre".
3. **The deployed functions.** `npx supabase functions deploy` for each.
4. **The app's env.** `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`
   in `.env.local`, then rebuild and redeploy — the project ref is compiled into
   the bundle.

### Verifying a restore yourself

```sql
select
  (select count(*) from vendors)        as vendors,
  (select count(*) from customers)      as customers,
  (select count(*) from ledger_entries) as entries,
  (select md5(string_agg(
     id::text || vendor_id::text || customer_id::text ||
     direction || kind || amount_cfa::text, '|' order by id))
   from ledger_entries)                 as fingerprint;
```

Run it against the source before the dump and against the target after the
restore. The fingerprint is the check that matters: matching row counts can be
produced by two different failures.

---

## Keepalive

Supabase free-tier projects **pause after 7 days with no activity** and must be
restored by hand from the dashboard. For a vendor at a counter that is not a
delay — it is an outage with no error message anyone can act on.

`.github/workflows/keepalive.yml` runs `scripts/keepalive.mjs` on **Monday and
Thursday**. It inserts one row into `heartbeat` and deletes rows older than seven
days.

Twice weekly rather than daily, on purpose: the threshold is 7 days, so two runs
a week leaves days of margin after a single failure, and a daily job hides a
broken schedule for longer because nobody notices one skipped run out of thirty.
It writes rather than reads, because a read can be served by the pooler without
the database itself waking.

To check it is alive:

```sql
select count(*), max(pinged_at) from heartbeat;
```

If `max(pinged_at)` is more than four days old, the schedule has stopped.
GitHub silently drops scheduled runs on repositories with no activity for 60
days, which is the failure worth watching for.

---

## Operational secrets

Both workflows need repository secrets — Settings > Secrets and variables >
Actions:

| Secret | Used by | What it is |
| --- | --- | --- |
| `SUPABASE_DB_URL` | keepalive, backup | Production connection string, **Session pooler** — Dashboard > Project Settings > Database > Connection string > Session pooler. NOT the direct `db.<ref>.supabase.co` URI: it is IPv6-only on the free tier and Actions runners have no IPv6, so it can never connect. NOT the transaction pooler on 6543 either: `pg_dump` needs session-level features it does not provide. `scripts/check-db-url.mjs` refuses both shapes before a dump is attempted |
| `BACKUP_GPG_PASSPHRASE` | backup | A long random passphrase. **Store it somewhere other than this repository** — a backup you cannot decrypt is not a backup |

Neither workflow can run before those are set. `backup.yml` checks for both and
fails loudly if either is missing, rather than dumping an empty file, encrypting
it successfully, and going green.

The restore drill needs no secrets: it uses its own throwaway container.

---

## SMS — what it costs and what it would buy

Researched 22 August 2026. Prices are what the providers publish; the FX used for
conversions is 1 USD = 561.52 XOF, 1 EUR = 1.1699 USD, and XOF is pegged at
655.957/EUR.

### The spread is 40×, and it decides the feature

| Route | Per SMS | In FCFA |
| --- | --- | --- |
| Twilio | $0.4925 | ~277 |
| AWS End User Messaging | $0.34992 | ~196 |
| Plivo (Orange / MTN / Moov) | $0.30 / $0.3312 / $0.50 | ~168 / 186 / 281 |
| BulkGate, **registered** alpha sender | €0.0182 | ~12 |
| Africa's Talking (Orange) | ~$0.021 → $0.016 | **12 → 9** |
| Africa's Talking (MTN) | ~$0.032 → $0.027 | 18 → 15 |
| Local aggregators (IvoireSMS, Yellika, proSMS) | ~$0.015–0.036 | **8.3 – 20** |
| **Orange Developer "SMS CI 2.0" API** | ~$0.0129 | **7.25** |

Orange's own API is the cheapest and covers *"any operator"* in and to Côte
d'Ivoire, not just Orange. 1 000 SMS costs 7 260 FCFA. Constraints: 5 TPS, a
100 000 FCFA/day purchase cap per SIM (≈13 800 SMS/day), and payment by airtime
or Orange Money only.

The international CPaaS options are 20–40× that. **Twilio at 277 FCFA per message
costs more than the median change entry this product records.** That is the
number that makes SMS-on-every-event impossible and SMS-on-debt-creation
affordable.

Registering the alphanumeric sender ID is worth roughly **10–14× on price**, not
only on deliverability: BulkGate's unregistered Orange route is €0.2478 and its
registered route is €0.0182.

### What SMS would actually buy us

One thing, and it is the largest hole in the debt register: **a vendor can record
a déclarée debt against any phone number, including numbers belonging to people
who have never heard of Sika Warri, and that person never learns of it.** A claim
nobody can see is a claim nobody can dispute. Everything else in the design
assumes the person eventually registers and meets the review queue.

At Orange's 7.25 FCFA, notifying on **debt creation only** is the affordable
version. A vendor writing twenty debts a month costs 145 FCFA to notify. It does
**not** need to cover change credits, which are in the customer's favour and
carry no fraud incentive.

It would **not** stop a vendor fabricating a debt against someone standing in
front of them — that is what the two-device handshake is for.

### Before sending a single message

**Register the sender ID, and budget for MTN.** Orange's own FAQ:

> *"the processing time is within 5 working days (**for MTN 15 working days**).
> Please do not use Sender Name/Names before you get email confirmation."*

Registration is with the **operators**, not with ARTCI — there is no ARTCI
sender-ID registry. Nobody publishes a registration fee; Orange, Twilio and
Africa's Talking all list it as free. Documents Orange CI Business asks for:
statuts d'entreprise, récépissé d'existence, pièce d'identité du responsable,
facture de service.

**MTN is the hard gate**, stated consistently by Twilio, Telnyx, Bird and Vonage:
an unregistered alphanumeric sender is rewritten or dropped, and a **numeric
sender ID fails outright on MTN**. Use a brand-specific sender; generic ones
(INFO, Verify, Notify) are refused, and "Google" is prohibited outright.

### Deliverability, from the operator's own mouth

Orange's SMS CI API FAQ:

> **"Delivery issues to MTN users — We are aware that there are some delivery
> issues towards MTN users. This is due to SMS management rules on MTN."**

The largest operator publicly states its A2P platform has structural delivery
problems into the second largest (~35% of subscribers, the 05 prefix). **Do not
run OTP or debt notifications to MTN on a single route.**

Also true, and each of these would bite:

- **Handset delivery receipts are unreliable in CI.** A DLR is not proof of
  receipt, so "we notified them" is not a claim the ledger can make.
- **No two-way SMS and no domestic long codes.** A customer cannot reply to
  dispute a claim by SMS; the reply path has to be the app.
- **Content filtering is aggressive and Orange CI is the strictest.** Money words
  (FCFA, Gain, Gratuit, Prêt), urgency words, and **URL shorteners** are filtered.
  A debt notification that names an amount in FCFA is exactly the shape of
  message that gets dropped — this needs testing against real handsets on all
  three networks before it is relied on.
- **Moov's international routes are being re-gated.** Moov Africa CI signed an
  exclusive A2P firewall agreement with Omobio on 15–16 July 2026. Expect
  international routes into Moov to be re-priced upward and bypass routes closed.
- Moov publishes **no** A2P rate card at all. Reach Moov subscribers through
  Orange's all-operator API or a local aggregator.

### The law that binds us

Not an ARTCI decision but statute: **Loi n°2013-546 du 30 juillet 2013, art. 14**
prohibits direct marketing by SMS without prior express consent, and **art. 15**
requires a free opt-out path. A debt notification is transactional rather than
marketing, so art. 14 does not bite — but a "your neighbour also uses Sika Warri"
message would, and so would anything promotional. **Loi n°2013-450** covers
personal data.

### Decision

Not now. `SIKA_REQUIRE_VENDOR_SMS_VERIFICATION` and
`SIKA_REQUIRE_CUSTOMER_SMS_VERIFICATION` both stay **false**, and the plumbing is
written and tested so turning them on is a configuration change.

When it is turned on, the order is: Orange Developer API as the primary route, a
second route for MTN, sender ID registered as transactional **15 working days
before** launch, debt creation only, and a real-handset test on all three
networks before anyone relies on it.

---

## Known gaps

Recorded so they are not quietly forgotten.

1. **A vendor can record a debt against a number and the owner never learns of
   it.** The largest hole in the debt register. `déclarée` entries are required —
   it is how the paper carnet works and what makes this usable on day one — and
   a claim nobody can see is a claim nobody can dispute. Everything else in the
   design assumes the person eventually registers and meets the review queue,
   which is where every pre-loaded claim surfaces unconfirmed.

   The fix is an SMS on debt creation, and it is now costed rather than waved
   at: **7.25 FCFA** through Orange's own API, which covers all three operators.
   A vendor writing twenty debts a month costs 145 FCFA to notify. See "SMS —
   what it costs and what it would buy" above for why it is not on yet, and what
   has to happen first — 15 working days of MTN sender-ID registration being the
   long pole.

2. **Expired-token rejection is reasoned, not proven.** Every authenticated
   function validates the caller through `auth.getUser()`, which sends the token
   to Supabase, where signature and expiry are both checked. Rejection has been
   verified live for a missing token, a malformed token, a tampered signature,
   and a valid token belonging to a different user. It has **not** been verified
   for a genuinely expired but validly signed token: manufacturing one requires
   the project's signing key, and real access tokens last an hour. The gap is
   narrow — the same code path is exercised by the tampered-token case — but it
   is not evidence.

3. **A restore into a new project cannot restore logins.** The backup covers the
   `public` schema. `auth.users` does not live there and is not dumped, so after
   restoring into a fresh project every `vendors.auth_user_id` and
   `customers.auth_user_id` points at a user that does not exist and **nobody can
   sign in**. The ledger is intact and readable by an operator; the app is not
   usable until the auth users are recreated with their original ids.

   Not fixed here because the fix is a decision, not code: either dump
   `auth.users` too — which puts every PIN hash in `backups/` alongside the
   phone numbers, doubling what one leaked passphrase costs — or accept that a
   full-project restore is followed by a re-registration flow. Restoring in
   place, which is the far likelier disaster, is unaffected: the auth users are
   still there.

4. **One phone number, one role.** The auth user is keyed on the phone number
   and a vendor PIN is 6 digits where a customer's is 4, so a single number
   cannot be both. Registration says so plainly rather than creating a
   half-usable account.

5. **Phone enumeration is possible by design.** A vendor must be able to tell
   whether a number is already known before offering to create it inline.
   Minimised rather than eliminated: the lookup returns existence plus the
   asking vendor's own label, never a name entered by another vendor, and is
   rate limited to 60 lookups per 10 minutes per vendor.

6. **`v_vendor_confirmation_mix` is a signal, not a verdict.** A vendor
   legitimately serving customers without smartphones shows a high
   `vendor_device` share; so does a vendor harvesting PINs. The number says
   where to look, nothing more.

7. **Acceptance test 8 is half-proven.** The database keeps per-vendor balances
   structurally separate and no query sums them. The promise that no *screen*
   ever presents a single spendable total cannot be tested until the customer
   app exists.

8. **Acceptance test 10 is not started.** Offline queueing, service worker, and
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
