import { roundMoney } from "./pricing";

/**
 * The ONE purchase-order total rule for every list and detail header (web and mobile).
 *
 * #1485 / B719: the web list read a `total` the API never sends (it returns the raw Prisma
 * `PurchaseOrder.totalAmount`, a numeric STRING) and showed $0.00; mobile had already fixed its own
 * copy. The two copies then diverged (web rounded the stored total, mobile returned it raw), so the
 * lead's condition on #2637 moved the rule here, where both apps import it.
 */

/** A stored purchase-order line as the API returns it (Decimal columns arrive as strings). */
export interface StoredPOLine {
  qtyOrdered: number | string;
  unitCost: number | string;
  /** The exact document total the server stored for the line (B698), when present. */
  totalCost?: number | string | null;
}

/**
 * A line's total: its STORED `totalCost` when it has a usable one (rounded to cents), else
 * roundMoney(qtyOrdered x unitCost) for a legacy row with none. Never re-multiplies a line that has a
 * stored total: on a boxed line the rounded 4 dp per-piece cost would drift (B698).
 */
export function storedPOLineTotal(item: StoredPOLine): number {
  const stored = item.totalCost != null && item.totalCost !== "" ? Number(item.totalCost) : NaN;
  if (Number.isFinite(stored) && stored >= 0) return roundMoney(stored);
  const computed = roundMoney((Number(item.qtyOrdered) || 0) * (Number(item.unitCost) || 0));
  return Number.isFinite(computed) ? computed : 0;
}

/**
 * The total a purchase order shows: the server-stored `totalAmount` when it is a positive number
 * (coerced from its numeric string, rounded to cents), else the rounded sum of the lines' stored
 * totals. A missing, zero, negative or unreadable stored total falls back to the lines.
 */
export function poDisplayTotal(po: {
  totalAmount?: number | string | null;
  items?: readonly StoredPOLine[] | null;
}): number {
  const stored = po.totalAmount != null && po.totalAmount !== "" ? Number(po.totalAmount) : NaN;
  if (Number.isFinite(stored) && stored > 0) return roundMoney(stored);
  const lines = (po.items ?? []).reduce((sum, i) => sum + storedPOLineTotal(i), 0);
  const total = roundMoney(lines);
  return Number.isFinite(total) ? total : 0;
}
