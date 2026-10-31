import type { CategoryTaxType, SaleTotalsLine } from "@routeflow/pricing";

/** One sale line as either screen holds it (the order builder's cart and the till's cart share this shape). */
export interface CartLine {
  unitPrice: number;
  qty: number;
  boxes?: number | null;
  pieces?: number | null;
  unitsPerBox?: number | null;
  /** The product's regulated category (levy), snapshotted when the line was added. */
  trackedCategoryId?: string | null;
}

/** A regulated category as the tracked-categories list serialises it (`rate` is a Decimal string). */
export interface CartCategory {
  id?: string;
  /** the category's name: the levy prints as its own named charge ("CRV deposit") */
  name?: string;
  taxType: string;
  rate: string | number;
  priceIncludesTax?: boolean | null;
}

/**
 * W-858: the ONE mapping from a cart line to `saleTotals`' line (@routeflow/pricing). The till and the order builder
 * both total through it, so the levy name, the Decimal-string rate and the `priceIncludesTax` default cannot drift
 * between screens; `sale-lines.pin.test.ts` fails any `saleTotals(` call that is not fed by it. A line whose category
 * is absent from `categories` is not levied.
 */
export function saleLinesOf(
  lines: readonly CartLine[],
  categories?: ReadonlyMap<string, CartCategory>,
): SaleTotalsLine[] {
  return lines.map((l) => {
    const c = l.trackedCategoryId ? categories?.get(l.trackedCategoryId) : undefined;
    return {
      unitPrice: l.unitPrice,
      qty: l.qty,
      boxes: l.boxes ?? undefined,
      pieces: l.pieces ?? undefined,
      unitsPerBox: l.unitsPerBox ?? undefined,
      category: c
        ? {
            id: c.id ?? l.trackedCategoryId,
            name: c.name,
            taxType: c.taxType as CategoryTaxType,
            rate: Number(c.rate),
            priceIncludesTax: c.priceIncludesTax ?? false,
          }
        : null,
    };
  });
}
