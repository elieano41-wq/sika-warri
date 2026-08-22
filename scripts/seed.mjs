// Realistic Abidjan data for manual testing, and the fixture the restore drill
// dumps and brings back.
//
// Spec section 10: three vendors, eight customers. The point of "realistic" is
// not decoration — it is that a screen laid out for "Vendor 1" falls apart on
// "Alimentation Générale Koné", and amounts that are all 1000 hide the
// word-spacing problem that 12 500 exposes.
//
// WHAT THIS DOES NOT DO. It creates profile rows, not accounts anyone can log in
// to: auth users live in Supabase's auth schema and are created by the register
// Edge Function, which hashes a PIN with a pepper only the function holds. So
// auth_user_id here is a random uuid that matches no real session. That is the
// honest shape for a SQL-level fixture, and it is why the UI harness registers
// through the API instead of calling this.
//
// Every entry goes through post_ledger_entry. Nothing is inserted into
// ledger_entries directly — the balance guard, the cap and the confirmation rule
// are the things that make this data valid, and a seed that bypassed them could
// produce a state the app can never reach.
//
//   DATABASE_URL=... node scripts/seed.mjs

import pg from 'pg';
import { randomUUID } from 'node:crypto';

const url = process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL;
if (!url) {
  console.error('Missing DATABASE_URL.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// The cast
// ---------------------------------------------------------------------------

const VENDEURS = [
  {
    nom: 'Chez Awa',
    quartier: 'Yopougon',
    commune: 'Abidjan',
    phone: '2250701020304',
    plafond: 3000,
  },
  {
    nom: 'Kiosque Bamba',
    quartier: 'Adjamé',
    commune: 'Abidjan',
    phone: '2250705060708',
    plafond: 2000,
  },
  {
    // Long on purpose: the longest plausible shop name, to catch a layout that
    // only works with short ones.
    nom: 'Alimentation Générale Koné',
    quartier: 'Treichville',
    commune: 'Abidjan',
    phone: '2250709101112',
    plafond: 5000,
  },
];

const CLIENTS = [
  { phone: '2250551020304', nom: 'Aya' },
  { phone: '2250555060708', nom: 'Ibrahim' },
  { phone: '2250559101112', nom: 'Mariam' },
  { phone: '2250751314151', nom: 'Kouassi' },
  { phone: '2250755161718', nom: 'Fatoumata' },
  { phone: '2250759192021', nom: 'Yao' },
  // No display name: a customer a vendor recorded change for who never
  // registered. The screens must cope with the name being absent.
  { phone: '2250122232425', nom: null },
  { phone: '2250126272829', nom: 'Adjoua' },
];

const client = new pg.Client({
  connectionString: url,
  ssl: /supabase\.(co|com)/.test(url) ? { rejectUnauthorized: false } : undefined,
});

await client.connect();

async function poster(a) {
  const { rows } = await client.query(
    `select * from public.post_ledger_entry(
       $1::uuid, $2::uuid, $3::text, $4::text, $5::integer, $6::text,
       $7::uuid, $8::boolean, $9::uuid, $10::text, $11::text)`,
    [
      a.vendorId, a.customerId, a.direction, a.kind, a.amount,
      a.cle ?? randomUUID(), a.actor,
      // Every debit needs the customer's confirmation (amendment D). A seed that
      // set this false for a debit would simply be refused, which is the point.
      a.direction === 'debit', null, a.note ?? null,
      a.methode ?? 'own_device',
    ]
  );
  return rows[0];
}

try {
  console.log('seeding…\n');

  const vendeurs = [];
  for (const v of VENDEURS) {
    const authId = randomUUID();
    const { rows } = await client.query(
      `insert into public.vendors
         (auth_user_id, phone, business_name, quartier, commune,
          max_balance_per_customer, is_active, terms_accepted_at, terms_version)
       values ($1,$2,$3,$4,$5,$6,true, now(), 'v1')
       on conflict (phone) do update set business_name = excluded.business_name
       returning id, auth_user_id`,
      [authId, v.phone, v.nom, v.quartier, v.commune, v.plafond]
    );
    vendeurs.push({ ...v, id: rows[0].id, authId: rows[0].auth_user_id });
    console.log(`  vendor   ${v.nom}`);
  }

  const clients = [];
  for (const c of CLIENTS) {
    const { rows } = await client.query(
      `insert into public.customers (auth_user_id, phone, display_name)
       values ($1,$2,$3)
       on conflict (phone) do update set display_name = excluded.display_name
       returning id, auth_user_id`,
      [randomUUID(), c.phone, c.nom]
    );
    clients.push({ ...c, id: rows[0].id, authId: rows[0].auth_user_id });
    console.log(`  customer ${c.nom ?? c.phone}`);
  }

  // A spread of shapes rather than a uniform grid, because the interesting bugs
  // live in the edges: a customer at three shops at once (acceptance test 8), a
  // balance spent down to nothing, a reversal, and amounts long enough to test
  // the thousands separator.
  console.log('');
  let n = 0;

  // Aya holds change at all three shops — the acceptance test 8 case.
  for (const [i, v] of vendeurs.entries()) {
    await poster({
      vendorId: v.id, customerId: clients[0].id, direction: 'credit',
      kind: 'change', amount: [1500, 800, 275][i], actor: v.authId,
    });
    n += 1;
  }

  // A busy day at Chez Awa.
  const awa = vendeurs[0];
  for (const [i, c] of clients.slice(1, 5).entries()) {
    await poster({
      vendorId: awa.id, customerId: c.id, direction: 'credit',
      kind: 'change', amount: [2500, 125, 1975, 50][i], actor: awa.authId,
    });
    n += 1;
  }

  // Ibrahim spends most of his, leaving an awkward remainder.
  await poster({
    vendorId: awa.id, customerId: clients[1].id, direction: 'debit',
    kind: 'purchase', amount: 2000, actor: awa.authId,
  });
  n += 1;

  // Mariam is refunded in cash and goes to zero: rule 9, the customer can always
  // demand the money back.
  await poster({
    vendorId: awa.id, customerId: clients[2].id, direction: 'debit',
    kind: 'refund', amount: 125, actor: awa.authId, note: 'Rendu en espèces',
  });
  n += 1;

  // A typo and its correction, so history has a reversal in it.
  const erreur = await poster({
    vendorId: vendeurs[1].id, customerId: clients[5].id, direction: 'credit',
    kind: 'change', amount: 1200, actor: vendeurs[1].authId,
  });
  n += 1;
  await client.query(
    `select * from public.post_ledger_entry(
       $1::uuid, $2::uuid, 'debit', 'reversal', $3::integer, $4::text,
       $5::uuid, true, $6::uuid, $7::text, 'vendor_correction')`,
    [
      vendeurs[1].id, clients[5].id, 1200, randomUUID(),
      vendeurs[1].authId, erreur.id, 'Montant saisi par erreur',
    ]
  );
  n += 1;

  // One confirmed on the vendor's phone rather than the customer's — the
  // degraded path from amendment I, which the screens must mark as such.
  await poster({
    vendorId: vendeurs[2].id, customerId: clients[6].id, direction: 'credit',
    kind: 'change', amount: 12500, actor: vendeurs[2].authId,
  });
  n += 1;
  await poster({
    vendorId: vendeurs[2].id, customerId: clients[6].id, direction: 'debit',
    kind: 'purchase', amount: 500, actor: vendeurs[2].authId,
    methode: 'vendor_device',
  });
  n += 1;

  const { rows: bilan } = await client.query(`
    select v.business_name,
           count(distinct e.customer_id)::int as clients,
           sum(case when e.direction='credit' then e.amount_cfa else -e.amount_cfa end)::int as circulation
    from public.ledger_entries e
    join public.vendors v on v.id = e.vendor_id
    group by v.business_name order by 3 desc
  `);

  console.log(`${n} entries posted through post_ledger_entry\n`);
  for (const b of bilan) {
    console.log(`  ${b.business_name.padEnd(28)} ${b.clients} clients · ${b.circulation} F`);
  }
  console.log('\nseed complete');
} finally {
  await client.end();
}
