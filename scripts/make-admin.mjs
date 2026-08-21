// Grant admin rights to a phone number.
//
// Deliberately a script run by whoever holds the database credentials, not a
// screen and not an Edge Function. There is no bootstrap path through the app:
// the first admin cannot be created by anything the app exposes, so a bug in
// the app can never mint one.
//
//   SUPABASE_DB_URL=... node scripts/make-admin.mjs 0700000001
//
// Reads the connection string from the environment. Never from .env.local: that
// file is for public frontend values only.

import pg from 'pg';

const brut = process.argv[2];
if (!brut) {
  console.error('Usage: node scripts/make-admin.mjs <phone>');
  console.error('  e.g. node scripts/make-admin.mjs 0700000001');
  process.exit(1);
}

const url = process.env.SUPABASE_DB_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error('Missing SUPABASE_DB_URL (or DATABASE_URL).');
  console.error('Supabase dashboard > Project Settings > Database > Connection string > URI');
  process.exit(1);
}

// Same normalisation the app uses, kept simple here to avoid importing Deno-side
// code into a plain node script.
const digits = brut.replace(/\D+/g, '');
const local = digits.startsWith('225') ? digits.slice(3) : digits;
if (local.length !== 10) {
  console.error(`"${brut}" is not a 10-digit Ivorian number.`);
  process.exit(1);
}
const msisdn = `225${local}`;

const client = new pg.Client({ connectionString: url });
await client.connect();

// A vendor OR a customer may be an admin; an admin need not have a shop at all.
const { rows } = await client.query(
  `select 'vendor' as role, auth_user_id, business_name as nom from vendors where phone = $1 and auth_user_id is not null
   union all
   select 'customer' as role, auth_user_id, display_name as nom from customers where phone = $1 and auth_user_id is not null`,
  [msisdn]
);

if (rows.length === 0) {
  console.error(`No registered account for ${msisdn}. Register in the app first, then re-run this.`);
  await client.end();
  process.exit(1);
}

for (const r of rows) {
  await client.query(
    `insert into app_admins (auth_user_id, note)
     values ($1, $2)
     on conflict (auth_user_id) do update set note = excluded.note`,
    [r.auth_user_id, `${r.role} ${msisdn}${r.nom ? ' — ' + r.nom : ''}`]
  );
  console.log(`  admin granted: ${r.role} ${msisdn}${r.nom ? ' (' + r.nom + ')' : ''}`);
}

const { rows: tous } = await client.query(
  'select auth_user_id, note, created_at from app_admins order by created_at'
);
console.log(`\n${tous.length} admin(s) total:`);
for (const a of tous) console.log(`  ${a.note ?? a.auth_user_id}`);

await client.end();
