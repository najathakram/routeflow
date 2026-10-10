import { roundMoney } from "@routeflow/pricing";
import { fmt, fmtDate } from "./formatting";

/**
 * P-4: the invoice's derived `revisedAt` (ISO or null) and `overpaidBy` (> 0 only when overpaid) are OPTIONAL on the wire —
 * absent means no badge / nothing shown, so the client is safe before the API field lands.
 */
export function revisedBadgeText(revisedAt?: string | null): string | null {
  if (!revisedAt) return null;
  const when = fmtDate(revisedAt);
  return when === "—" ? null : `Revised ${when}`;
}

export function overpaidText(overpaidBy?: number | null): string | null {
  if (typeof overpaidBy !== "number" || !Number.isFinite(overpaidBy)) return null;
  const amount = roundMoney(overpaidBy);
  return amount > 0 ? `Overpaid by ${fmt(amount)}` : null;
}
