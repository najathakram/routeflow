import { decideStaffOverride } from "@routeflow/pricing";

/** The server's refusal text, word for word (apps/api/src/orders/staff-override.ts). */
export const reasonRequiredMessage = (productName: string) =>
  `A reason is required to change ${productName || "this"} — it's this customer's special price`;

export type TrayPriceDecision =
  { kind: "clear" } | { kind: "refused" } | { kind: "set"; price: number; overrideReason?: string };

/**
 * #2696(c) (SA-558 / 558a) — what the create screen's price editor saves, by @routeflow/pricing's
 * decideStaffOverride (the server's rule A; web's lib/staff-price-override.ts calls the same
 * function). `base` is the line's own resolved price before any override (the customer's tier
 * price, or a unit's price): within ½¢ of it there is nothing to override ⇒ "clear"; a real change
 * on a special line with no reason ⇒ "refused" (the modal keeps Save disabled); otherwise "set" at
 * the rounded price, with the trimmed reason when there is one.
 */
export function decideTrayPrice(input: {
  typed: number | null;
  base: number;
  listPrice: number;
  isSpecial: boolean;
  reason: string | null | undefined;
}): TrayPriceDecision {
  const { typed, base, listPrice, isSpecial } = input;
  if (typed == null || typed < 0) return { kind: "clear" };
  const reason = input.reason?.trim() ?? "";
  const d = decideStaffOverride({
    overridePrice: typed,
    baselinePrice: base,
    listPrice,
    isSpecialTier: isSpecial,
    hasReason: reason !== "",
  });
  if ("refused" in d) return { kind: "refused" };
  if (d.priceType === "SPECIAL" || d.priceType === "STANDARD") return { kind: "clear" };
  return { kind: "set", price: d.unitPrice, ...(reason ? { overrideReason: reason } : {}) };
}

/**
 * #2696(c) SA-558e — a New-sale line's price fields for POST /orders/sell (the server's create(),
 * rule A). The screen always sends the EFFECTIVE price it shows (unchanged); off a special price
 * it also sends the trimmed reason, and with no reason it is refused (the screen blocks the sale).
 */
export function saleLinePriceFields(input: {
  effective: number;
  base: number;
  listPrice: number;
  isSpecial: boolean;
  reason?: string;
}): { refused: true } | { unitPrice: number; overrideReason?: string } {
  const d = decideTrayPrice({ ...input, typed: input.effective, reason: input.reason });
  if (d.kind === "refused") return { refused: true };
  return {
    unitPrice: input.effective,
    ...(d.kind === "set" && d.overrideReason ? { overrideReason: d.overrideReason } : {}),
  };
}
