import {
  buildLadderOptions,
  customerLinePrice,
  type CustomerLayerUnit,
  type CustomerLinePrice,
  defaultLadderOptionValue,
  derivedPiece,
  ladderOptionLineTotal,
  ladderOptionPriceText,
  type LadderOption,
  type LadderProduct,
  type LadderUnit,
  roundMoney,
} from "@routeflow/pricing";
import type { ProductUnitLevel } from "@routeflow/types";
import { formatMoney, formatQty } from "@/lib/format";

/**
 * One sellable level of a product's ladder, as the unit picker offers it (units_v1, step 5a).
 * Everything here is DISPLAY: the server re-resolves the factor and price from the ladder by label
 * on every write, so a stale option can never change what is stored.
 */
export type UnitOption = LadderOption & {
  /**
   * S19b (SA-811a): set by `withLayerPrices` when the customer's price layer has a row for this option (flag on). `price` and
   * `listPrice` are then the layer's, and `applyLineUnit` takes the line's priceType / special baseline from this.
   */
  layerLine?: CustomerLinePrice;
};

/**
 * An EXISTING line's own pack basis (row 630): the price its pack was sold at and the pack size it was sold at, as stored.
 * The derived Piece of such a line is that price over that size, whatever the customer's layer or the product's pack size
 * is now, because the server re-splits the line at its own size and price.
 */
export interface OwnPackBasis {
  unitPrice: number;
  unitsPerBox: number;
}

/**
 * Put the customer's layer prices on the picker's options (S19b): each option with a layer row (the pack included) takes
 * `customerLinePrice`'s price and list and records it as `layerLine`. No layer (flag off) or no row for an option = the
 * option unchanged, so master's ladder price stands. A derived Piece bills as the pack's proration, so it takes the layer's PACK
 * price over the pack size, except on an existing line (`ownPack`, row 630): that line keeps the price and size it was sold at,
 * whether or not the customer has a layer or a pack row in it (the server re-splits the line at its own size and price).
 */
export function withLayerPrices(
  options: readonly UnitOption[],
  product: LadderProduct,
  tier: number | string,
  layer?: readonly CustomerLayerUnit[] | null,
  ownPack?: OwnPackBasis | null,
): UnitOption[] {
  // Row 630: an existing line's derived Piece is its OWN price over its OWN size, before any layer lookup. It is not a layer
  // line, so no `layerLine` (its price and baseline stay the line's).
  const own = ownPack && ownPack.unitsPerBox > 1 ? ownPack : null;
  const ownPiece = (o: UnitOption): UnitOption =>
    own && o.derived ? { ...o, ...derivedPiece(roundMoney(own.unitPrice), own.unitsPerBox) } : o;
  if (!layer || layer.length === 0) return own ? options.map(ownPiece) : (options as UnitOption[]);
  const t = Number(tier);
  return options.map((o) => {
    if (o.derived) {
      if (own) return ownPiece(o);
      // The Piece bills as the pack's proration: the layer's PACK price is what it divides.
      const pack = customerLinePrice({
        product: product as unknown as Record<string, unknown>,
        tier: t,
        layer,
        unitLabel: null,
        tierPrice: o.derived.packPrice,
      });
      return pack.layered ? { ...o, ...derivedPiece(pack.price, o.derived.n), layerLine: pack } : o;
    }
    const lp = customerLinePrice({
      product: product as unknown as Record<string, unknown>,
      tier: t,
      layer,
      unitLabel: o.kind === "pack" ? null : o.value,
      tierPrice: o.price,
    });
    return lp.layered
      ? { ...o, price: lp.price, listPrice: lp.listPrice ?? o.listPrice, layerLine: lp }
      : o;
  });
}

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
