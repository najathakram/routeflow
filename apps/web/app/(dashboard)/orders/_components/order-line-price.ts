import { customerLinePrice, isStickyUpsell, type CustomerLayerUnit } from "@routeflow/pricing";

/**
 * W-1170 F8: the ONE add-time price decision of the new-order modal. `addLineItem` builds a line from it and the product
 * picker prints its `unitPrice`, so a row never claims a price the added line will not carry. Pure: no money math of its own
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
