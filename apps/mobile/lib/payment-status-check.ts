import {
  PAYMENT_PHOTO_LATER_COPY,
  PAYMENT_STATUS_COPY,
  finishFoundPayment,
  forgetPaymentProof,
  paymentStatusCopy,
  type FoundPhotoOutcome,
  type PaymentStatusOutcome,
} from "@routeflow/types/payment-submit-key";
import type { PaymentKeyHolder } from "./payment-submit-key";

export { PAYMENT_STATUS_COPY };

/** The existing mobile copy when the receipt photo fails to upload after the payment was recorded. */
export const PAYMENT_PHOTO_FAILED_COPY = "Payment recorded, but the photo failed to upload.";

/**
 * SA-824: `GET /invoices/payments/by-key/:key`, the "Check payment status" read. 200 = the stored payment;
 * 404 PAYMENT_KEY_NOT_FOUND = nothing recorded under the key (the server-definitive answer).
 */
export const paymentByKeyPath = (key: string) =>
  `/invoices/payments/by-key/${encodeURIComponent(key)}`;

/**
 * Run the check against the holder (the shared rule: found releases the key, 404 PAYMENT_KEY_NOT_FOUND
 * releases it, anything else stays unknown) and pair the outcome with its FIXED line. On "found" the
 * receipt photo remembered for `scope` is attached to the found payment with `upload` (the same call the
 * 2xx path makes); a photo that cannot be attached is never lost silently (its own fixed line).
 */
export async function checkPaymentStatus(
  holder: PaymentKeyHolder,
  scope: string,
  fetch: (key: string) => Promise<unknown>,
  upload: (paymentId: string, photoUri: string) => Promise<unknown>,
): Promise<{ outcome: PaymentStatusOutcome; message: string; photo: FoundPhotoOutcome }> {
  const outcome = await holder.checkStatus(fetch);
  if (outcome.kind === "notFound") forgetPaymentProof(scope);
  if (outcome.kind !== "found")
    return { outcome, message: paymentStatusCopy(outcome), photo: "none" };
  const photo = await finishFoundPayment<string>(scope, outcome.payment, upload);
  const message =
    photo === "later"
      ? PAYMENT_PHOTO_LATER_COPY
      : photo === "failed"
        ? PAYMENT_PHOTO_FAILED_COPY
        : paymentStatusCopy(outcome);
  return { outcome, message, photo };
}
