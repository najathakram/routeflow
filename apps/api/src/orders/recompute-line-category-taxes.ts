import { hasNullTrio, recomputeCategoryTax, roundMoney } from "@routeflow/pricing";
import { linePieceQty } from "./line-piece-qty";

/**
 * RF-4 / B297 PR3: recompute + persist each regulated order line's `categoryTaxAmount` and return the
 * order-level Σ (rounded). Non-regulated lines are 0.
 *
 * Each line is priced at its OWN rate snapshot (`categoryTaxType` / `categoryTaxRate` /
 * `categoryPriceIncludesTax`), never the live `TrackedCategory`: a rate edited after the sale must not
 * re-price a delivered order (SA-088 D2). The live category is fetched ONLY for a NULL (or partly NULL)
 * trio line, priced at once, and the full trio it was priced with is stamped onto the line with a warn
 * naming it (SA-096a / SA-098b). A line with no category keeps a non-zero stored amount, with a warn
 * (L1: money never changes silently). The rule lives in `recomputeCategoryTax` (`@routeflow/pricing`),
 * so every caller inherits it with no per-site check.
 *
 * The lines MUST be loaded with the trio columns (no `select` that drops them, L-169): an `undefined`
 * trio reads as NULL here and would re-stamp the line at today's rate. `b297-recompute-snapshot.db.spec.ts`
 * pins each caller against real Postgres.
 *
 * Category tax is a SECTION-level levy — the reporting subcategory never taxes. Runs inside the caller's
 * transaction (uses `tx.trackedCategory` / `tx.product` / `tx.orderItem`, the tx's own pooled connection).
 */
export async function recomputeLineCategoryTaxes(
  tx: any,
  lines: any[],
  logger?: { warn(message: string): void },
): Promise<number> {
  // A3: the live category is read only for the lines that must price at it (a NULL-trio regulated line).
  const catIds = [
    ...new Set(lines.filter((li) => hasNullTrio(trioOf(li))).map((li) => li.trackedCategoryId)),
  ] as string[];
  const cats = catIds.length
    ? await tx.trackedCategory.findMany({ where: { id: { in: catIds } } })
    : [];
  const catMap = new Map<string, any>(cats.map((c: any) => [c.id, c]));
  // Fetch each regulated line's product unitsPerBox so linePieceQty can expand a
  // selling-unit boxed line (which didn't snapshot unitsPerBox) to real pieces.
  const prodIds = [
    ...new Set(
      lines.filter((li) => li.trackedCategoryId && li.productId).map((li) => li.productId),
    ),
  ] as string[];
  const prods = prodIds.length
    ? await tx.product.findMany({
        where: { id: { in: prodIds } },
        select: { id: true, unitsPerBox: true },
      })
    : [];
  const upbMap = new Map<string, number>(prods.map((p: any) => [p.id, Number(p.unitsPerBox ?? 0)]));
  let sum = 0;
  for (const li of lines) {
    const result = recomputeCategoryTax(
      {
        ...trioOf(li),
        storedAmount: li.categoryTaxAmount,
        unitBasisQty: linePieceQty(li, upbMap.get(li.productId)),
        lineSubtotal: Number(li.subtotal),
      },
      li.trackedCategoryId ? catMap.get(li.trackedCategoryId) : null,
    );
    if (result.warn)
      logger?.warn(`recomputeLineCategoryTaxes: order line ${li.id}: ${result.warn}`);
    if (result.stamp) {
      // SA-098b: fill a NULL trio with the one just priced at (never overwrites a present one).
      await tx.orderItem.update({
        where: { id: li.id },
        data: {
          categoryTaxAmount: result.amount,
          categoryTaxType: result.stamp.categoryTaxType,
          categoryTaxRate: result.stamp.categoryTaxRate,
          categoryPriceIncludesTax: result.stamp.categoryPriceIncludesTax,
        },
      });
    } else if (roundMoney(Number(li.categoryTaxAmount ?? 0)) !== result.amount) {
      await tx.orderItem.update({
        where: { id: li.id },
        data: { categoryTaxAmount: result.amount },
      });
    }
    sum += result.amount;
  }
  return roundMoney(sum);
}

function trioOf(li: any) {
  return {
    trackedCategoryId: li.trackedCategoryId,
    categoryTaxType: li.categoryTaxType,
    categoryTaxRate: li.categoryTaxRate,
    categoryPriceIncludesTax: li.categoryPriceIncludesTax,
  };
}
