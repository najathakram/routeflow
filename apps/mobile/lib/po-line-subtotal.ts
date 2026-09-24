/**
 * The money of a STORED purchase-order line, for display (B698 — the mobile twin of web's
 * `resolveStoredPOLineAmounts`).
 *
 * A boxed line's stored `unitCost` is the per-piece cost at 4 dp, for costing only; re-multiplying it
 * by the piece count is the exact drift B677 (#1199) fixed on the store side: 1,000 cases of 12 at
 * $11.00 is stored as $11,000.00 and `12000 x 0.9167` reads $11,000.40. The server stores and returns
 * the exact `totalCost`, so it is the document figure; the multiply is ONLY the fallback for a row
 * that carries no stored total. The ORDER total is `poDisplayTotal` in `po-list-logic.ts`, whose line
 * fallback sums THIS helper — one derivation, so the list row, the detail header and the detail rows
 * can never disagree. Spec: __tests__/po-line-subtotal.test.ts.
 */
import { roundMoney } from "@routeflow/pricing";

export interface StoredPOLine {
  qtyOrdered: number | string;
  unitCost: number | string;
  totalCost?: number | string | null;
}

/** Stored exact total when the row has one, else roundMoney(qtyOrdered x unitCost). */
export function poLineSubtotal(item: StoredPOLine): number {
  const stored = item.totalCost != null ? Number(item.totalCost) : NaN;
  if (Number.isFinite(stored) && stored >= 0) return roundMoney(stored);
  return roundMoney((Number(item.qtyOrdered) || 0) * (Number(item.unitCost) || 0));
}
