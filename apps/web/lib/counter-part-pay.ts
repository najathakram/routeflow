import { formatReceiptMoney, roundMoney } from "@routeflow/pricing";
import type { CounterSalePaymentMethod } from "@routeflow/types";

/**
 * SA-933 / W-822(a) S4: an IDENTIFIED customer can pay part now (cash, check or card) and the rest goes on account. The
 * server already allows it (`planCounterPayment`: below the balance is a partial payment of exactly what was tendered; only a
 * walk-in is held to the full total, `assertWalkInTenderCoversTotal`). Cents are `roundMoney`'s, never ad-hoc rounding.
 */
interface PartPayInput {
  method: CounterSalePaymentMethod;
  isWalkIn: boolean;
  total: number;
  tendered: number;
}

/** True when `tendered` is a real part payment of `total`: more than a cent's worth of nothing, and less than all of it. */
function isPart(total: number, tendered: number): boolean {
  const paid = roundMoney(tendered);
  return paid > 0 && paid < roundMoney(total);
}

/** What is paid now and what goes on account; null unless an identified customer's tender (not On account) is short. */
export function partPaySplit(input: PartPayInput): { now: number; onAccount: number } | null {
  if (input.isWalkIn || input.method === "ON_ACCOUNT") return null;
  if (!isPart(input.total, input.tendered)) return null;
  const now = roundMoney(input.tendered);
  return { now, onAccount: roundMoney(roundMoney(input.total) - now) };
}

/** The label under the total: "Pay $5.00 now · $7.50 goes on account". */
export const partPayCopy = (split: { now: number; onAccount: number }): string =>
  `Pay ${formatReceiptMoney(split.now)} now · ${formatReceiptMoney(split.onAccount)} goes on account`;

/**
 * The `amount` the counter-sale payment carries. CASH always states what was tendered (change is worked out from it). A CHECK
 * or CARD states an amount ONLY for an identified customer's part payment: a full payment leaves it out so the server charges
 * exactly its own balance, as it always has.
 */
export function counterPaymentAmount(
  input: PartPayInput,
): { amount: number } | Record<string, never> {
  if (input.method === "CASH") return { amount: roundMoney(input.tendered) };
  if (input.method === "ON_ACCOUNT" || input.isWalkIn) return {};
  return isPart(input.total, input.tendered) ? { amount: roundMoney(input.tendered) } : {};
}
