// Keep the project awake, and keep the heartbeat table from growing forever.
//
// WHY THIS EXISTS. Supabase free-tier projects pause after 7 days with no
// activity and have to be restored by hand from the dashboard. For a vendor
// standing at a counter that is not a delay, it is an outage with no error
// message anyone can act on. So something has to touch the database on a
// schedule, and it should be something whose only job is that.
//
// Twice weekly, not daily: the pause threshold is 7 days, and two runs a week
// means a single failed run still leaves days of margin. A daily job would hide
// a broken schedule for longer, because nobody notices one skipped run out of
// thirty.
//
// Writing a row rather than reading one, on purpose. Supabase counts activity,
// and a read against a pooler can be served without the database itself waking.
//
//   SUPABASE_DB_URL=... node scripts/keepalive.mjs

import pg from 'pg';

const url = process.env.SUPABASE_DB_URL ?? process.env.DATABASE_URL;
if (!url) {
  // Standing rule 6: fail loudly, naming exactly what is missing.
  console.error('Missing SUPABASE_DB_URL.');
  console.error('Supabase dashboard > Project Settings > Database > Connection string');
  process.exit(1);
}

const client = new pg.Client({
  connectionString: url,
  // The runner is not inside Supabase's network, and the managed certificate is
  // signed by a CA the runner does not ship. Encrypted, not pinned.
  ssl: { rejectUnauthorized: false },
});

await client.connect();

try {
  const { rows: avant } = await client.query('select count(*)::int as n from public.heartbeat');

  await client.query('insert into public.heartbeat (pinged_at) values (now())');

  // Seven days, matching the pause threshold: enough history to see whether the
  // schedule has been running, and no more. This table is not a log.
  const { rowCount: purges } = await client.query(
    "delete from public.heartbeat where pinged_at < now() - interval '7 days'"
  );

  const { rows: apres } = await client.query(
    'select count(*)::int as n, max(pinged_at) as dernier from public.heartbeat'
  );

  console.log(`heartbeat: ${avant[0].n} -> ${apres[0].n} rows (${purges} pruned)`);
  console.log(`last ping: ${apres[0].dernier}`);
} finally {
  await client.end();
}
