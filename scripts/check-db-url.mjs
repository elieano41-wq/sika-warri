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
let utilisateur;
let motdepasse;
try {
  const u = new URL(url);
  hote = u.hostname;
  port = u.port || '5432';
  utilisateur = decodeURIComponent(u.username || '');
  motdepasse = u.password || '';
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

// The pooler multiplexes every project on one hostname, so the USERNAME is how
// it knows which database to reach: it must be postgres.<project-ref>, not bare
// postgres. Get that wrong and the pooler answers
//
//   FATAL: password authentication failed for user "postgres"
//
// which reads as a wrong password and is not. That cost a backup run, and the
// password is the last thing anyone should be rotating in response.
if (/\.pooler\.supabase\.com$/.test(hote) && !/^postgres\.[a-z0-9]{20}$/.test(utilisateur)) {
  messages.push(
    '',
    `The pooler needs a project-qualified user. Yours is "${utilisateur || '(empty)'}".`,
    '',
    'It must look like postgres.<project-ref> — for this project:',
    '  postgres.bltiifxlfmlfdoqnsdrz',
    '',
    'A bare "postgres" makes the pooler answer',
    '  FATAL: password authentication failed for user "postgres"',
    'which looks like a wrong password and is not. Do not rotate the password.',
    '',
    'Copy the whole string from the dashboard rather than editing one you have:',
    '  Project Settings > Database > Connection string > Session pooler',
    ''
  );
}

// ---------------------------------------------------------------------------
// The password, checked WITHOUT ever printing it.
//
// The dashboard hands you the connection string with a literal [YOUR-PASSWORD]
// placeholder in the middle, and "copy the whole string" is exactly the
// instruction that leaves it there. The pooler then answers
//
//   FATAL: password authentication failed for user "postgres"
//
// — note it reports the tenant-stripped name, so the message looks identical to
// the wrong-username failure. Two different mistakes, one message.
//
// Everything below reports character CLASSES and lengths. Never the value: this
// runs in CI, where stdout is a log anyone with repository access can read.
// ---------------------------------------------------------------------------
if (/^\[.*\]$/.test(motdepasse) || /YOUR.?PASSWORD|MOT.?DE.?PASSE|<password>/i.test(motdepasse)) {
  messages.push(
    '',
    'The password is still the dashboard PLACEHOLDER, not a password.',
    '',
    'The connection string arrives as',
    '  postgresql://postgres.<ref>:[YOUR-PASSWORD]@aws-N-....pooler.supabase.com:5432/postgres',
    'and the [YOUR-PASSWORD] part has to be replaced with the database password.',
    '',
    'If you do not have it: Project Settings > Database > Reset database password.',
    ''
  );
} else if (motdepasse === '') {
  messages.push('', 'The connection string has no password at all.', '');
} else if (/\s/.test(decodeURIComponent(motdepasse))) {
  // Whitespace inside or around the password. Pasting into a secret field can
  // carry a trailing space or a newline, and the URL parses fine either way --
  // the password is simply one character longer than the one that was set, and
  // the pooler answers with the same "password authentication failed" as every
  // other mistake in this string.
  // new URL() silently percent-encodes a raw space to %20, so the check must
  // look at the DECODED value -- otherwise the valid-escape stripping below
  // treats the very whitespace being hunted as correct encoding. That false
  // negative is why this check reads decodeURIComponent and not the raw string.
  const clair = decodeURIComponent(motdepasse);
  const debut = /^\s/.test(clair);
  const fin = /\s$/.test(clair);
  messages.push(
    '',
    'The password contains whitespace.',
    `  leading: ${debut}   trailing: ${fin}   length: ${clair.length}`,
    '',
    'A space or newline that came along with a paste is still part of the',
    'password as far as the URL is concerned. Re-enter the secret with no',
    'trailing newline — select the value precisely rather than the whole line.',
    ''
  );
} else {
  // Characters that must be percent-encoded inside a URL. Un-encoded, they
  // silently truncate or re-parse the string: a # ends it, a / starts the
  // database name, a @ moves the host. The URL still parses, so nothing
  // complains until the pooler rejects a password that is not the one intended.
  // A correctly encoded password CONTAINS % — "%40" is the right way to write an
  // @ — so flagging % outright would reject the fix. What is wrong is a BARE
  // one: a % not followed by two hex digits, or any other reserved character
  // sitting there unencoded.
  const sansEchappes = motdepasse.replace(/%[0-9A-Fa-f]{2}/g, '');
  const problematiques = [
    ...new Set([...sansEchappes].filter((c) => '@:/?#[]%'.includes(c))),
  ];
  if (problematiques.length > 0) {
    messages.push(
      '',
      `The password contains ${problematiques.length} character(s) that must be`,
      'percent-encoded in a URL: ' + problematiques.map((c) => `"${c}"`).join(' '),
      '',
      'Un-encoded, these re-parse the string rather than failing loudly — a "#"',
      'truncates it, a "@" moves the host, a "/" starts the database name. The URL',
      'still looks valid, so the only symptom is a rejected password.',
      '',
      'Encode them, or reset the password to one without them:',
      '  @ -> %40    : -> %3A    / -> %2F    ? -> %3F',
      '  # -> %23    [ -> %5B    ] -> %5D    % -> %25',
      ''
    );
  }
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
console.log(`SUPABASE_DB_URL looks usable: ${utilisateur}@${hote}:${port}`);
// Length only. Enough to tell "the secret changed" from "the secret did not",
// which is the question after a failed run, and not enough to be a leak.
console.log(`  password: ${motdepasse.length} characters, no encoding issues`);
