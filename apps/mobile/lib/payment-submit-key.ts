import { useRef } from "react";
import { createPaymentKeyHolder, type PaymentKeyHolder } from "@routeflow/types/payment-submit-key";

export {
  createPaymentKeyHolder,
  isPaymentKeyConflict,
  PAYMENT_MAY_BE_RECORDED_COPY,
  paymentMayBeRecordedCopy,
  paymentSubmitFingerprint,
  sendWithPaymentKey,
  type PaymentKeyHolder,
} from "@routeflow/types/payment-submit-key";

/**
 * SA-824: the Idempotency-Key of one record-payment screen (Record payment, invoice Record payment,
 * customer Record advance). The rule is the ONE shared `@routeflow/types/payment-submit-key`, the same
 * one web uses: one key per open, kept across retries, re-minted on a known outcome or a changed
 * amount / method / allocation. Each of these screens mounts per open, so one holder per mount is one
 * key per open. Payments stay online-only: none of these routes is in the offline queue's allow-list.
 */
export function usePaymentSubmitKey(): PaymentKeyHolder {
  const ref = useRef<PaymentKeyHolder | null>(null);
  if (!ref.current) ref.current = createPaymentKeyHolder();
  return ref.current;
}
