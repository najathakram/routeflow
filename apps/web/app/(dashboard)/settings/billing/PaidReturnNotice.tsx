"use client";

import * as React from "react";
import { CheckCircle2 } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { Button } from "@routeflow/ui/web";

/**
 * Row 542: Stripe sends an admin back to `/settings/billing?paid=1` after paying the amount due. A plain, dismissible
 * notice; the shell hides the payment-due banner while `?paid=1` is present (the payment can still be processing).
 * SA-801: a card add (nothing charged) returns with `&card=1` and must never say "Payment received".
 */
export function PaidReturnNotice() {
  const params = useSearchParams();
  const [hidden, setHidden] = React.useState(false);
  if (hidden || params?.get("paid") !== "1") return null;
  const cardAdded = params?.get("card") === "1";
  return (
    <div
      role="status"
      className="flex items-center justify-between gap-2 rounded-lg bg-emerald-50 px-4 py-3 text-sm text-emerald-900 ring-1 ring-emerald-200"
    >
      <span className="flex items-center gap-2">
        <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
        {cardAdded
          ? "Card added. It can take a few minutes to confirm."
          : "Payment received. It can take a few minutes to confirm."}
      </span>
      <Button size="sm" variant="ghost" onClick={() => setHidden(true)}>
        OK
      </Button>
    </div>
  );
}
