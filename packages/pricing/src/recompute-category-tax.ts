import {
  categoryTaxSnapshotOf,
  computeCategoryTax,
  roundMoney,
  type CategoryTaxSnapshot,
  type CategoryTaxType,
  type TrackedCategoryRow,
} from "./pricing";

/**
 * B297 PR3 (SA-734r2 B3 / R4 / L1, SA-096a / SA-098b): THE one way a stored regulated line's category
 * tax is recomputed after an edit. It reads the LINE'S OWN rate snapshot (`categoryTaxType` /
 * `categoryTaxRate` / `categoryPriceIncludesTax`, stamped at sale time), never the live
 * `TrackedCategory`: a category rate edited after the sale must not re-price a delivered order.
 *
 * Four outcomes, decided here so the four order callers and the two invoice callers inherit one rule:
 *  - `snapshot`          the line has all three snapshot columns: priced at THEM. The live category is not read.
 *  - `stamped`           the line has a NULL or partly NULL trio (R4: one NULL makes it NULL): priced at the live
 *                        category ONCE and the full trio it was priced with is returned in `stamp` for the caller
 *                        to write (SA-098b), with a warn. A present trio is never overwritten.
 *  - `kept-no-category`  the line has no category but a non-zero stored amount (the B767 shape): the stored amount
 *                        is KEPT, with a warn (L1). Money never changes silently.
 *  - `kept-unpriceable`  a NULL-trio line whose live category cannot be resolved: the stored amount is KEPT, with a
 *                        warn, and nothing is stamped.
 *  - `none`              no category and a zero amount: 0.
 *
 * Pure. The caller fetches the live category ONLY for a NULL-trio line (`needsLiveCategory`), and logs
 * `warn` naming the line (this function cannot: it holds no id).
 */
export interface RecomputeCategoryTaxLine {
  trackedCategoryId?: string | null;
  /** The line's stored trio; `undefined` (a column the caller never loaded) is treated as NULL. */
  categoryTaxType?: CategoryTaxType | null;
  categoryTaxRate?: number | string | { toNumber(): number } | null;
  categoryPriceIncludesTax?: boolean | null;
  /** The stored `categoryTaxAmount` (a Decimal, string or number from the database). */
  storedAmount?: number | string | { toNumber(): number } | null;
  /** The line's quantity in the category's unit basis (`regulatedUnitBasis`), for the per-unit types. */
  unitBasisQty: number;
  /** The line's net sale, for PERCENT_OF_SALE. */
  lineSubtotal: number;
}

export type RecomputeCategoryTaxReason =
  "snapshot" | "stamped" | "kept-no-category" | "kept-unpriceable" | "none";

export interface RecomputeCategoryTaxResult {
  /** The line's category tax, rounded to cents. */
  amount: number;
  reason: RecomputeCategoryTaxReason;
  /** The trio to WRITE onto the line (`stamped` only); null = leave the line's trio untouched. */
  stamp: CategoryTaxSnapshot | null;
  /** Why money was kept or a snapshot was stamped, without the line id; null when nothing is noteworthy. */
  warn: string | null;
}

const num = (v: unknown): number => {
  if (v == null) return 0;
  if (typeof v === "object" && typeof (v as { toNumber?: unknown }).toNumber === "function")
    return (v as { toNumber(): number }).toNumber();
  return Number(v) || 0;
};

/** True when the line has a regulated category but not all three snapshot columns (R4: one NULL = NULL). */
export function hasNullTrio(
  line: Pick<
    RecomputeCategoryTaxLine,
    "trackedCategoryId" | "categoryTaxType" | "categoryTaxRate" | "categoryPriceIncludesTax"
  >,
): boolean {
  return (
    !!line.trackedCategoryId &&
    (line.categoryTaxType == null ||
      line.categoryTaxRate == null ||
      line.categoryPriceIncludesTax == null)
  );
}

/** True when the caller must load the live category for this line: only a NULL-trio regulated line prices at it (A3). */
export const needsLiveCategory = hasNullTrio;

export function recomputeCategoryTax(
  line: RecomputeCategoryTaxLine,
  liveCategory?: TrackedCategoryRow | null,
): RecomputeCategoryTaxResult {
  const stored = roundMoney(num(line.storedAmount));

  if (!line.trackedCategoryId) {
    if (stored !== 0) {
      return {
        amount: stored,
        reason: "kept-no-category",
        stamp: null,
        warn: `no category, so the stored category tax ${stored.toFixed(2)} is kept, not recomputed`,
      };
    }
    return { amount: 0, reason: "none", stamp: null, warn: null };
  }

  if (!hasNullTrio(line)) {
    return {
      amount: computeCategoryTax({
        taxType: line.categoryTaxType as CategoryTaxType,
        rate: num(line.categoryTaxRate),
        unitBasisQty: line.unitBasisQty,
        lineSubtotal: line.lineSubtotal,
        priceIncludesTax: !!line.categoryPriceIncludesTax,
      }),
      reason: "snapshot",
      stamp: null,
      warn: null,
    };
  }

  if (!liveCategory) {
    return {
      amount: stored,
      reason: "kept-unpriceable",
      stamp: null,
      warn: `no rate snapshot and the category cannot be read, so the stored category tax ${stored.toFixed(2)} is kept`,
    };
  }

  return {
    amount: computeCategoryTax({
      taxType: liveCategory.taxType,
      rate: num(liveCategory.rate),
      unitBasisQty: line.unitBasisQty,
      lineSubtotal: line.lineSubtotal,
      priceIncludesTax: !!liveCategory.priceIncludesTax,
    }),
    reason: "stamped",
    stamp: categoryTaxSnapshotOf(liveCategory),
    warn: "no rate snapshot: priced at the live category rate once and the snapshot stamped",
  };
}
