import type { PriceType } from "@prisma/client";

/** A catalog-free loser line, ready to be appended to the merge winner as its own new line. */
export interface UnlistedMergeItem {
  name: string | null;
  qty: number;
  unitPrice: number;
  priceType: PriceType;
  originalPrice: number | null;
  overrideReason: string | null;
  overriddenBy: string | null;
  notes: string | null;
}

/**
 * Unlisted (catalog-free) loser lines can't be keyed by product — each is appended to the winner as its
 * own new line (never boxed, unaffected by B776). A verbatim move of the loop `mergeAllPendingForCustomer`
 * and `forceConsolidateCustomer` each carried inline (pure: no query, no write).
 */
export function collectUnlistedLoserItems(
  losers: ReadonlyArray<{
    lineItems: ReadonlyArray<{
      productId: string | null;
      name: string | null;
      qty: unknown;
      unitPrice: unknown;
      priceType: PriceType;
      originalPrice: unknown;
      overrideReason: string | null;
      overriddenBy: string | null;
      notes: string | null;
    }>;
  }>,
): UnlistedMergeItem[] {
  const unlistedNewItems: UnlistedMergeItem[] = [];
  for (const loser of losers) {
    for (const li of loser.lineItems) {
      if (li.productId) continue;
      unlistedNewItems.push({
        name: li.name,
        qty: Number(li.qty),
        unitPrice: Number(li.unitPrice),
        priceType: li.priceType,
        originalPrice: li.originalPrice !== null ? Number(li.originalPrice) : null,
        overrideReason: li.overrideReason,
        overriddenBy: li.overriddenBy,
        notes: li.notes,
      });
    }
  }
  return unlistedNewItems;
}
