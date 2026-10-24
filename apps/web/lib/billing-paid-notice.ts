import * as React from "react";
import type { SubscriptionView } from "@routeflow/types";

/**
 * SA-733r6 (B4): "You're all set. Thanks for your payment." shows ONCE on the Billing card after a payment clears.
 *
 * The owed invoice is REMEMBERED in storage while it exists (so it also works when the admin paid in Stripe and came
 * back through a full page load), keyed by WORKSPACE and invoice id: tenant A's memory can never produce a notice in
 * tenant B.
 *
 * "The marker disappeared" is not proof of payment (a void or write-off clears it too). Without a server-provided
 * "last paid invoice" the proof is: the remembered invoice had a KNOWN amount > 0 (only an admin's view carries it),
 * and the fresh read shows the marker cleared AND the workspace back to ACTIVE. A clear that leaves the workspace
 * read-only (a void on a paused workspace, a cancel) never says "thanks for your payment". Residual: a staff void of
 * an owed invoice on a workspace that was never paused (ACTIVE) is indistinguishable from a payment until the API
 * sends `lastPaidInvoiceId`.
 *
 * Per-viewer convenience storage, every access in try/catch.
 */
const owedKey = (scope: string) => `rf.billing.owed-invoice.${scope}`;
const paidKey = (scope: string) => `rf.billing.paid-notice.${scope}`;
const EVENT = "rf:billing-paid";

/** Call on every subscription read. `scope` is the workspace (tenant slug); null = not resolved yet, do nothing. */
export function usePaidTransition(
  view: SubscriptionView | null | undefined,
  scope: string | null,
): void {
  const owed = view ? (view.pastDueInvoiceId ?? null) : undefined;
  const amount = view?.openInvoiceAmount ?? null;
  const status = view?.status;
  React.useEffect(() => {
    if (owed === undefined || !scope) return;
    try {
      if (owed) {
        // Remember only what can later prove a payment: an owed amount we actually know (> 0).
        if (amount !== null && amount > 0) {
          window.localStorage.setItem(owedKey(scope), JSON.stringify({ invoice: owed, amount }));
        }
        return;
      }
      const raw = window.localStorage.getItem(owedKey(scope));
      if (!raw) return;
      window.localStorage.removeItem(owedKey(scope));
      const remembered = JSON.parse(raw) as { invoice?: string; amount?: number };
      if (remembered.invoice && (remembered.amount ?? 0) > 0 && status === "ACTIVE") {
        window.localStorage.setItem(paidKey(scope), "1");
        window.dispatchEvent(new Event(EVENT));
      }
    } catch {
      /* no storage: the notice is skipped, nothing else changes */
    }
  }, [owed, amount, status, scope]);
}

/** True once after a payment cleared in this workspace; reading it consumes the flag so a reload never shows it twice. */
export function usePaidNotice(scope: string | null): [boolean, () => void] {
  const [show, setShow] = React.useState(false);
  React.useEffect(() => {
    if (!scope) return;
    const consume = () => {
      try {
        if (window.localStorage.getItem(paidKey(scope)) === "1") {
          window.localStorage.removeItem(paidKey(scope));
          setShow(true);
        }
      } catch {
        /* storage unavailable */
      }
    };
    consume();
    window.addEventListener(EVENT, consume);
    return () => window.removeEventListener(EVENT, consume);
  }, [scope]);
  return [show, () => setShow(false)];
}
