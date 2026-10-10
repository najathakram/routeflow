import * as React from "react";
import type { SubscriptionView } from "@routeflow/types";

/**
 * SA-733r6 (B4): "You're all set. Thanks for your payment." shows ONCE on the Billing card after a payment clears.
 * The shell notices the owed invoice go away (`pastDueInvoiceId` set, then null on a poll) and leaves a one-shot
 * flag; the Billing card reads and clears it. Per-viewer convenience storage, every access in try/catch.
 */
const KEY = "rf.billing.paid-notice";
const OWED_KEY = "rf.billing.owed-invoice";
const EVENT = "rf:billing-paid";

/**
 * Call on every subscription read. The owed invoice is REMEMBERED in storage while it exists; the first read that
 * shows it gone flags the payment - so it also works when the admin paid in Stripe and came back through a full page
 * load (an in-memory "previous value" would be lost with the page).
 */
export function usePaidTransition(view: SubscriptionView | null | undefined): void {
  const owed = view ? (view.pastDueInvoiceId ?? null) : undefined;
  React.useEffect(() => {
    if (owed === undefined) return;
    try {
      if (owed) {
        window.localStorage.setItem(OWED_KEY, owed);
        return;
      }
      if (window.localStorage.getItem(OWED_KEY)) {
        window.localStorage.removeItem(OWED_KEY);
        window.localStorage.setItem(KEY, "1");
        window.dispatchEvent(new Event(EVENT));
      }
    } catch {
      /* no storage: the notice is skipped, nothing else changes */
    }
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
