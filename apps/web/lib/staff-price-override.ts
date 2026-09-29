import { decideStaffOverride } from "@routeflow/pricing";

/** The order-builder line fields the one staff-override rule reads. */
export interface OverridableLine {
  productName: string;
  listPrice: number;
  /** The customer's tier (special) price — set only on a special-tier line. */
  specialPrice?: number;
  discountedPrice?: number;
  overrideReason?: string;
  isUnlisted?: boolean;
}

/** The server's refusal text, word for word (orders/staff-override.ts). */
export const reasonRequiredMessage = (productName: string) =>
  `A reason is required to change ${productName || "this"} — it's this customer's special price`;

const decide = (li: OverridableLine, price: number, hasReason: boolean) =>
  decideStaffOverride({
    overridePrice: price,
    // A new line's baseline is the customer's tier price: the special price, else list (tier 1).
    baselinePrice: li.specialPrice ?? li.listPrice,
    listPrice: li.listPrice,
    isSpecialTier: li.specialPrice != null,
    hasReason,
  });

/**
 * #2696(c) — what a typed price does to a new order line, by @routeflow/pricing's
 * decideStaffOverride (the server's own rule A): within ½¢ of the tier price it is no override (the
 * line keeps its special / list price); otherwise DISCOUNTED below list, MANUAL at or above.
 */
export function applyTypedPrice<T extends OverridableLine>(
  li: T,
  typed: number,
): T & { unitPrice: number; priceType: "STANDARD" | "SPECIAL" | "DISCOUNTED" | "MANUAL" } {
  const d = decide(li, Math.max(0, typed), true);
  if ("refused" in d) throw new Error("unreachable: a reason is assumed when classifying");
  const overridden = d.priceType === "DISCOUNTED" || d.priceType === "MANUAL";
  return {
    ...li,
    discountedPrice: overridden ? Math.max(0, typed) : undefined,
    unitPrice: d.unitPrice,
    priceType: d.priceType,
  };
}

/** True when saving this line would be refused by the server: an override with no reason. */
export function lineNeedsReason(li: OverridableLine): boolean {
  if (li.isUnlisted || li.discountedPrice == null) return false;
  return "refused" in decide(li, li.discountedPrice, !!li.overrideReason?.trim());
}
