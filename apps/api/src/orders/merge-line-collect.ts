import type { PriceType } from "@prisma/client";
import { copyCategoryTaxSnapshot, type CategoryTaxType } from "@routeflow/pricing";

/**
 * Merge/consolidate meta-building, shared by `mergeAllPendingForCustomer` and
 * `forceConsolidateCustomer` — the two call sites were textually identical (kept
 * `orders.service.ts` inside its size ratchet, B297 round 3).
 */

export interface LoserContribution {
  qty: unknown;
  boxes: number | null;
  pieces: number | null;
  /** BUY_N_GET_M snapshot so the merged line re-derives its free units. */
  promoFreeUnits: number | null;
  /** Whether the contribution is buyer-priced — gates earning NEW free units. */
  priceType: PriceType;
  overriddenBy: string | null;
}

export interface NewLineMeta {
  unitPrice: number;
  priceType: PriceType;
  originalPrice: number | null;
  overrideReason: string | null;
  overriddenBy: string | null;
  notes: string | null;
  trackedCategoryId: string | null;
  categoryTaxType: CategoryTaxType | null;
  categoryTaxRate: number | null;
  categoryPriceIncludesTax: boolean | null;
}

export interface UnlistedNewItem {
  name: string | null;
  qty: number;
  unitPrice: number;
  priceType: PriceType;
  originalPrice: number | null;
  overrideReason: string | null;
  overriddenBy: string | null;
  notes: string | null;
}

export interface CollectedMergeLines {
  /** productId -> every loser contribution, for re-prorating a boxed merge. */
  loserContribsByProduct: Map<string, LoserContribution[]>;
  /** productId -> the meta for a brand-new winner line (a product only losers had). */
  newItemMetaByProduct: Map<string, NewLineMeta>;
  /** Catalog-free loser lines — appended to the winner as their own new lines. */
  unlistedNewItems: UnlistedNewItem[];
}

/**
 * Walks every loser's line items once, splitting them into the three shapes the
 * merge transaction needs. First occurrence (iteration order = caller's, DESC
 * updatedAt in both call sites) wins on `newItemMetaByProduct` price/metadata.
 *
 * B297 (SA-098a): a product-keyed new-line's trio is COPIED verbatim from the
 * losing line via `copyCategoryTaxSnapshot` — a merge is not a new sale, so the
 * trio must never be re-derived from the live category here.
 */
export function collectMergeLines(
  losers: ReadonlyArray<{ lineItems: ReadonlyArray<any> }>,
  winnerProductIds: ReadonlySet<string | null>,
): CollectedMergeLines {
  const loserContribsByProduct = new Map<string, LoserContribution[]>();
  const newItemMetaByProduct = new Map<string, NewLineMeta>();
  const unlistedNewItems: UnlistedNewItem[] = [];

  for (const loser of losers) {
    for (const li of loser.lineItems) {
      if (!li.productId) {
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
        continue;
      }
      const contribs = loserContribsByProduct.get(li.productId) ?? [];
      contribs.push({
        qty: li.qty,
        boxes: li.boxes,
        pieces: li.pieces,
        promoFreeUnits: (li as any).promoFreeUnits ?? null,
        priceType: li.priceType,
        overriddenBy: li.overriddenBy,
      });
      loserContribsByProduct.set(li.productId, contribs);
      if (!winnerProductIds.has(li.productId) && !newItemMetaByProduct.has(li.productId)) {
        newItemMetaByProduct.set(li.productId, {
          unitPrice: Number(li.unitPrice),
          priceType: li.priceType,
          originalPrice: li.originalPrice !== null ? Number(li.originalPrice) : null,
          overrideReason: li.overrideReason,
          overriddenBy: li.overriddenBy,
          notes: li.notes,
          trackedCategoryId: li.trackedCategoryId ?? null,
          ...copyCategoryTaxSnapshot(li as any),
        });
      }
    }
  }

  return { loserContribsByProduct, newItemMetaByProduct, unlistedNewItems };
}
