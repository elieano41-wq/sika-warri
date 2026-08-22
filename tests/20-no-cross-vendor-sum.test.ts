// Acceptance test 8 — a customer with balances at three vendors sees three
// separate figures, and no code path sums them into a spendable amount.
//
// This is standing rule 1 as the customer experiences it. The database already
// makes pooling structurally impossible; this file covers the half that only
// exists once there are screens. The failure mode is not a crash — it is a
// perfectly pleasant screen showing "Votre monnaie: 4 300 F", which would be a
// claim that Sika Warri holds a single spendable balance. That is a different
// regulatory product and a false statement about who owes what.
//
// Written alongside the screens, not after them.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  perShop, informationalTotal, captionFor, spendableAt, type ShopBalance,
} from '../src/lib/balances';

const SRC = path.join(process.cwd(), 'src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const sourceFiles = walk(SRC).filter((f) => /\.(ts|tsx)$/.test(f));

/** Strip comments so prose describing the rule does not trip a scan for it. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');
}

const THREE_SHOPS = [
  { vendor_id: 'v1', balance_cfa: 2500, last_activity_at: '2026-08-01T00:00:00Z', business_name: 'Chez Awa' },
  { vendor_id: 'v2', balance_cfa: 1200, last_activity_at: '2026-08-02T00:00:00Z', business_name: 'Kiosque Bamba' },
  { vendor_id: 'v3', balance_cfa: 600, last_activity_at: '2026-08-03T00:00:00Z', business_name: 'Alimentation Koné' },
];

describe('acceptance test 8 — three vendors, three figures', () => {
  it('produces one entry per shop, never a merged one', () => {
    const shops = perShop(THREE_SHOPS);

    expect(shops).toHaveLength(3);
    expect(shops.map((s) => s.amountCfa)).toEqual([2500, 1200, 600]);
    // Each figure stays attached to the shop that owes it. There is no entry
    // whose amount is the sum of others.
    expect(shops.map((s) => s.vendorId).sort()).toEqual(['v1', 'v2', 'v3']);
    expect(shops.some((s) => s.amountCfa === 4300)).toBe(false);
  });

  it('drops shops where nothing is held', () => {
    const shops = perShop([...THREE_SHOPS, { vendor_id: 'v4', balance_cfa: 0, last_activity_at: null }]);
    expect(shops).toHaveLength(3);
  });

  it('the informational total ALWAYS carries its required caption', () => {
    // Takes the SERVER aggregate, not the list. The list is a page.
    const total = informationalTotal({ totalCfa: 4300, shopCount: 3 });

    expect(total).not.toBeNull();
    expect(total!.amountCfa).toBe(4300);
    // The amount and the sentence qualifying it are one object. A screen cannot
    // obtain the figure without also holding the words that say it is not
    // spendable as one sum.
    expect(total!.caption).toBe(
      'Répartie chez 3 commerçants — utilisable dans chaque boutique séparément'
    );
  });

  it('the caption is the spec wording verbatim, for any count', () => {
    expect(captionFor(4)).toBe(
      'Répartie chez 4 commerçants — utilisable dans chaque boutique séparément'
    );
    expect(captionFor(2)).toContain('utilisable dans chaque boutique séparément');
  });

  it('returns NO total for a single shop', () => {
    // With one shop the total IS that shop's balance. Repeating it under a
    // "spread across 1 shop" caption would imply a pool where none exists.
    expect(informationalTotal({ totalCfa: 2500, shopCount: 1 })).toBeNull();
    expect(informationalTotal({ totalCfa: 0, shopCount: 0 })).toBeNull();
    expect(informationalTotal(null)).toBeNull();
  });

  it('reports what the SERVER said, even when it disagrees with the page', () => {
    // The regression, at the unit level. A page showing three shops worth 4 300
    // while the server says 137 shops and 91 200 F means the customer holds
    // change at more shops than the page lists — and the sentence they read must
    // describe the server's answer, not the page's.
    const total = informationalTotal({ totalCfa: 91200, shopCount: 137 });

    expect(total!.amountCfa).toBe(91200);
    expect(total!.shopCount).toBe(137);
    expect(total!.caption).toContain('137 commerçants');
  });

  it('cannot be handed a list by mistake', () => {
    // The old signature took ShopBalance[] and folded over it. If that ever
    // comes back, this file stops compiling rather than silently understating a
    // total again.
    const source = readFileSync(path.join(SRC, 'lib', 'balances.ts'), 'utf8');
    expect(code(source)).not.toMatch(/\.reduce\s*\(/);
    expect(code(source)).toMatch(/CustomerAggregate/);
  });

  it('what is spendable is always per shop, never the total', () => {
    const shops = perShop(THREE_SHOPS);
    expect(spendableAt(shops, 'v1')).toBe(2500);
    expect(spendableAt(shops, 'v3')).toBe(600);
    // A vendor the customer holds nothing with yields zero, not a share of the
    // total.
    expect(spendableAt(shops, 'inconnu')).toBe(0);
  });

  it('no spendable figure anywhere equals the sum', () => {
    const shops = perShop(THREE_SHOPS);
    const total = informationalTotal({ totalCfa: 4300, shopCount: 3 })!.amountCfa;
    for (const s of shops) {
      expect(spendableAt(shops, s.vendorId)).not.toBe(total);
    }
  });
});

describe('acceptance test 8 — structural guarantees in the source', () => {
  it('balances.ts exports no bare total or sum function', () => {
    const src = code(readFileSync(path.join(SRC, 'lib', 'balances.ts'), 'utf8'));

    // The only way to the figure is informationalTotal(), which returns the
    // caption with it. A bare total() would be a loaded gun for any future
    // screen.
    expect(src).not.toMatch(/export\s+function\s+total\b/);
    expect(src).not.toMatch(/export\s+function\s+sum\b/);
    expect(src).not.toMatch(/export\s+function\s+totalSpendable\b/);
    expect(src).not.toMatch(/export\s+function\s+soldeTotal\b/);
  });

  it('ONLY balances.ts may fold over balances', () => {
    // The real guard. A reduce/sum anywhere else in src is how a cross-vendor
    // total gets computed by accident — so the operation is confined to the one
    // file whose whole job is to keep it captioned.
    const offenders = sourceFiles
      .filter((f) => !f.endsWith(path.join('lib', 'balances.ts')))
      .filter((f) => /\.(reduce|reduceRight)\s*\(/.test(code(readFileSync(f, 'utf8'))))
      .map((f) => path.relative(process.cwd(), f));

    expect(offenders).toEqual([]);
  });

  it('no screen renders a figure labelled as one global balance', () => {
    // Copy-level guard against the exact sentence that would misrepresent the
    // product, even if the arithmetic were per-shop.
    const forbidden = [
      /votre\s+monnaie\s*:\s*\{/i,   // "Votre monnaie: {total}"
      /monnaie\s+totale/i,
      /total\s+disponible/i,
      /monnaie\s+Sika\s*Warri/i,
    ];

    for (const file of sourceFiles) {
      const src = code(readFileSync(file, 'utf8'));
      for (const pattern of forbidden) {
        expect(src, `${path.relative(process.cwd(), file)} matches ${pattern}`)
          .not.toMatch(pattern);
      }
    }
  });

  it('the API layer returns rows and does not aggregate them', () => {
    const src = code(readFileSync(path.join(SRC, 'lib', 'api.ts'), 'utf8'));
    // Shaping belongs in balances.ts, where the caption rule lives. If the API
    // aggregated, a screen could get a total with no caption in sight.
    expect(src).not.toMatch(/\.reduce\s*\(/);
    expect(src).toMatch(/myShopBalances/);
  });
});

describe('perShop ordering and shape', () => {
  it('orders by amount, largest first', () => {
    const shuffled = [THREE_SHOPS[2]!, THREE_SHOPS[0]!, THREE_SHOPS[1]!];
    expect(perShop(shuffled).map((s) => s.amountCfa)).toEqual([2500, 1200, 600]);
  });

  it('falls back to a neutral shop name rather than showing nothing', () => {
    const shops = perShop([{ vendor_id: 'v9', balance_cfa: 100, last_activity_at: null }]);
    expect(shops[0]!.shopName).toBe('Boutique');
  });

  it('carries no field that could hold a cross-vendor total', () => {
    const shops: ShopBalance[] = perShop(THREE_SHOPS);
    for (const s of shops) {
      expect(Object.keys(s).sort()).toEqual(
        ['amountCfa', 'lastActivityAt', 'quartier', 'shopName', 'vendorId'].sort()
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The screen itself (build item B)
// ---------------------------------------------------------------------------

describe('acceptance test 8 — the customer balance screen', () => {
  const ecran = readFileSync(
    path.join(SRC, 'screens', 'client', 'MaMonnaie.tsx'), 'utf8'
  );

  it('renders one card per shop, from perShop', () => {
    expect(code(ecran)).toMatch(/perShop\(/);
    // One map over shops, one card each. No grouping or merging step.
    expect(code(ecran)).toMatch(/shops\.map\(/);
  });

  it('obtains the total ONLY through informationalTotal', () => {
    expect(code(ecran)).toMatch(/informationalTotal\(/);
    // Any local arithmetic here would produce an uncaptioned figure.
    expect(code(ecran)).not.toMatch(/\.reduce\s*\(/);
    expect(code(ecran)).not.toMatch(/balance_cfa\s*\+/);
  });

  it('renders the caption wherever it renders the total', () => {
    // The amount and its caption come from one object, and both are read in
    // the same block. If a future edit dropped the caption, the figure would
    // become a bare "total" — the exact misrepresentation rule 1 forbids.
    const bloc = /total\s*\?[\s\S]*?total\.caption[\s\S]*?\)/.exec(code(ecran));
    expect(bloc, 'total is rendered without its caption').not.toBeNull();
    expect(code(ecran)).toMatch(/total\.amountCfa/);
  });

  it('labels the total as information, never as spendable', () => {
    const texte = ecran.replace(/\s+/g, ' ');
    expect(texte).toMatch(/à titre d'information/i);
    // Never the words that would imply one usable pot.
    expect(texte).not.toMatch(/monnaie totale/i);
    expect(texte).not.toMatch(/total disponible/i);
    expect(texte).not.toMatch(/utilisable partout/i);
  });

  it('says each amount stays with its own vendor', () => {
    const texte = ecran.replace(/\s+/g, ' ');
    expect(texte).toMatch(/reste chez le\s*commer[çc]ant/i);
  });

  it('the vendor total comes from the SERVER, not from the page', () => {
    // Stronger than "computed by a named helper", which is what this asserted
    // before. The client list is BOUNDED — a page — so summing it would
    // understate what the vendor owes the moment there were more customers than
    // the page holds, and would disagree with the home screen while neither
    // reported an error. The total is aggregated in SQL and arrives as one row.
    const clients = code(
      readFileSync(path.join(SRC, 'screens', 'vendeur', 'MesClients.tsx'), 'utf8')
    );
    expect(clients).toMatch(/resume\?\.circulation_cfa/);
    expect(clients).not.toMatch(/\.reduce\s*\(/);
    expect(clients).not.toMatch(/vendorInCirculation/);
  });

  it('a truncated client list says it is truncated', () => {
    // Silently showing the first 200 of 1 234 is the failure this audit was
    // about: incomplete data that looks complete.
    const clients = code(
      readFileSync(path.join(SRC, 'screens', 'vendeur', 'MesClients.tsx'), 'utf8')
    );
    expect(clients).toMatch(/tronque/);
    expect(clients).toMatch(/total_count/);
  });

});
