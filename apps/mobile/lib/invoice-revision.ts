import { roundMoney } from "@routeflow/pricing";
import { fmtCurrency } from "../utils/format";

/**
 * P-4: the invoice's derived `revisedAt` (ISO or null) and `overpaidBy` (> 0 only when overpaid) are OPTIONAL on the wire;
 * absent means no badge / nothing shown. Mirrors apps/web/lib/invoice-revision.ts. `timeZone` = the business's IANA zone
 * (GET /settings); without it the device zone is used (buyer screens cannot read /settings).
 */
export function revisedBadgeText(
  revisedAt?: string | null,
  timeZone?: string | null,
): string | null {
  if (!revisedAt) return null;
  const d = new Date(revisedAt);
  if (isNaN(d.getTime())) return null;
  const fmt = (zone?: string) =>
    d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: zone,
    });
  try {
    return `Revised ${fmt(timeZone || undefined)}`;
  } catch {
    return `Revised ${fmt("UTC")}`; // a free-text tenant zone Intl does not know
  }
}

export function overpaidText(overpaidBy?: number | null): string | null {
  if (typeof overpaidBy !== "number" || !Number.isFinite(overpaidBy)) return null;
  const amount = roundMoney(overpaidBy);
  return amount > 0 ? `Overpaid by ${fmtCurrency(amount)}` : null;
}
