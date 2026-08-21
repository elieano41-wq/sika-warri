// Customer balances, per shop.
//
// ACCEPTANCE TEST 8 LIVES HERE. Standing rule 1: a balance exists for a
// (customer, vendor) pair. There is no global customer balance, and no screen
// may present one as spendable.
//
// The spec does allow an informational total, but only carrying the exact line
// "Répartie chez N commerçants — utilisable dans chaque boutique séparément".
// So this module makes that structural rather than a matter of remembering:
// there is NO function that returns a bare total. The only way to obtain the
// figure is informationalTotal(), which returns the amount and its caption
// together in one object. A screen cannot render the number without also having
// the sentence that qualifies it in hand.
//
// If you are here to add a `total()` helper: that is the thing this file exists
// to prevent. See tests/20-no-cross-vendor-sum.test.ts.

export interface ShopBalance {
  vendorId: string;
  /** The shop's own name. Never a customer-supplied label. */
  shopName: string;
  quartier: string | null;
  amountCfa: number;
  lastActivityAt: string | null;
}

export interface InformationalTotal {
  /** Informational ONLY. Never spendable, never presented without the caption. */
  amountCfa: number;
  shopCount: number;
  /** Required verbatim by the spec. Bound to the amount so it cannot be dropped. */
  caption: string;
}

/**
 * Shape rows from v_balances into one entry per shop.
 *
 * Rows arrive already scoped to the signed-in customer by row level security,
 * and each row is one (vendor, customer) pair. This function deliberately does
 * NOT group, merge, fold or reduce across vendors — one row in, one card out.
 * Entries with nothing left are dropped: a shop where the customer holds no
 * change is not a relationship worth showing.
 */
export function perShop(
  rows: Array<{
    vendor_id: string;
    balance_cfa: number;
    last_activity_at: string | null;
    business_name?: string | null;
    quartier?: string | null;
  }>
): ShopBalance[] {
  return rows
    .filter((r) => r.balance_cfa > 0)
    .map((r) => ({
      vendorId: r.vendor_id,
      shopName: r.business_name ?? 'Boutique',
      quartier: r.quartier ?? null,
      amountCfa: r.balance_cfa,
      lastActivityAt: r.last_activity_at,
    }))
    // Largest first: the spec asks for this ordering on the vendor's client
    // list, and it is the useful order here too.
    .sort((a, b) => b.amountCfa - a.amountCfa);
}

/**
 * The informational total, inseparable from its caption.
 *
 * Returns null for a single shop. With one shop the figure IS that shop's
 * balance, and repeating it under a "spread across 1 shop" caption would
 * suggest a pooled sum where none exists — the precise impression rule 1
 * forbids.
 */
export function informationalTotal(shops: ShopBalance[]): InformationalTotal | null {
  if (shops.length < 2) return null;

  const amountCfa = shops.reduce((sum, s) => sum + s.amountCfa, 0);

  return {
    amountCfa,
    shopCount: shops.length,
    caption: captionFor(shops.length),
  };
}

/** The verbatim wording the spec requires, with the count filled in. */
export function captionFor(shopCount: number): string {
  return `Répartie chez ${shopCount} commerçants — utilisable dans chaque boutique séparément`;
}

/**
 * What a customer may spend in one place: never the total, always one shop.
 *
 * Exists so a screen asking "how much can they use here" has an answer that is
 * per-shop by construction, rather than reaching for the total and subtracting.
 */
export function spendableAt(shops: ShopBalance[], vendorId: string): number {
  return shops.find((s) => s.vendorId === vendorId)?.amountCfa ?? 0;
}

// ---------------------------------------------------------------------------
// The vendor's own side
// ---------------------------------------------------------------------------

/**
 * "Monnaie en circulation" — what ONE vendor owes across their own customers.
 *
 * This is a sum, and it lives here because this file is the only place allowed
 * to fold over balances. But it is not the thing rule 1 forbids, and the
 * difference is the whole point:
 *
 *   * A CUSTOMER total pools debts owed by different shopkeepers. Presenting it
 *     as spendable would claim Sika Warri holds a single balance. It does not,
 *     and no shopkeeper would honour another's debt.
 *
 *   * A VENDOR total is one shopkeeper's own liability in their own till. It is
 *     a real, single, meaningful figure — the money they are holding for other
 *     people — and the spec asks for it by name on the vendor home screen.
 *
 * Negative balances cannot occur (standing rule 2); clamping at zero means a
 * bug could never make the figure understate what is owed.
 */
export function vendorInCirculation(
  rows: Array<{ balance_cfa: number }>
): { totalCfa: number; customerCount: number } {
  const positifs = rows.filter((r) => r.balance_cfa > 0);
  return {
    totalCfa: positifs.reduce((sum, r) => sum + r.balance_cfa, 0),
    customerCount: positifs.length,
  };
}
