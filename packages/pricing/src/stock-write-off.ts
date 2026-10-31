import { roundMoney } from "./pricing";

/**
 * SA-804(3): a write-off is DERIVED, never stored — a NEGATIVE stock ADJUSTMENT whose reason says
 * the stock left without a sale. Every report that shows shrinkage reads this one rule.
 * Reporting only: stock movements are not a books (GL) source.
 */
export const WRITE_OFF_ADJUSTMENT_REASONS = ["DAMAGED", "EXPIRED", "THEFT", "SAMPLE"] as const;

export interface WriteOffMovement {
  type: string;
  quantity: number | string | { toString(): string };
  reason?: string | null;
  avgCostAfter?: number | string | { toString(): string } | null;
}

export function isWriteOff(m: WriteOffMovement): boolean {
  return (
    m.type === "ADJUSTMENT" &&
    Number(m.quantity.toString()) < 0 &&
    (WRITE_OFF_ADJUSTMENT_REASONS as readonly string[]).includes(m.reason ?? "")
  );
}

/** |qty| × the movement's point-in-time average cost (`avgCostAfter`), rounded to the cent; 0 when not a write-off. */
export function writeOffValue(m: WriteOffMovement): number {
  if (!isWriteOff(m) || m.avgCostAfter == null) return 0;
  const cost = Number(m.avgCostAfter.toString());
  if (!Number.isFinite(cost)) return 0;
  return roundMoney(Math.abs(Number(m.quantity.toString())) * cost);
}
