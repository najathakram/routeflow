import * as React from "react";
import type { SubscriptionView } from "@routeflow/types";

/**
 * SA-733r6 (B4): "You're all set. Thanks for your payment." shows ONCE on the Billing card after a payment clears.
 * The shell notices the owed invoice go away (`pastDueInvoiceId` set, then null on a poll) and leaves a one-shot
 * flag; the Billing card reads and clears it. Per-viewer convenience storage, every access in try/catch.
 */
const KEY = "rf.billing.paid-notice";
const EVENT = "rf:billing-paid";

/** Call on every subscription read; flags a payment when the owed invoice just disappeared. */
export function usePaidTransition(view: SubscriptionView | null | undefined): void {
  const prev = React.useRef<string | null | undefined>(undefined);
  const owed = view ? (view.pastDueInvoiceId ?? null) : undefined;
  React.useEffect(() => {
    if (owed === undefined) return;
    if (prev.current && owed === null) {
      try {
        window.localStorage.setItem(KEY, "1");
      } catch {
        /* no storage: the notice is skipped, nothing else changes */
      }
      window.dispatchEvent(new Event(EVENT));
    }
    prev.current = owed;
  }, [owed]);
}

/** True once after a payment cleared; reading it consumes the flag so a reload never shows it twice. */
export function usePaidNotice(): [boolean, () => void] {
  const [show, setShow] = React.useState(false);
  React.useEffect(() => {
    const consume = () => {
      try {
        if (window.localStorage.getItem(KEY) === "1") {
          window.localStorage.removeItem(KEY);
          setShow(true);
        }
      } catch {
        /* storage unavailable */
      }
    };
    consume();
    window.addEventListener(EVENT, consume);
    return () => window.removeEventListener(EVENT, consume);
  }, []);
  return [show, () => setShow(false)];
}
