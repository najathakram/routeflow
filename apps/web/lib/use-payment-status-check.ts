import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { PaymentKeyHolder } from "@/lib/payment-submit-key";
import { resolvePaymentByKey } from "@/lib/api/payment-by-key";
import { paymentStatusCopy, type PaymentStatusOutcome } from "@routeflow/types/payment-submit-key";

/**
 * SA-824: the web side of "Check payment status". Runs the holder's `checkStatus` against the by-key RESOLVE and
 * keeps the last answer for the dialog. `onRecorded(payment)` runs when the payment IS recorded: the dialog
 * does what a 2xx does (toast, refresh, close). Lists a payment touches are refreshed here.
 */
export function usePaymentStatusCheck(
  holder: PaymentKeyHolder,
  onRecorded?: (payment: unknown) => void | Promise<void>,
  /** A dialog that stays mounted passes its open flag: closing forgets the last answer. */
  isOpen = true,
) {
  const qc = useQueryClient();
  const [checking, setChecking] = React.useState(false);
  const [outcome, setOutcome] = React.useState<PaymentStatusOutcome | null>(null);
  React.useEffect(() => {
    if (!isOpen) setOutcome(null);
  }, [isOpen]);
  const check = React.useCallback(async () => {
    setChecking(true);
    try {
      const out = await holder.checkStatus(resolvePaymentByKey);
      setOutcome(out);
      if (out.kind === "found") {
        for (const k of ["invoices", "customers", "payments"]) {
          void qc.invalidateQueries({ queryKey: [k] });
        }
        await onRecorded?.(out.payment);
      }
    } finally {
      setChecking(false);
    }
  }, [holder, qc, onRecorded]);
  const unknown = holder.hasUnknown();
  return {
    /** True while the outcome is unknown: the dialog shows the check and keeps Save off. */
    unknown,
    checking,
    check,
    /**
     * The fixed line for the last answer (null before any). While unknown only a no-answer line shows (error,
     * in flight): a newer unknown outcome hides a stale "cancelled" or "recorded".
     */
    message:
      outcome && (!unknown || outcome.kind === "error" || outcome.kind === "inFlight")
        ? paymentStatusCopy(outcome)
        : null,
  };
}

export type PaymentStatusCheck = ReturnType<typeof usePaymentStatusCheck>;
