import { isSpecialPrice } from "./customer-unit-price";
import { isSpecialTier } from "./pricing";
import { getTierPrice } from "./tier-pricing";
import { namesBase, namesPack, packFactorOf, type LadderProduct } from "./unit-levels";

// S19b A0 (SA-811a, SA-813): the ONE pure function every client and server reader calls to price a line for a customer.
// The server's price-layer endpoint returns billing's own resolved rows (`customerPricing().layer`); this picks the row for a
// line and applies the SAME classification billing does. With no row it returns master's numbers exactly, so a flag-off
// site (no layer) is unchanged. Clients evaluate no ladder.

/** One unit of a product in the customer layer, exactly as the price-layer endpoint serves it (packages/types structural twin). */
export interface CustomerLayerUnit {
  /** A unit ref: "pack" | "base" | a ProductUnit id. */
  ref: string;
  /** The unit's label; null = the pack. */
  label: string | null;
  /** Dollars, rounded once. */
  price: number;
  /** The unit's Retail ladder price (the strikethrough / `originalPrice` base). */
  listPrice: number;
  source: "customer" | "customer-shape";
  /** SA-811a R2: above the unit's Retail ladder price, so MANUAL and never promoted. */
  aboveList: boolean;
}

export interface CustomerLinePrice {
  /** What the line pre-fills / shows / is judged against. */
  price: number;
  /** `originalPrice` / the strikethrough base. */
  listPrice: number;
  /** Feeds `decideStaffOverride.isSpecialTier`. */
  isSpecial: boolean;
  priceType: "STANDARD" | "SPECIAL" | "MANUAL";
  /** True = came from the customer layer (skip the last-given pre-fill, SA-811a R3). */
  layered: boolean;
}

const norm = (s: string) => s.trim().toLowerCase();

/**
 * The layer row a unit label names, through the core's own label-to-level rules (SA-813 M2), never a raw string compare:
 * blank or a name of the pack = the pack row (label null); the base label or "Piece" = the "base" row (or the pack row of a
 * one-piece pack); otherwise the named unit, exact first and then case-insensitively (`resolveLadderLevel`'s order). An
 * unknown or renamed label has no row, as the server's `layer()` returns null for it.
 */
export function layerRowForLabel(
  product: LadderProduct,
  layer: readonly CustomerLayerUnit[],
  unitLabel?: string | null,
): CustomerLayerUnit | undefined {
  const label = (unitLabel ?? "").trim();
  const packRow = layer.find((r) => r.label == null);
  if (!label) return packRow;
  if (namesBase(product, label)) {
    return (
      layer.find((r) => r.ref === "base") ?? (packFactorOf(product) === 1 ? packRow : undefined)
    );
  }
  if (namesPack(product, label)) return packRow;
  const named = layer.filter((r) => r.label != null && r.ref !== "base");
  return (
    named.find((r) => r.label === label) ??
    named.find((r) => norm(r.label as string) === norm(label))
  );
}

export function customerLinePrice(i: {
  /** The product's tier columns (`pricePerUnit`, `priceTier2..5`) and labels, as today. */
  product: Record<string, unknown>;
  /** `customerTierFor(cpTier, customerTier)` flag-on; master's chain flag-off. */
  tier: number;
  /** `response.products[productId]`; undefined flag-off or with no layer. */
  layer?: readonly CustomerLayerUnit[] | null;
  /** null/undefined = the pack. */
  unitLabel?: string | null;
  /** Unit lines: the caller's unit-levels price (master); the pack omits it. */
  tierPrice?: number;
}): CustomerLinePrice {
  const row = i.layer
    ? layerRowForLabel(i.product as unknown as LadderProduct, i.layer, i.unitLabel)
    : undefined;
  if (row) {
    const isSpecial = isSpecialPrice(i.tier, row.listPrice, row.price);
    return {
      price: row.price,
      listPrice: row.listPrice,
      isSpecial,
      priceType: row.aboveList ? "MANUAL" : isSpecial ? "SPECIAL" : "STANDARD",
      layered: true,
    };
  }
  const isSpecial = isSpecialTier(i.tier);
  return {
    price: i.tierPrice ?? getTierPrice(i.product, i.tier),
    listPrice: Number(i.product.pricePerUnit),
    isSpecial,
    priceType: isSpecial ? "SPECIAL" : "STANDARD",
    layered: false,
  };
}

/**
 * SA-813 M1/M3: what a client may do with the price-layer read. While the layer is pending or failed (flag on) a line's price is
 * UNCONFIRMED: show "Checking this customer's prices…" (failed: "Couldn't load this customer's prices. Retry"), never a final
 * tier price, and keep Create/Save/Send disabled until `ready`. A product absent from an INCOMPLETE response is not ready
 * either (`lineReady`). Flag off: nothing to wait for, `ready` is true and no request was made.
 */
export interface PriceLayerStatus {
  /** The flag is on and a customer is chosen: the layer is being read. */
  enabled: boolean;
  /** Prices may be confirmed (flag off, or the layer read succeeded). */
  ready: boolean;
  pending: boolean;
  failed: boolean;
  /** The response was complete (false = past the row cap; see `lineReady`). */
  complete: boolean;
  /** Is THIS product's price confirmed? An absent product in an incomplete response is not. */
  lineReady(productId: string | null | undefined): boolean;
}

export function priceLayerStatus(i: {
  enabled: boolean;
  isPending: boolean;
  isError: boolean;
  data?: { complete: boolean; products: Record<string, readonly CustomerLayerUnit[]> } | null;
}): PriceLayerStatus {
  if (!i.enabled) {
    return {
      enabled: false,
      ready: true,
      pending: false,
      failed: false,
      complete: true,
      lineReady: () => true,
    };
  }
  const failed = i.isError;
  const ready = !failed && !!i.data && !i.isPending;
  const complete = !!i.data && i.data.complete;
  return {
    enabled: true,
    ready,
    pending: !failed && !i.data,
    failed,
    complete,
    lineReady: (productId) =>
      ready &&
      (complete ||
        (!!productId && Object.prototype.hasOwnProperty.call(i.data!.products, productId))),
  };
}
