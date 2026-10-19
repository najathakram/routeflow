import { hasNullTrio } from "@routeflow/pricing";
import { loadEffectiveAttributes } from "../products/effective-product-attributes";

/**
 * B297 row 340 (SA-734r2 r-note 3, MED-3): the ONE rule a fold uses to decide whether added quantity may be
 * ADDED to an existing line or must go on a NEW line. A line's rate trio is the rate it was sold at; units
 * folded into it are priced at that trio. That is right only when the new units would have been sold at the
 * same trio. When they would not (the category's rate changed, the product moved category, or it became
 * regulated since), the added quantity is a sale made today: it goes on a NEW line stamped live, and the old
 * line keeps its own units and trio.
 *
 *   ADD    the trios are equal in effect: add the quantity to the line, as before;
 *   SPLIT  they differ: the added quantity goes on its own line.
 *
 * "Equal in effect": both uncategorised; or the same category and either side has no stamped trio yet (the
 * recompute stamps it from that category's live trio, SA-096a) or both trios match (type, rate, price
 * includes tax). Callers: `foldMergeItems` (staff and buyer fold: the incoming trio is the product's LIVE
 * trio) and `buildMergeLineWrites` (mergeAllPendingForCustomer / forceConsolidateCustomer: the incoming trio
 * is the losing line's OWN trio). A caller pin (fold-target.caller-pin.spec.ts) fails if either stops using
 * this function.
 */
export interface FoldTrio {
  trackedCategoryId?: string | null;
  categoryTaxType?: unknown;
  categoryTaxRate?: unknown;
  categoryPriceIncludesTax?: boolean | null;
}

export type FoldTargetVerdict = "ADD" | "SPLIT";

export function foldTarget(existing: FoldTrio, incoming: FoldTrio): FoldTargetVerdict {
  const a = existing.trackedCategoryId ?? null;
  const b = incoming.trackedCategoryId ?? null;
  if (a !== b) return "SPLIT"; // a category move, or regulated now / not any more
  if (a == null) return "ADD"; // both uncategorised
  if (hasNullTrio(existing as any) || hasNullTrio(incoming as any)) return "ADD"; // stamped from the category
  const sameType = String(existing.categoryTaxType) === String(incoming.categoryTaxType);
  const sameRate = Number(existing.categoryTaxRate) === Number(incoming.categoryTaxRate);
  const sameIncl = !!existing.categoryPriceIncludesTax === !!incoming.categoryPriceIncludesTax;
  return sameType && sameRate && sameIncl ? "ADD" : "SPLIT";
}

/**
 * The trio a NEW sale of each product would be stamped with today, from the product's category: the
 * `incoming` side of `foldTarget` for a staff or buyer fold. A product with no category yields an
 * uncategorised trio. `db` is any Prisma client / tx.
 */
export async function loadLiveTrioByProduct(
  db: {
    product: { findMany(args: unknown): Promise<any[]> };
    trackedCategory: { findMany(args: unknown): Promise<any[]> };
  },
  productIds: string[],
  tenantId?: string | null,
): Promise<Map<string, FoldTrio>> {
  const out = new Map<string, FoldTrio>();
  if (productIds.length === 0) return out;
  // B2: the category a new sale takes is the EFFECTIVE one (the product's, else its family's).
  const effective = await loadEffectiveAttributes(db, tenantId, productIds);
  const products = [...effective].map(([id, e]) => ({
    id,
    trackedCategoryId: e.trackedCategoryId,
  }));
  const catIds = [...new Set(products.map((p) => p.trackedCategoryId).filter(Boolean))] as string[];
  const cats = catIds.length
    ? await db.trackedCategory.findMany({ where: { id: { in: catIds } } })
    : [];
  const catById = new Map<string, any>(cats.map((c) => [c.id, c]));
  for (const p of products) {
    out.set(p.id, liveTrioFor(p, p.trackedCategoryId ? catById.get(p.trackedCategoryId) : null));
  }
  return out;
}

/**
 * The trio a new sale of `product` takes today, from its category row (null when the product has none, or the
 * category could not be read: uncategorised). Shared by the fold's loader and the buyer line-id edit.
 */
export function liveTrioFor(
  product: { trackedCategoryId?: string | null },
  category: { taxType?: unknown; rate?: unknown; priceIncludesTax?: unknown } | null | undefined,
): FoldTrio {
  return category && product.trackedCategoryId
    ? {
        trackedCategoryId: product.trackedCategoryId,
        categoryTaxType: category.taxType,
        categoryTaxRate: Number(category.rate),
        categoryPriceIncludesTax: !!category.priceIncludesTax,
      }
    : { trackedCategoryId: null };
}
