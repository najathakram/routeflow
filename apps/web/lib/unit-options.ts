import {
  buildLadderOptions,
  defaultLadderOptionValue,
  ladderOptionLineTotal,
  ladderOptionPriceText,
  type LadderOption,
  type LadderProduct,
  type LadderUnit,
} from "@routeflow/pricing";
import type { ProductUnitLevel } from "@routeflow/types";
import { formatMoney, formatQty } from "@/lib/format";

/**
 * One sellable level of a product's ladder, as the unit picker offers it (units_v1, step 5a).
 * Everything here is DISPLAY: the server re-resolves the factor and price from the ladder by label
 * on every write, so a stale option can never change what is stored.
 */
export type UnitOption = LadderOption;

/** The API returns Decimal strings; the pricing ladder takes them as-is. */
const toLadderUnit = (u: ProductUnitLevel): LadderUnit => ({
  label: u.label,
  factorToBase: u.factorToBase,
  isDefaultSelling: u.isDefaultSelling,
  price: u.price,
  priceTier2: u.priceTier2,
  priceTier3: u.priceTier3,
  priceTier4: u.priceTier4,
  priceTier5: u.priceTier5,
});

/**
 * The ladder a picker offers: the pack first (its `value` is `""`), then each level largest → smallest,
 * then the implicit Piece when nothing else already sells single pieces. A row named like the pack is
 * shadowed by the pack, exactly as `resolveLadderLevel` does server-side; a factor-1 row named "Piece"
 * is not an extra option — it supplies the Piece's explicit price (priced through the same ladder).
 * A product with no levels yields ONE option (the pack) — callers render no picker at all then.
 */
export function buildUnitOptions(
  product: LadderProduct,
  units: readonly ProductUnitLevel[],
  tier: number | string = 1,
  /**
   * The price the parent already shows for the PACK. A pack line goes through the order pricing
   * pipeline (remembered above-list price, promotions), which the ladder alone cannot know; a
   * level's price is exactly the ladder's (promos/upsell are pack-only). Omitted = the tier price.
   */
  packPrice?: number,
): UnitOption[] {
  // The ONE builder lives in @routeflow/pricing (SA-728) — web and mobile share it, so they cannot disagree.
  return buildLadderOptions(product, units.map(toLadderUnit), tier, packPrice);
}

/**
 * The unit a new line starts on: the level flagged `isDefaultSelling` — only if the picker actually
 * offers it (a shadowed/corrupt row would otherwise hold the line on a label nobody can see) — else
 * the pack (`""`).
 */
export function defaultUnitValue(
  product: LadderProduct,
  units: readonly ProductUnitLevel[],
  tier: number | string = 1,
): string {
  // #2784: the ONE resolver (@routeflow/pricing) — the server's buyer-qty default reads the same function.
  return defaultLadderOptionValue(product, units.map(toLadderUnit), tier);
}

/** The dropdown text: "Case · 288 pcs · $480.00"; a derived Piece reads "Piece · ≈$3.33 (1/3 of $10.00)" when not exact. */
export function unitOptionText(o: UnitOption): string {
  const pcs = o.factorToBase === 1 ? "" : ` · ${formatQty(o.factorToBase)} pcs`;
  return `${o.label}${pcs} · ${ladderOptionPriceText(o, formatMoney)}`;
}

/** Line total for `count` of a unit — a derived Piece prorates off the pack, the rest bill count x price like the server. */
export function unitLineSubtotal(option: UnitOption, count: number, unitPrice?: number): number {
  return ladderOptionLineTotal(option, count, unitPrice);
}
