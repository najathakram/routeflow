import * as React from "react";
import {
  acquirePaymentKeyHolder,
  adoptPaymentKeyHolder,
  createPaymentKeyHolder,
  releasePaymentKeyHolder,
  type PaymentKeyHolder,
} from "@routeflow/types/payment-submit-key";

export {
  PAYMENT_KEY_RESOLVED_COPY,
  PAYMENT_MAY_BE_RECORDED_COPY,
  PAYMENT_PHOTO_LATER_COPY,
  finishFoundPayment,
  forgetPaymentProof,
  paymentKeyRefusalCopy,
  paymentKeyScope,
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
 * `scope` names the payment WRITER + TARGET (`paymentKeyScope`: `invoice:<id>`, `standalone:<customerId>`,
 * `advance:<customerId>`), never the surface: the holder lives in a module-level registry keyed by it, so a
 * Cancel -> reopen of a dialog whose outcome is UNKNOWN gets the same key back (Save stays off, "Check
 * payment status" stays offered), and so does a DIFFERENT dialog for the same writer + target. `null` = the
 * target is not chosen yet: an idle private holder, nothing is registered and no key can be minted
 * (the caller sends nothing without a target). `isOpen` false -> true starts a fresh attempt only when nothing
 * is unknown; a dialog that mounts per open passes `true`.
 */
export function usePaymentSubmitKey(isOpen: boolean, scope: string | null): PaymentKeyHolder {
  const ref = React.useRef<{ scope: string | null; holder: PaymentKeyHolder } | null>(null);
  if (!ref.current || ref.current.scope !== scope) {
    ref.current = {
      scope,
      holder: scope === null ? createPaymentKeyHolder() : acquirePaymentKeyHolder(scope),
    };
  }
  const holder = ref.current.holder;
  React.useEffect(() => {
    if (scope === null) return;
    adoptPaymentKeyHolder(scope, holder);
    return () => releasePaymentKeyHolder(scope); // an unmount; an unknown outcome is kept
  }, [scope, holder]);
  React.useEffect(() => {
    if (isOpen) holder.reset(); // no-op while an outcome is unknown
  }, [isOpen, holder]);
  return holder;
}
