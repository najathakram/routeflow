import * as React from "react";
import {
  acquirePaymentKeyHolder,
  adoptPaymentKeyHolder,
  releasePaymentKeyHolder,
  type PaymentKeyHolder,
} from "@routeflow/types/payment-submit-key";

export {
  PAYMENT_MAY_BE_RECORDED_COPY,
  PAYMENT_PHOTO_LATER_COPY,
  finishFoundPayment,
  forgetPaymentProof,
  paymentMayBeRecordedCopy,
  rememberPaymentProof,
  sendWithPaymentKey,
  type PaymentKeyHolder,
} from "@routeflow/types/payment-submit-key";

/**
 * SA-824: the Idempotency-Key of one record-payment dialog (customer Record Payment, Payments page,
 * invoice Record Payment, customer Record Advance Payment). The rule is the shared
 * `@routeflow/types/payment-submit-key` (one key per open, kept across retries, re-minted on a known
 * outcome or a changed amount / method / allocation); this is the web entry point.
 *
 * `scope` names the payment TARGET (e.g. `invoice:<id>`): the holder lives in a module-level registry
 * keyed by it, so a Cancel -> reopen of a dialog whose outcome is UNKNOWN gets the same key back (Save
 * stays off, "Check payment status" stays offered). `isOpen` false -> true starts a fresh attempt only
 * when nothing is unknown; a dialog that mounts per open passes `true`.
 */
export function usePaymentSubmitKey(isOpen: boolean, scope: string): PaymentKeyHolder {
  const ref = React.useRef<{ scope: string; holder: PaymentKeyHolder } | null>(null);
  if (!ref.current || ref.current.scope !== scope) {
    ref.current = { scope, holder: acquirePaymentKeyHolder(scope) };
  }
  const holder = ref.current.holder;
  React.useEffect(() => {
    adoptPaymentKeyHolder(scope, holder);
    return () => releasePaymentKeyHolder(scope); // an unmount; an unknown outcome is kept
  }, [scope, holder]);
  React.useEffect(() => {
    if (isOpen) holder.reset(); // no-op while an outcome is unknown
  }, [isOpen, holder]);
  return holder;
}
