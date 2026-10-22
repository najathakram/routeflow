import { useEffect, useRef } from "react";
import {
  acquirePaymentKeyHolder,
  adoptPaymentKeyHolder,
  releasePaymentKeyHolder,
  type PaymentKeyHolder,
} from "@routeflow/types/payment-submit-key";

export {
  clearPaymentKeyRegistry,
  createPaymentKeyHolder,
  finishFoundPayment,
  forgetPaymentProof,
  isPaymentKeyConflict,
  PAYMENT_KEY_RESOLVED_COPY,
  PAYMENT_MAY_BE_RECORDED_COPY,
  PAYMENT_PHOTO_LATER_COPY,
  paymentKeyRefusalCopy,
  paymentMayBeRecordedCopy,
  paymentSubmitFingerprint,
  rememberPaymentProof,
  sendWithPaymentKey,
  type PaymentKeyHolder,
} from "@routeflow/types/payment-submit-key";

/**
 * SA-824: a record-payment screen opening. Returns the holder for the payment TARGET (`scope`, e.g.
 * `invoice:<id>`) from the shared registry: a screen reopened after an UNKNOWN outcome gets the same
 * holder back (same key, still locked, "Check payment status" still offered); otherwise a fresh key.
 * `unmount()` releases the entry unless an outcome is unknown or a request is in flight.
 */
export function mountPaymentKeyHolder(scope: string): {
  holder: PaymentKeyHolder;
  unmount: () => void;
} {
  const holder = acquirePaymentKeyHolder(scope);
  holder.reset(); // a fresh open; a no-op while an outcome is unknown
  return { holder, unmount: () => releasePaymentKeyHolder(scope) };
}

/**
 * SA-824: the Idempotency-Key of one record-payment screen (Record payment, invoice Record payment,
 * customer Record advance). The rule is the ONE shared `@routeflow/types/payment-submit-key`, the same
 * one web uses: one key per open, kept across retries AND across a Cancel -> reopen while the outcome is
 * unknown, re-minted on a known outcome or a changed amount / method / allocation. Payments stay
 * online-only: none of these routes is in the offline queue's allow-list.
 */
export function usePaymentSubmitKey(scope: string): PaymentKeyHolder {
  const ref = useRef<{ scope: string; holder: PaymentKeyHolder } | null>(null);
  if (!ref.current || ref.current.scope !== scope) {
    ref.current = { scope, holder: mountPaymentKeyHolder(scope).holder };
  }
  const holder = ref.current.holder;
  useEffect(() => {
    adoptPaymentKeyHolder(scope, holder);
    return () => releasePaymentKeyHolder(scope);
  }, [scope, holder]);
  return holder;
}
