import type { SubscriptionView } from "@routeflow/types";

/** A plan / add-on price as the Billing page prints it ("$499", "$4,990", "$12.50"); an em dash when unknown. */
export const planMoney = (n: number | null | undefined): string =>
  n == null
    ? "—"
    : `$${n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

/**
 * The plan's price line for this tenant: "$499/mo", "$4,990/yr" or "Custom pricing"; null when the server sent no
 * price. Reads the server-RESOLVED price (a super-admin override beats the catalog), never a catalog figure.
 */
export function planPriceLabel(
  sub: Pick<SubscriptionView, "isCustom" | "cycle" | "monthlyPrice" | "annualPrice">,
): string | null {
  if (sub.isCustom) return "Custom pricing";
  const n = sub.cycle === "ANNUAL" ? sub.annualPrice : sub.monthlyPrice;
  return n == null ? null : `${planMoney(n)}/${sub.cycle === "ANNUAL" ? "yr" : "mo"}`;
}
