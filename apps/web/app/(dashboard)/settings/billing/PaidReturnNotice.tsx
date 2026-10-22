"use client";

import * as React from "react";
import { CheckCircle2, Clock } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { Button } from "@routeflow/ui/web";
import { useSubscription } from "@/lib/api/billing";

type Outcome = "processing" | "received" | "failed" | "checking";

/** B1256: only the server's own billing state decides the wording; a bank debit still settling is never "received". */
function outcomeOf(
  sub:
    | { billingState?: string; paymentProcessing?: boolean; pastDueInvoiceId?: string | null }
    | undefined,
): Outcome {
  if (!sub) return "checking";
  if (sub.paymentProcessing === true || sub.billingState === "processing") return "processing";
  if (sub.billingState === "current") return "received";
  if (sub.billingState === "overdue" && sub.pastDueInvoiceId) return "failed";
  return "checking";
}

const COPY: Record<Outcome, string> = {
  processing: "Your payment is processing. Your bank hasn't cleared it yet.",
  received: "Payment received.",
  failed: "Your last payment didn't go through.",
  checking: "Checking your payment. This can take a few minutes.",
};

/**
 * Row 542: Stripe sends an admin back to `/settings/billing?paid=1` after paying the amount due. A plain, dismissible
 * notice; the shell hides the payment-due banner while `?paid=1` is present (the payment can still be processing).
 * SA-801: a card add (nothing charged) returns with `&card=1` and must never say "Payment received".
 * B1256 / Row 623: the wording follows the subscription's server-derived billing state (processing, received, failed,
 * or neutral while it loads), re-read every 15 s until it settles.
 */
export function PaidReturnNotice() {
  const params = useSearchParams();
  const [hidden, setHidden] = React.useState(false);
  const { data } = useSubscription({
    refetchInterval: (q) => {
      const o = outcomeOf(q.state.data);
      return o === "processing" || o === "checking" ? 15_000 : false;
    },
  });
  if (hidden || params?.get("paid") !== "1") return null;
  const cardAdded = params?.get("card") === "1";
  const outcome = outcomeOf(data);
  const bad = !cardAdded && outcome === "failed";
  const wait = !cardAdded && (outcome === "processing" || outcome === "checking");
  const Icon = wait ? Clock : CheckCircle2;
  return (
    <div
      role="status"
      className={
        bad
          ? "flex items-center justify-between gap-2 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700 ring-1 ring-red-200"
          : "flex items-center justify-between gap-2 rounded-lg bg-emerald-50 px-4 py-3 text-sm text-emerald-900 ring-1 ring-emerald-200"
      }
    >
      <span className="flex items-center gap-2">
        <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
        {cardAdded ? "Card added. It can take a few minutes to confirm." : COPY[outcome]}
      </span>
      <Button size="sm" variant="ghost" onClick={() => setHidden(true)}>
        OK
      </Button>
    </div>
  );
}
