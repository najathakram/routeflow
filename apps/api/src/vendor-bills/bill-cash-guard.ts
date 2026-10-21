import { PaymentMethod } from "@prisma/client";
import { roundMoney } from "@routeflow/pricing";
import { formatMoney } from "../messaging/messaging.helpers";
import { API_ERROR_CODES } from "../common/api-error-codes";

/**
 * B288 (SA-814 R5-3): void, revert-to-draft and delete used to keep or destroy a bill's CASH
 * payments. A cash `BillPayment` is money that already left the operator's hand; the only honest way
 * to take it off a bill is to move it to a supplier credit (the money is conserved and dated at the
 * original payment). These are the pure pieces: the predicate, the sum and the refusal, mirroring the
 * invoice side's `externalPaidOn` / `voidRefusal` (invoices/invoice-send-guard.ts).
 */

export interface BillPaymentLike {
  amount: unknown;
  method?: unknown;
  supplierCreditId?: string | null;
}

/**
 * A cash payment: any method but CREDIT_NOTE. A draw of on-account supplier credit is a CREDIT_NOTE
 * row carrying `supplierCreditId`; void and delete hand it back to the credit, so it never blocks.
 */
export function isCashBillPayment(payment: BillPaymentLike): boolean {
  return payment.method !== PaymentMethod.CREDIT_NOTE && !payment.supplierCreditId;
}

/** Total of the bill's cash payments, in cents. */
export function billCashPaid(payments: readonly BillPaymentLike[]): number {
  return roundMoney(
    payments.filter(isCashBillPayment).reduce((sum, p) => sum + Number(p.amount ?? 0), 0),
  );
}

/** The sentence the server sends (web shows its own fixed copy, built from `amount`). */
export function billHasPaymentsMessage(amount: number): string {
  return `This bill has ${formatMoney(amount)} in payments. Move them to a supplier credit first.`;
}

/**
 * void / revert / delete / bulk-delete: the 409 body to throw when cash sits on the bill, or null.
 * `amount` is the rounded cash total (structured, so clients never parse the message).
 */
export function billCashPaidRefusal(
  payments: readonly BillPaymentLike[],
): { code: typeof API_ERROR_CODES.BILL_HAS_PAYMENTS; message: string; amount: number } | null {
  const amount = billCashPaid(payments);
  return amount > 0.001
    ? { code: API_ERROR_CODES.BILL_HAS_PAYMENTS, message: billHasPaymentsMessage(amount), amount }
    : null;
}
