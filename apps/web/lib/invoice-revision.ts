import { roundMoney } from "@routeflow/pricing";
import { fmt } from "./formatting";

/**
 * P-4: the invoice's derived `revisedAt` (ISO or null) and `overpaidBy` (> 0 only when overpaid) are OPTIONAL on the wire —
 * absent means no badge / nothing shown, so the client is safe before the API field lands.
 */
/** `timeZone` is the business's own IANA zone (the day it revised the invoice), not the browser's; unknown/invalid = UTC. */
export function revisedBadgeText(revisedAt?: string | null, timeZone?: string): string | null {
  if (!revisedAt) return null;
  const at = new Date(revisedAt);
  if (isNaN(at.getTime())) return null;
  const format = (zone: string | undefined) =>
    at.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: zone,
    });
  let when: string;
  try {
    when = format(timeZone);
  } catch {
    when = format("UTC");
  }
  return `Revised ${when}`;
}

export function overpaidText(overpaidBy?: number | null): string | null {
  if (typeof overpaidBy !== "number" || !Number.isFinite(overpaidBy)) return null;
  const amount = roundMoney(overpaidBy);
  return amount > 0 ? `Overpaid by ${fmt(amount)}` : null;
}
