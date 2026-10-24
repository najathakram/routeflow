import {
  customerLinePrice,
  computeLineSubtotal,
  effectiveQty,
  roundMoney,
  type getTierPrice,
  type CustomerLayerUnit,
  type CustomerLinePrice,
} from "@routeflow/pricing";
import type { UnitOption as LadderOption } from "./unit-options";
import { effectiveUnitPrice, type LineState, type Product } from "./cart-line-state";

/** What the tier/layer price helpers read of a product: getTierPrice's own parameter (no casts at call sites). */
export type PriceProduct = Parameters<typeof getTierPrice>[0];

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
export function lineUnitFor(
  line: LineState | undefined,
  product: Product,
  tier: number,
  layer?: readonly CustomerLayerUnit[] | null,
): number {
  const lp = lineLayerPrice(line, product, tier, layer);
  // #2696(c): a special line bills an override only WITH its reason (the server refuses one without).
  return lp.isSpecial && !line?.overrideReason?.trim()
    ? lp.price
    : effectiveUnitPrice(line, lp.price);
}

/**
 * S19b slice D (SA-811a, SA-813): the line's base price through the ONE `customerLinePrice`. With no layer (flag off, or no
 * typed price for the product/unit) it is master's number exactly: a pack line prices at the tier, a unit line at its own
 * `unitBasePrice` (`unitPriceBase`). A layer row for the line's unit wins (billing's own resolved price).
 */
export function lineLayerPrice(
  line: { unitLabel?: string | null; unitBasePrice?: number } | undefined,
  product: PriceProduct,
  tier: number,
  layer?: readonly CustomerLayerUnit[] | null,
): CustomerLinePrice {
  const l = line ?? {};
  return customerLinePrice({
    product: product as unknown as Record<string, unknown>,
    tier,
    layer,
    unitLabel: l.unitLabel ?? null,
    ...(l.unitLabel && l.unitBasePrice != null ? { tierPrice: l.unitBasePrice } : {}),
  });
}

/**
 * SPECIAL-ness of a product's PACK by id alone (the editor's `isSpecialFor(productId)`): the layer's pack row when there is
 * one, else master's `isSpecialTier(tier)`. Needs no product because a missing row only reads the tier.
 */
export function packIsSpecial(tier: number, layer?: readonly CustomerLayerUnit[] | null): boolean {
  return customerLinePrice({ product: {}, tier, layer, unitLabel: null, tierPrice: 0 }).isSpecial;
}

/**
 * The layer price of a unit-sold line's unit, or undefined (a pack line, a unit with no layer row, flag off). The cart row
 * prefers it over the pack-level `catalogPrice` it would otherwise compare against.
 */
export function layerUnitBaseFor(
  line: { unitLabel?: string | null; unitBasePrice?: number },
  product: PriceProduct,
  tier: number,
  layer?: readonly CustomerLayerUnit[] | null,
): number | undefined {
  if (!line.unitLabel || !layer) return undefined;
  const lp = lineLayerPrice(line, product, tier, layer);
  return lp.layered ? lp.price : undefined;
}

/**
 * A unit-sold line whose unit has a row in the customer layer carries THAT price as its base (`unitBasePrice`), so every
 * downstream `unitPriceBase(line, ...)` reads billing's number. With no layer row (flag off, or no typed price) it returns the
 * SAME line object, so master's paths are untouched.
 */
export function withLayerBase<L extends { unitLabel?: string | null; unitBasePrice?: number }>(
  line: L,
  product: PriceProduct,
  tier: number,
  layer?: readonly CustomerLayerUnit[] | null,
): L {
  if (!line.unitLabel || !layer) return line;
  const lp = lineLayerPrice(line, product, tier, layer);
  return lp.layered ? { ...line, unitBasePrice: lp.price } : line;
}

/** The customer's price for a product's PACK (no line yet): the tier, or the layer's pack row. */
export function packLinePrice(
  product: PriceProduct,
  tier: number,
  layer?: readonly CustomerLayerUnit[] | null,
): CustomerLinePrice {
  return lineLayerPrice(undefined, product, tier, layer);
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
  layer?: readonly CustomerLayerUnit[] | null,
): number {
  return lineUnitFor(line, product, tier, layer);
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
  layerOf?: (productId: string) => readonly CustomerLayerUnit[] | null | undefined,
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
      unitPrice: lineUnitFor(line, p, tierForProduct(id), layerOf?.(id)),
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

/**
 * A unit picker option priced through the customer layer (S19b, SA-813 M2): the layer row for the option's unit replaces the
 * tier's `price`. The pack option, a DERIVED option (billed at the pack price), no layer, or a unit with no layer row come
 * back as the SAME object, so master's pick is untouched.
 */
export function optionWithLayerPrice(
  option: LadderOption,
  product: PriceProduct,
  tier: number,
  layer?: readonly CustomerLayerUnit[] | null,
): LadderOption {
  if (!layer || option.value === "" || option.derived) return option;
  const lp = customerLinePrice({
    product: product as unknown as Record<string, unknown>,
    tier,
    layer,
    unitLabel: option.value,
    tierPrice: option.price,
  });
  return lp.layered ? { ...option, price: lp.price } : option;
}

/**
 * SPECIAL-ness of THIS line's unit (a Can line answers with its own layer row, never the pack's): the unit's layer row when it
 * has one, else master's `isSpecialTier(tier)`.
 */
export function lineIsSpecial(
  line: { unitLabel?: string | null; unitBasePrice?: number } | undefined,
  product: PriceProduct,
  tier: number,
  layer?: readonly CustomerLayerUnit[] | null,
): boolean {
  return lineLayerPrice(line, product, tier, layer).isSpecial;
}
