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
 * SA-824 race ruling 3/5: `POST /invoices/payments/by-key/:key/resolve`, the "Check payment status" call.
 * 200 { state: "found", ... } = the stored payment; 200 { state: "tombstoned" } = nothing was recorded and the
 * key is closed; 409 PAYMENT_KEY_IN_FLIGHT = still committing (retryable). Only found / tombstoned release.
 */
export const paymentResolvePath = (key: string) =>
  `/invoices/payments/by-key/${encodeURIComponent(key)}/resolve`;

/**
 * Run the check against the holder (the shared rule: found or a tombstone releases the key; in flight, a 404
 * or any other error stays unknown) and pair the outcome with its FIXED line. On "found" the
 * receipt photo remembered for `scope` is attached to the found payment with `upload` (the same call the
 * 2xx path makes); a photo that cannot be attached is never lost silently (its own fixed line).
 */
export async function checkPaymentStatus(
  holder: PaymentKeyHolder,
  scope: string,
  resolve: (key: string) => Promise<unknown>,
  upload: (paymentId: string, photoUri: string) => Promise<unknown>,
): Promise<{ outcome: PaymentStatusOutcome; message: string; photo: FoundPhotoOutcome }> {
  const outcome = await holder.checkStatus(resolve);
  if (outcome.kind === "tombstoned") forgetPaymentProof(scope); // nothing recorded: the photo has no payment
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
