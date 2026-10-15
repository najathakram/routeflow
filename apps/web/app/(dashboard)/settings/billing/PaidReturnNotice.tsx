"use client";

import * as React from "react";
import { CheckCircle2 } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { Button } from "@routeflow/ui/web";

/**
 * Row 542: Stripe sends an admin back to `/settings/billing?paid=1` after paying the amount due. A plain, dismissible
 * notice; it says nothing about state (the banner clears from the server's own read).
 */
export function PaidReturnNotice() {
  const params = useSearchParams();
  const [hidden, setHidden] = React.useState(false);
  if (hidden || params?.get("paid") !== "1") return null;
  return (
    <div
      role="status"
      className="flex items-center justify-between gap-2 rounded-lg bg-emerald-50 px-4 py-3 text-sm text-emerald-900 ring-1 ring-emerald-200"
    >
      <span className="flex items-center gap-2">
        <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
        Payment received. Thank you.
      </span>
      <Button size="sm" variant="ghost" onClick={() => setHidden(true)}>
        OK
      </Button>
    </div>
  );
}
