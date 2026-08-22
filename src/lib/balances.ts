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
 * What the server says the customer holds in total, and at how many shops.
 *
 * Both figures come from customer_summary, which aggregates in SQL and returns
 * one row.
 */
export interface CustomerAggregate {
  totalCfa: number;
  shopCount: number;
}

/**
 * The informational total, inseparable from its caption.
 *
 * TAKES THE SERVER AGGREGATE, NOT THE LIST. It used to fold over the shops
 * handed to it, which was wrong for the same reason the vendor's circulation
 * figure was wrong: that list is a page. Worse here, because the caption's count
 * came from the same page, so a truncated list misstated both the amount and the
 * number of shops — "Répartie chez 100 commerçants" when the answer is 137.
 *
 * A list can be a page. A total cannot.
 *
 * Returns null for a single shop. With one shop the figure IS that shop's
 * balance, and repeating it under a "spread across 1 shop" caption would
 * suggest a pooled sum where none exists — the precise impression rule 1
 * forbids.
 */
export function informationalTotal(
  aggregate: CustomerAggregate | null
): InformationalTotal | null {
  if (!aggregate || aggregate.shopCount < 2) return null;

  return {
    amountCfa: aggregate.totalCfa,
    shopCount: aggregate.shopCount,
    caption: captionFor(aggregate.shopCount),
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
