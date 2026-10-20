import * as React from "react";
import { Lock } from "lucide-react";
import { DELIVERED_LINE_LOCK_HINT } from "@/lib/order-line-lock";

/**
 * B1234 (D-O2-a): what the edit builder shows in place of the controls of a DELIVERED line on a
 * PARTIALLY_DELIVERED order. The quantity is read-only text; the hint says why. The server refuses
 * any edit of such a line (409 LINE_ALREADY_DELIVERED), so no editing control is rendered.
 */
export function DeliveredLockedQty({ qty }: { qty: number }) {
  return (
    <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.06em] text-navy/40">
      Qty
      <span className="mono w-16 px-2 py-1 text-right text-sm normal-case tracking-normal text-navy">
        {qty}
      </span>
    </span>
  );
}

export function DeliveredLockedHint() {
  return (
    <p className="ml-11 mt-1 flex items-center gap-1.5 text-xs text-navy/70">
      <Lock className="h-3 w-3 shrink-0" aria-hidden="true" />
      {DELIVERED_LINE_LOCK_HINT}
    </p>
  );
}
