import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { PaymentKeyHolder } from "@/lib/payment-submit-key";
import { resolvePaymentByKey } from "@/lib/api/payment-by-key";
import { paymentStatusCopy, type PaymentStatusOutcome } from "@routeflow/types/payment-submit-key";

/**
 * Whether the dialog treats the outcome as unknown: the key is locked, or a request is still in flight that this
 * dialog did NOT send itself (it was opened while the holder already had one out: a Cancel -> reopen, or a
 * dialog that stays mounted). Its own pending Save is not shown as "we couldn't confirm" (its Save button
 * already reads Saving...).
 *  - "Inherited" is decided on every OPEN (`isOpen` false -> true) and whenever the holder changes, never once
 *    per mount: a dialog that stays mounted must offer "Check payment status" the moment it reopens.
 *  - It ends with the inherited flight: once nothing is out, a later Save of this dialog is its own.
 * Re-renders on every holder change, so a late settle of the first request reaches a reopened dialog.
 */
export function useHolderUnknown(holder: PaymentKeyHolder, isOpen = true): boolean {
  const [, bump] = React.useReducer((n: number) => n + 1, 0);
  const inherited = React.useRef(false);
  const seen = React.useRef<{ holder: PaymentKeyHolder; open: boolean } | null>(null);
  if (!seen.current || seen.current.holder !== holder || (isOpen && !seen.current.open)) {
    inherited.current = isOpen && holder.inFlight();
  }
  seen.current = { holder, open: isOpen };
  React.useEffect(() => {
    // the inherited flight may have ended between render and subscribe
    if (!holder.inFlight()) inherited.current = false;
    return holder.subscribe(() => {
      if (!holder.inFlight()) inherited.current = false;
      bump();
    });
  }, [holder]);
  return holder.isLocked() || (holder.inFlight() && inherited.current);
}

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
  const unknown = useHolderUnknown(holder, isOpen);
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
