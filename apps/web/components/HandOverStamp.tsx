import * as React from "react";
import {
  handOverStampLine,
  isHandedOver,
  seesHandOverStamp,
  type HandOverStampSource,
} from "@/lib/handover-stamp";

/**
 * Row 342: the quiet "Handed over by Pat · main · time" line of the staff order / invoice header. Staff pages only: it
 * renders nothing for a buyer session (and the buyer's read carries no stamp), nor for an order that was not handed over.
 */
export function HandOverStamp({
  order,
  role,
  timeZone,
}: {
  order: HandOverStampSource & {
    status?: string | null;
    fulfillPath?: string | null;
    counterSale?: boolean | null;
  };
  /** the session's role: only staff see it (a buyer, a driver or no session sees nothing) */
  role: string | null | undefined;
  /** the business's IANA zone for the time; undefined while it loads (the line then carries no time) */
  timeZone?: string | null;
}) {
  if (!seesHandOverStamp(role) || !isHandedOver(order)) return null;
  const line = handOverStampLine(order, timeZone);
  if (!line) return null;
  return (
    <p className="min-w-0 break-words text-sm text-navy/70" data-testid="hand-over-stamp">
      {line}
    </p>
  );
}
