import {
  PAYMENT_STATUS_COPY,
  paymentStatusCopy,
  type PaymentStatusOutcome,
} from "@routeflow/types/payment-submit-key";
import type { PaymentKeyHolder } from "./payment-submit-key";

export { PAYMENT_STATUS_COPY };

/**
 * SA-824: `GET /invoices/payments/by-key/:key`, the "Check payment status" read. 200 = the stored payment;
 * 404 PAYMENT_KEY_NOT_FOUND = nothing recorded under the key (the server-definitive answer).
 */
export const paymentByKeyPath = (key: string) =>
  `/invoices/payments/by-key/${encodeURIComponent(key)}`;

/**
 * Run the check against the holder (the shared rule: found releases the key, 404 PAYMENT_KEY_NOT_FOUND
 * releases it, anything else stays unknown) and pair the outcome with its FIXED line.
 */
export async function runPaymentStatusCheck(
  holder: PaymentKeyHolder,
  fetch: (key: string) => Promise<unknown>,
): Promise<{ outcome: PaymentStatusOutcome; message: string }> {
  const outcome = await holder.checkStatus(fetch);
  return { outcome, message: paymentStatusCopy(outcome) };
}
