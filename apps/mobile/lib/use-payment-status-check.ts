import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { paymentStatusCopy, type PaymentStatusOutcome } from "@routeflow/types/payment-submit-key";
import { resolvePaymentByKey } from "./api/payment-by-key";
import { checkPaymentStatus } from "./payment-status-check";
import type { PaymentKeyHolder } from "./payment-submit-key";

/**
 * Whether the screen treats the outcome as unknown: the key is locked, or a request is still in flight that this
 * screen did NOT send itself (it opened while the holder already had one out: back + reopen). Its own pending
 * Save is not shown as "we couldn't confirm".
 *  - "Inherited" is decided on every OPEN (`isOpen` false -> true) and whenever the holder changes, never once
 *    per mount, so a screen or sheet that stays mounted offers the check the moment it reopens.
 *  - It ends with the inherited flight: once nothing is out, a later Save of this screen is its own.
 * Re-renders on every holder change, so a late settle of the first request reaches a reopened screen.
 */
export function useHolderUnknown(holder: PaymentKeyHolder, isOpen = true): boolean {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const inherited = useRef(false);
  const seen = useRef<{ holder: PaymentKeyHolder; open: boolean } | null>(null);
  if (!seen.current || seen.current.holder !== holder || (isOpen && !seen.current.open)) {
    inherited.current = isOpen && holder.inFlight();
  }
  seen.current = { holder, open: isOpen };
  useEffect(() => {
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
 * SA-824: the mobile side of "Check payment status". While `unknown` the screen keeps Save off and shows
 * the action; `onRecorded(message)` runs when the payment IS recorded and does what a 2xx does (toast the
 * fixed `message`, close). The receipt photo remembered for `scope` is attached first (`upload` is the
 * screen's throwing upload). The fixed line of the last answer is `message` (never a raw server message).
 */
export function usePaymentStatusCheck(
  holder: PaymentKeyHolder,
  scope: string,
  upload: (paymentId: string, photoUri: string) => Promise<unknown>,
  onRecorded?: (message: string) => void,
  /** A screen or sheet that stays mounted passes its open flag. */
  isOpen = true,
) {
  const qc = useQueryClient();
  const [checking, setChecking] = useState(false);
  const [answer, setAnswer] = useState<PaymentStatusOutcome | null>(null);
  const check = useCallback(async () => {
    setChecking(true);
    try {
      const { outcome, message } = await checkPaymentStatus(
        holder,
        scope,
        resolvePaymentByKey,
        upload,
      );
      setAnswer(outcome);
      if (outcome.kind === "found") {
        for (const k of ["invoices", "admin", "customers"]) {
          void qc.invalidateQueries({ queryKey: [k] });
        }
        onRecorded?.(message);
      }
    } finally {
      setChecking(false);
    }
  }, [holder, scope, upload, qc, onRecorded]);
  const unknown = useHolderUnknown(holder, isOpen);
  // The last answer's fixed line; while unknown only a no-answer line shows (error, in flight), so a newer
  // unknown outcome hides a stale "cancelled" or "recorded".
  const message =
    answer && (!unknown || answer.kind === "error" || answer.kind === "inFlight")
      ? paymentStatusCopy(answer)
      : null;
  return { unknown, checking, check, message };
}

export type PaymentStatusCheck = ReturnType<typeof usePaymentStatusCheck>;
