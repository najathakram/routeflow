import { roundMoney } from "@routeflow/pricing";

/**
 * P-4: the invoice's derived `revisedAt` (ISO or null) and `overpaidBy` (> 0 only when overpaid) are OPTIONAL on the wire;
 * absent means no badge / nothing shown. Mirrors apps/web/lib/invoice-revision.ts.
 */
export function revisedBadgeText(revisedAt?: string | null): string | null {
  if (!revisedAt) return null;
  const d = new Date(revisedAt);
  if (isNaN(d.getTime())) return null;
  return `Revised ${d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;
}

export function overpaidText(overpaidBy?: number | null): string | null {
  if (typeof overpaidBy !== "number" || !Number.isFinite(overpaidBy)) return null;
  const amount = roundMoney(overpaidBy);
  return amount > 0 ? `Overpaid by $${amount.toFixed(2)}` : null;
}
