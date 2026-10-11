import { copyCategoryTaxSnapshot, hasNullTrio } from "@routeflow/pricing";

/**
 * B297 row 340 (SA-734r2 r-note 2): a merge FOLD re-creates every line of the open order (`foldMergeItems`
 * -> `updateOrderItems({ replaceAll: true })`), and used to re-stamp each existing line's category, subcategory
 * and rate trio from the product's CURRENT category: a re-categorisation or a rate edit since the sale then
 * dropped or re-priced the sale-time excise. A folded line that comes from an existing line (its payload
 * item carries `sourceLineId`, resolved against the pre-edit lines) CARRIES that line's own category and trio,
 * exactly as `mergeAllPendingForCustomer` does; only a genuinely new line stamps live.
 *
 * What a line carries, by what it was sold under:
 *  - a full trio: its category, subcategory and trio, verbatim (never re-stamped);
 *  - NO category (sold uncategorised, L1): stays category-less and keeps its stored levy, which the
 *    recompute that follows keeps (a created row's levy would otherwise start at 0);
 *  - a category with a NULL / partly NULL trio: it keeps ITS category and subcategory (never the product's
 *    current one) and carries an empty trio, which the recompute that follows stamps from that category's live
 *    rate once, exactly as a NULL-trio line is handled everywhere else (SA-096a / SA-098b; row 338's rule).
 * Returns null only when there is no source line, or it is another product (a genuinely new line).
 */
export interface CarriedCategorySource {
  productId?: string | null;
  trackedCategoryId?: string | null;
  trackedSubcategoryId?: string | null;
  categoryTaxType?: unknown;
  categoryTaxRate?: unknown;
  categoryPriceIncludesTax?: boolean | null;
  categoryTaxAmount?: unknown;
}

export function carriedCategory(
  own: CarriedCategorySource | null | undefined,
  productId: string,
): Record<string, unknown> | null {
  if (!own || (own.productId ?? null) !== productId) return null; // a different product is a new sale
  if (!own.trackedCategoryId) {
    return {
      trackedCategoryId: null,
      trackedSubcategoryId: own.trackedSubcategoryId ?? null,
      categoryTaxType: null,
      categoryTaxRate: null,
      categoryPriceIncludesTax: null,
      categoryTaxAmount: Number(own.categoryTaxAmount ?? 0),
    };
  }
  if (hasNullTrio(own as any)) {
    return {
      trackedCategoryId: own.trackedCategoryId,
      trackedSubcategoryId: own.trackedSubcategoryId ?? null,
      categoryTaxType: null,
      categoryTaxRate: null,
      categoryPriceIncludesTax: null,
    };
  }
  return {
    trackedCategoryId: own.trackedCategoryId,
    trackedSubcategoryId: own.trackedSubcategoryId ?? null,
    ...copyCategoryTaxSnapshot(own as any),
  };
}
