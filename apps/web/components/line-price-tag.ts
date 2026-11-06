import { isAboveListLine } from "@routeflow/pricing";

/**
 * How a read-only order line explains its unit price (Special / Upsell / Discounted / Promo /
 * Adjusted). Mirrors the price-type branches of the order-detail line TABLE
 * (`orders/[id]/_components/OrderLineItemsTable.tsx`) so the card list loses no information the
 * table shows; a parity test pins the two against the same fixtures.
 *
 * Pure display logic — never used to derive or store a price.
 */
export interface LinePriceTag {
  label: "Special" | "Upsell" | "Promo" | "Adjusted" | "Discounted";
  /** Colour of the shown price + pill: green = at/above list for the customer, amber = below list. */
  tone: "emerald" | "amber";
  /** Show the original (list) price struck through. A line charged ABOVE its list (an upsell, or a tier above
   *  Retail: pricing's `isAboveListLine`) never strikes the lower base — a strike reads as "this was the price". */
  strikeOriginal: boolean;
}

export function linePriceTag(input: {
  priceType?: string | null;
  originalPrice?: number | string | null;
  unitPrice: number | string;
}): LinePriceTag | null {
  const { priceType } = input;
  const hasOriginal = input.originalPrice != null;
  const original = Number(input.originalPrice);
  const unit = Number(input.unitPrice);

  if (priceType === "SPECIAL") {
    return {
      label: "Special",
      tone: "emerald",
      strikeOriginal: hasOriginal && !isAboveListLine(input),
    };
  }
  if (priceType === "MANUAL" && hasOriginal && unit > original) {
    return { label: "Upsell", tone: "emerald", strikeOriginal: false };
  }
  if (
    (priceType === "DISCOUNTED" || priceType === "MANUAL" || priceType === "PROMO") &&
    hasOriginal
  ) {
    const label =
      priceType === "MANUAL" ? "Adjusted" : priceType === "PROMO" ? "Promo" : "Discounted";
    return { label, tone: "amber", strikeOriginal: true };
  }
  return null;
}
