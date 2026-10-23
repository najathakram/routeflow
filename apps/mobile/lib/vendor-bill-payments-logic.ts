import { roundMoney } from "@routeflow/pricing";
import { API_ERROR_CODES } from "@routeflow/types";
import type { VendorBillPayment } from "./api/vendor-bills";

/**
 * B288 mobile parity (row 667): pure logic for a vendor-bill void refused with 409 BILL_HAS_PAYMENTS
 * (the bill carries CASH payments) and its exit, "move to supplier credit". Mirrors web:
 *   - copy        apps/web/lib/generic-toast-copy.ts `billHasPaymentsCopy` (fixed sentence, amount from the
 *                 structured `amount` field, never the server's message)
 *   - endpoint    apps/web/lib/api/vendor-bills.ts `useMoveVendorBillPaymentToCredit`
 *                 (POST /vendor-bills/:id/payments/:paymentId/move-to-credit, no body)
 *   - predicate   apps/web/lib/api/vendor-bills.ts `isMovableBillPayment`
 *   - confirm     apps/web/app/(dashboard)/vendor-bills/[id]/page.tsx `MovePaymentModal`
 * Kept RN-free (type-only import of the payment shape) so `__tests__/*.test.ts` can lock it.
 */

export type BillHasPaymentsRefusal =
  { kind: "has-payments"; amount: number | null } | { kind: "other" };

function bodyOf(err: unknown): Record<string, unknown> {
  const data = (err as { response?: { data?: unknown } } | null | undefined)?.response?.data;
  return data && typeof data === "object" ? (data as Record<string, unknown>) : {};
}

/** Classify an API error: the coded BILL_HAS_PAYMENTS refusal (with its rounded cash `amount`) vs anything else. */
export function billHasPaymentsRefusal(err: unknown): BillHasPaymentsRefusal {
  const data = bodyOf(err);
  if (data.code !== API_ERROR_CODES.BILL_HAS_PAYMENTS) return { kind: "other" };
  const amount =
    typeof data.amount === "number" && Number.isFinite(data.amount) && data.amount >= 0
      ? data.amount
      : null;
  return { kind: "has-payments", amount };
}

export const usd = (n: number): string => `$${roundMoney(n).toFixed(2)}`;

/** The fixed sentence web shows (same words); no amount degrades to "payments". */
export function billHasPaymentsCopy(amount: number | null): string {
  const shown = amount === null ? null : usd(amount);
  return `This bill has ${shown ?? "payments"}${shown ? " in payments" : ""}. Move them to a supplier credit first.`;
}

/** Message for a failed void: fixed copy for BILL_HAS_PAYMENTS, today's server-message fallback otherwise. */
export function voidRefusalCopy(err: unknown): string {
  const refusal = billHasPaymentsRefusal(err);
  if (refusal.kind === "has-payments") return billHasPaymentsCopy(refusal.amount);
  const message = bodyOf(err).message;
  if (typeof message === "string" && message) return message;
  const own = (err as { message?: unknown } | null | undefined)?.message;
  return typeof own === "string" && own ? own : "Try again.";
}

/** A payment the screen offers "Move to supplier credit" for: cash, not a draw of supplier credit. */
export function isMovableBillPayment(p: Pick<VendorBillPayment, "method" | "supplierCreditId">) {
  return p.method !== "CREDIT_NOTE" && !p.supplierCreditId;
}

export function movablePayments<T extends Pick<VendorBillPayment, "method" | "supplierCreditId">>(
  payments: readonly T[] | undefined | null,
): T[] {
  return (payments ?? []).filter(isMovableBillPayment);
}

/** The request the move-to-credit mutation sends (the shared client prefixes the API base). */
export function moveToCreditRequest(
  billId: string,
  paymentId: string,
): { method: "post"; url: string } {
  return { method: "post", url: `/vendor-bills/${billId}/payments/${paymentId}/move-to-credit` };
}

export interface ConfirmCopy {
  title: string;
  message: string;
  confirmText: string;
}

/** Offer the move-all prompt only when the client cash total equals the server's structured amount (rounded both sides). */
export function canOfferMoveAll(
  payments: readonly Pick<VendorBillPayment, "amount">[],
  serverAmount: number | null,
): boolean {
  if (payments.length === 0 || serverAmount === null) return false;
  const total = payments.reduce((sum, p) => sum + Number(p.amount ?? 0), 0);
  return roundMoney(total) === roundMoney(serverAmount);
}

/** Confirm for moving ONE payment (web MovePaymentModal's words). `dateLabel` is the already-formatted payment date. */
export function movePaymentConfirmCopy(
  payment: Pick<VendorBillPayment, "amount">,
  billStatus: string,
  dateLabel: string,
): ConfirmCopy {
  const consequence =
    billStatus === "VOID"
      ? "The credit goes to the next bill from this supplier."
      : "This bill owes that amount again. The credit goes to the next bill from this supplier.";
  return {
    title: "Move to supplier credit?",
    message: `${usd(Number(payment.amount))} paid on ${dateLabel} comes off this bill and becomes credit with the supplier, dated the same day.\n\n${consequence}`,
    confirmText: "Move to credit",
  };
}

/** Confirm offered right after a refused void: moves every cash payment, then the operator voids again. */
export function movePaymentsConfirmCopy<T extends Pick<VendorBillPayment, "amount">>(
  payments: readonly T[],
): ConfirmCopy {
  const total = roundMoney(payments.reduce((sum, p) => sum + Number(p.amount ?? 0), 0));
  return {
    title: "Move payments to credit?",
    message: `${usd(total)} in payments comes off this bill and becomes credit with the supplier, dated the day each was paid. You can then void the bill again.`,
    confirmText: "Move payments to credit",
  };
}

export function movedToCreditCopy(count: number, total: number): string {
  return count === 1
    ? `Payment moved to supplier credit (${usd(total)})`
    : `${count} payments moved to supplier credit (${usd(total)})`;
}

/** Fixed sentences for the two coded refusals of move-to-credit (web CODE_COPY); never the server message. */
export function moveToCreditFailureCopy(err: unknown): string {
  const code = bodyOf(err).code;
  if (code === API_ERROR_CODES.BILL_PAYMENT_NOT_CASH)
    return "That payment is a draw of supplier credit. Voiding or deleting the bill hands it back.";
  if (code === API_ERROR_CODES.BILL_PAYMENT_NO_SUPPLIER)
    return "This bill has no supplier, so there is no account to hold the credit.";
  return "Couldn't move the payment. Try again.";
}
