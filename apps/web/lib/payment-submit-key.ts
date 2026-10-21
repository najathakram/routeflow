import * as React from "react";
import { createPaymentKeyHolder, type PaymentKeyHolder } from "@routeflow/types/payment-submit-key";

export {
  PAYMENT_MAY_BE_RECORDED_COPY,
  paymentMayBeRecordedCopy,
  sendWithPaymentKey,
  type PaymentKeyHolder,
} from "@routeflow/types/payment-submit-key";

/**
 * SA-824: the Idempotency-Key of one record-payment dialog (customer Record Payment, Payments page,
 * invoice Record Payment, customer Record Advance Payment). The rule is the shared
 * `@routeflow/types/payment-submit-key` (one key per open, kept across retries, re-minted on a known
 * outcome or a changed amount / method / allocation); this is the web entry point.
 *
 * `isOpen` false -> true starts a fresh attempt. A dialog that mounts per open passes `true`.
 */
export function usePaymentSubmitKey(isOpen: boolean): PaymentKeyHolder {
  const ref = React.useRef<PaymentKeyHolder | null>(null);
  if (!ref.current) ref.current = createPaymentKeyHolder();
  React.useEffect(() => {
    if (isOpen) ref.current?.reset();
  }, [isOpen]);
  return ref.current;
}
