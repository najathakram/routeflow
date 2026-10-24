import { roundMoney } from "./pricing";
import type { ChargeLine } from "./charge-lines";

/**
 * The ONE split of a receipt's money below the subtotal (CQ-03): Subtotal - Discounts + Tax + each named Charge +
 * Adjustments = Total. Shared by the live counter receipt, the reprint and the emailed receipt, so they cannot print
 * different lines for one sale.
 *
 * - `tax` is the order's regular sales tax (the levy is never inside it).
 * - `charges` are the regulated levies (deposit, excise), each its own named line.
 * - `adjustments` is whatever else is left (a re-price, a credit). It is never the levy.
 * - A tax the total does not carry is not printed: when subtotal + charges already equal the total, a stored tax would
 *   only be printed and then reversed by an equal negative Adjustments (an exempt customer's older order), so it is 0.
 */
export function receiptFigures(input: {
  /** the lines at their net prices, discounts already taken off */
  netSubtotal: number;
  total: number;
  /** the order's regular tax (`Order.tax`) */
  tax: number;
  charges?: readonly ChargeLine[];
}): { tax: number; charges: ChargeLine[]; adjustments: number } {
  const charges = [...(input.charges ?? [])];
  const chargeSum = roundMoney(charges.reduce((s, c) => s + c.amount, 0));
  const left = roundMoney(input.total - input.netSubtotal - chargeSum) || 0; // what tax + adjustments must explain
  const tax = roundMoney(input.tax) || 0; // never -0
  if (tax > 0 && left === 0) return { tax: 0, charges, adjustments: 0 };
  return { tax, charges, adjustments: roundMoney(left - tax) || 0 };
}
