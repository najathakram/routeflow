import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { paymentStatusCopy, type PaymentStatusOutcome } from "@routeflow/types/payment-submit-key";
import { fetchPaymentByKey } from "./api/payment-by-key";
import { runPaymentStatusCheck } from "./payment-status-check";
import type { PaymentKeyHolder } from "./payment-submit-key";

/**
 * SA-824: the mobile side of "Check payment status". While `unknown` the screen keeps Save off and shows
 * the action; `onRecorded(payment)` runs when the payment IS recorded and does what a 2xx does (toast,
 * close). The fixed line of the last answer is `message` (never a raw server message).
 */
export function usePaymentStatusCheck(
  holder: PaymentKeyHolder,
  onRecorded?: (payment: unknown) => void,
) {
  const qc = useQueryClient();
  const [checking, setChecking] = useState(false);
  const [answer, setAnswer] = useState<PaymentStatusOutcome | null>(null);
  const check = useCallback(async () => {
    setChecking(true);
    try {
      const { outcome } = await runPaymentStatusCheck(holder, fetchPaymentByKey);
      setAnswer(outcome);
      if (outcome.kind === "found") {
        for (const k of ["invoices", "admin", "customers"]) {
          void qc.invalidateQueries({ queryKey: [k] });
        }
        onRecorded?.(outcome.payment);
      }
    } finally {
      setChecking(false);
    }
  }, [holder, qc, onRecorded]);
  const unknown = holder.hasUnknown();
  // The last answer's fixed line; a newer unknown outcome hides a stale "nothing was recorded".
  const message =
    answer && (!unknown || answer.kind === "error") ? paymentStatusCopy(answer) : null;
  return { unknown, checking, check, message };
}

export type PaymentStatusCheck = ReturnType<typeof usePaymentStatusCheck>;
