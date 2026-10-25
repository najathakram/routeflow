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

/** The note shown when a typed check/card amount equals the total: it is a full payment, said before submit, not silently. */
export const PART_PAY_FULL_COPY = "That is the full total, so it pays in full.";

/** True when an identified customer's CHECK or CARD amount typed in "Amount paying now" is exactly the total. */
export function partPayEqualsTotal(input: PartPayInput): boolean {
  if (input.isWalkIn || (input.method !== "CHECK" && input.method !== "CARD")) return false;
  const paid = roundMoney(input.tendered);
  return paid > 0 && paid === roundMoney(input.total);
}

/** The label under the total: "Pay $5.00 now · $7.50 goes on account". */
export const partPayCopy = (
  split: { now: number; onAccount: number },
  /** the customer holds credit the server may apply (or it is not known): the remainder is the server's figure, not ours */
  creditMayApply = false,
): string =>
  creditMayApply
    ? `Pay ${formatReceiptMoney(split.now)} now · the rest goes on account, less any credit applied`
    : `Pay ${formatReceiptMoney(split.now)} now · ${formatReceiptMoney(split.onAccount)} goes on account`;

/** True unless the server-owned statement says the customer holds no open credit (unread/failed counts as "may apply"). */
export const creditMayApply = (available: { state: string; value?: number }): boolean =>
  !(available.state === "ready" && (available.value ?? 0) <= 0);

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

/** The refusal for an "Amount paying now" that is not a positive number (it is also the screen's stale-error key). */
export const PART_PAY_AMOUNT_COPY = "Enter an amount above zero, or leave it empty to pay in full.";

/** The refusal for a CHECK or CARD "Amount paying now" above the total: the server refuses it too (COUNTER_PAYMENT_EXCEEDS_TOTAL). */
export const PART_PAY_OVER_TOTAL_COPY =
  "Amount paying now can't be more than the total. Lower it, or leave it empty to pay in full.";

/**
 * An identified customer's CHECK or CARD "Amount paying now" that is typed but is not a positive plain number ("0", "-5",
 * "5,00", "abc") is refused: read as zero it would silently become a FULL payment. Blank (or spaces) is the one way to say
 * "pay in full". With `total`, an amount strictly above it is refused too (exactly the total is a full payment). Applies to nothing else (cash has its own rule; a walk-in has no such field).
 */
export function partPayAmountProblem(input: {
  method: CounterSalePaymentMethod;
  isWalkIn: boolean;
  tendered: string;
  total?: number;
}): string | null {
  if (input.isWalkIn || (input.method !== "CHECK" && input.method !== "CARD")) return null;
  const raw = input.tendered.trim();
  if (raw === "") return null;
  const plain = /^(\d+\.?\d*|\.\d+)$/.test(raw);
  if (!plain || !(Number(raw) > 0)) return PART_PAY_AMOUNT_COPY;
  if (input.total !== undefined && roundMoney(Number(raw)) > roundMoney(input.total)) {
    return PART_PAY_OVER_TOTAL_COPY;
  }
  return null;
}
