import { computeLineSubtotal, effectiveQty, getTierPrice, roundMoney } from "@routeflow/pricing";
import { unitPriceBase } from "./unit-options";
import { effectiveUnitPrice, type LineState, type Product } from "./cart-line-state";

/**
 * Pure, parameterized version of NewOrderScreen.tsx's `lineUnitFor` — lifted out so the
 * order-total fix (SA-085: a unit-sold line's footer showed $24.00 beside a $220.00 line,
 * because this derivation fell back to the pack's tier price whenever `unitPrice` was unset,
 * with no `unitLabel` awareness) has an executable pin instead of only a screenshot.
 *
 * What this line actually charges: overrides count only on non-SPECIAL (tier === 1) lines
 * (web parity). Routes the fallback through `unitPriceBase` so a unit-sold line (qty in that
 * unit, no explicit override) prices off its OWN resolved level, never the pack's tier price.
 */
export function lineUnitFor(line: LineState | undefined, product: Product, tier: number): number {
  const isSpecial = tier !== 1;
  const tierPrice = getTierPrice(product, tier);
  const base = unitPriceBase(line ?? {}, tierPrice);
  return isSpecial ? base : effectiveUnitPrice(line, base);
}

export interface UnlistedTotalLine {
  qty: number;
  unitPrice: number;
}

/**
 * Pure version of NewOrderScreen.tsx's `total`/`totalItems` useMemo. Same inputs, same
 * iteration order, same rounding — the component's memo should read as a thin wrapper over
 * this, not a second implementation of it.
 */
export function computeOrderTotal(
  items: Record<string, LineState>,
  productById: Map<string, Product>,
  unlisted: UnlistedTotalLine[],
  tierForProduct: (productId: string) => number,
): { total: number; totalItems: number } {
  let total = 0;
  let totalItems = 0;
  for (const [id, line] of Object.entries(items)) {
    const p = productById.get(id);
    if (!p) continue;
    const qty = effectiveQty(line, p.unitsPerBox);
    if (qty <= 0) continue;
    totalItems += qty;
    total += computeLineSubtotal({
      unitPrice: lineUnitFor(line, p, tierForProduct(id)),
      qty,
      boxes: line.boxes ?? null,
      pieces: line.pieces ?? null,
      unitsPerBox: p.unitsPerBox ?? null,
    });
  }
  for (const u of unlisted) {
    if (u.qty <= 0) continue;
    totalItems += u.qty;
    total += computeLineSubtotal({ unitPrice: u.unitPrice, qty: u.qty });
  }
  return { total: roundMoney(total), totalItems };
}
