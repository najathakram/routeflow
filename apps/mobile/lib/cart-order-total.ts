import {
  isSpecialTier,
  computeLineSubtotal,
  effectiveQty,
  getTierPrice,
  roundMoney,
} from "@routeflow/pricing";
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
  const isSpecial = isSpecialTier(tier);
  const tierPrice = getTierPrice(product, tier);
  const base = unitPriceBase(line ?? {}, tierPrice);
  // #2696(c): a special line bills an override only WITH its reason (the server refuses one without).
  return isSpecial && !line?.overrideReason?.trim() ? base : effectiveUnitPrice(line, base);
}

/**
 * SA-085i(b): the tray price-editor's pre-fill — the SAME price every other reader of this
 * line uses (`lineUnitFor`), never the pack's tier price for a unit-sold line. A thin, named
 * wrapper so the screen's call site and this function's own tests both read as "the pre-fill,"
 * not a second derivation.
 */
export function priceEditorPrefill(
  line: LineState | undefined,
  product: Product,
  tier: number,
): number {
  return lineUnitFor(line, product, tier);
}

/**
 * SA-085i(b): what the price editor's Save writes — an override ONLY when the typed price
 * actually diverges from the resolved base (the same comparison submit/park already make).
 * Saving a pre-fill UNTOUCHED must never store a redundant override (a unit line's pre-fill
 * equals its own base, never the pack's tier price — the bug the pre-fill fix itself closed).
 */
export function priceEditorSaveOverride(typed: number | null, base: number): number | null {
  return typed != null && typed === base ? null : typed;
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
