// Refuse a connection string that cannot possibly work from a CI runner.
//
// THE FAILURE THIS REPLACES. Supabase's direct endpoint, db.<ref>.supabase.co,
// resolves to IPv6 ONLY on the free tier. GitHub Actions runners have no IPv6
// address, so pg_dump gets
//
//   connection to server at "db.<ref>.supabase.co" (2a05:d012:...), port 5432
//   failed: Network is unreachable
//
// which is a true statement about the network and tells you nothing about what to
// change. It happened on the first real backup run, and left to itself it would
// have happened every night at 02:37 with nobody reading the log.
//
// The fix is the session-mode pooler, which has an IPv4 address. Transaction mode
// (port 6543) is NOT usable here: pg_dump needs session-level features that a
// transaction pooler does not provide.
//
//   SUPABASE_DB_URL=... node scripts/check-db-url.mjs

const url = process.env.SUPABASE_DB_URL ?? process.env.DATABASE_URL;

if (!url) {
  console.error('SUPABASE_DB_URL is not set.');
  process.exit(1);
}

let hote;
let port;
try {
  const u = new URL(url);
  hote = u.hostname;
  port = u.port || '5432';
} catch {
  console.error('SUPABASE_DB_URL is not a valid URL.');
  console.error('Expected postgresql://user:password@host:5432/postgres');
  process.exit(1);
}

const messages = [];

if (/^db\..*\.supabase\.co$/.test(hote)) {
  messages.push(
    '',
    'This is the DIRECT endpoint, which is IPv6-only on the Supabase free tier.',
    'GitHub Actions runners have no IPv6 address, so this can never connect —',
    'pg_dump reports "Network is unreachable", which is true and unhelpful.',
    '',
    'Use the SESSION POOLER instead. Supabase dashboard:',
    '  Project Settings > Database > Connection string > Session pooler',
    '',
    'It looks like:',
    '  postgresql://postgres.<ref>:<password>@aws-N-<region>.pooler.supabase.com:5432/postgres',
    '',
    'Copy it from the dashboard rather than assembling it by hand — the pooler',
    'hostname carries a region and a generation number that differ per project.',
    ''
  );
}

if (port === '6543') {
  messages.push(
    '',
    'Port 6543 is the TRANSACTION pooler. pg_dump needs session-level features',
    'that a transaction pooler does not provide, so a dump against it fails or,',
    'worse, produces something incomplete.',
    '',
    'Use the SESSION pooler on port 5432.',
    ''
  );
}

if (messages.length > 0) {
  console.error(`SUPABASE_DB_URL will not work from CI.\n\n  host : ${hote}\n  port : ${port}`);
  console.error(messages.join('\n'));
  process.exit(1);
}

// Not a guarantee — only the connection itself proves reachability. This rules
// out the two shapes that are known-impossible before spending a dump on them.
console.log(`SUPABASE_DB_URL looks usable: ${hote}:${port}`);
