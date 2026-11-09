import {
  customerLinePrice,
  isStickyUpsell,
  unitWords,
  type CustomerLayerUnit,
} from "@routeflow/pricing";

/**
 * W-1170 F8: the ONE add-time price decision of the new-order modal. `addLineItem` builds a line from it and the product
 * picker prints its `unitPrice`, so a row shows the price the line is added at. That is the price of the product's PACK (or
 * its single unit): a product whose default selling unit is another one (a Piece) starts its line on that unit and re-prices
 * it through the unit picker, which the row cannot know. So a boxed row names the pack word it prices
 * (`pickerPriceUnit`, "/ case") and never implies the line carries that number per piece. Pure: no money math of its own
 * (every number comes from `customerLinePrice` / the customer's remembered price), nothing read from a render.
 */

/** The customer's last-given price for one product (`useCustomerPriceHistory`). */
export interface AddTimeHistory {
  lastPrice: number;
  stickyPrice?: number | null;
}

export interface LinePriceAtAdd {
  /** The product's catalog list price. */
  listPrice: number;
  /** The list price the line strikes through: the layer row's own list when the customer layer priced it. */
  lineListPrice: number;
  /** The result of the shared customer price chain (tier, layer, remembered upsell). */
  linePrice: ReturnType<typeof customerLinePrice>;
  /** The tier / layer price before any last-given pre-fill. */
  tierPrice: number;
  /** A last-given price below the tier price, pre-filled as a one-time discount. */
  hasHistDiscount: boolean;
  /** A remembered upsell (a saved price above list), pre-filled as a manual override. */
  hasHistUpsell: boolean;
  hasHistOverride: boolean;
  /** SA-1068 M20: the remembered price the server books for a plain line (no pre-fill, nothing sent). */
  memory: number | undefined;
  /** What the line starts at and what the picker shows. */
  unitPrice: number;
  priceType: "STANDARD" | "SPECIAL" | "MANUAL" | "DISCOUNTED";
}

export function linePriceAtAdd(i: {
  /** The product's tier columns (`pricePerUnit`, `priceTier2..5`). */
  product: Record<string, unknown>;
  /** The customer's effective tier for this product (per-product override, else the customer's). */
  tier: number;
  /** The customer's layer rows for this product; undefined with the layer off or no row. */
  layer?: readonly CustomerLayerUnit[] | null;
  /** The customer's last-given price for this product, once the history has loaded. */
  histEntry?: AddTimeHistory | null;
}): LinePriceAtAdd {
  const listPrice = Number(i.product.pricePerUnit ?? 0);
  // S19b: the customer's layer price (flag on) or master's tier price (no layer): getTierPrice lives inside the helper.
  const linePrice = customerLinePrice({ product: i.product, tier: i.tier, layer: i.layer });
  const tierPrice = linePrice.price;
  const histEntry = i.histEntry;
  // Pre-fill from the customer's last-given price for this product (only when below the effective tier price, and only
  // when this isn't already a SPECIAL price: SPECIAL prices are permanent, the discount is already in tierPrice).
  // R3 (SA-811a): a price from the customer's layer is that same permanent price, so last-given is skipped for it too.
  const permanentPrice = linePrice.priceType === "SPECIAL" || linePrice.layered;
  const hasHistDiscount = !permanentPrice && histEntry != null && histEntry.lastPrice < tierPrice;
  // Carry forward a remembered UPSELL too (a saved price ABOVE list): a MANUAL override.
  const hasHistUpsell = !permanentPrice && isStickyUpsell(histEntry?.stickyPrice, listPrice);
  const hasHistOverride = hasHistDiscount || hasHistUpsell;
  // SA-1068 M20: no pre-fill, but the server books the memory: the line starts there, sends nothing and keeps its tier.
  const remembered = customerLinePrice({
    product: i.product,
    tier: i.tier,
    layer: i.layer,
    remembered: histEntry?.stickyPrice,
  });
  const memory = hasHistOverride || !remembered.remembered ? undefined : remembered.price;
  return {
    listPrice,
    lineListPrice: linePrice.layered ? (linePrice.listPrice ?? listPrice) : listPrice,
    linePrice,
    tierPrice,
    hasHistDiscount,
    hasHistUpsell,
    hasHistOverride,
    memory,
    unitPrice: hasHistOverride ? histEntry!.lastPrice : (memory ?? tierPrice),
    priceType:
      hasHistUpsell || memory != null
        ? "MANUAL"
        : hasHistDiscount
          ? "DISCOUNTED"
          : linePrice.priceType,
  };
}

/**
 * W-1170 P11: the unit words the BUSINESS chose for a product (its `packLabel` and `baseUnitLabel`), carried onto a new
 * line exactly as the counter sale does, so the row's price ("/ case"), quantity ("1 case = 12 pcs") and stock note
 * ("3 cases left") read one word. Without a label the line keeps the default Box / Piece words. Words only.
 */
export function linePackWords(product: Record<string, unknown>): {
  packLabel?: string;
  baseLabel?: string;
} {
  const words: { packLabel?: string; baseLabel?: string } = {};
  const pack = String(product.packLabel ?? "").trim();
  if (pack) words.packLabel = pack;
  const base = String(product.baseUnitLabel ?? "").trim();
  if (base) words.baseLabel = base;
  return words;
}

/**
 * The unit word a picker row's price is for: the pack word (the business's own, else "box") on a boxed product, whose
 * price is per pack. A product sold by one unit returns null: its unit already sits beside its name.
 */
export function pickerPriceUnit(product: Record<string, unknown>): string | null {
  if (!(Number(product.unitsPerBox ?? 0) > 1)) return null;
  return unitWords({ packLabel: String(product.packLabel ?? "") }).pack.lower;
}
