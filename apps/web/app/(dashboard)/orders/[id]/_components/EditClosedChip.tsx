import * as React from "react";
import { useOrderStatusLabel } from "@/components/OrderStatusBadge";

/**
 * P5-08 / R1: staff editing closes only once the order is CANCELLED ("STATUS"); the buyer-facing window instead closes
 * once dispatched ("DISPATCHED"). Either reason shows as this one chip. The page decides WHEN to show it (`show`); the
 * words come from the order's own edit window.
 */
export function EditClosedChip({
  show,
  order,
}: {
  show: boolean;
  order?: {
    fulfillPath?: string | null;
    editWindow?: { closedReason?: string | null } | null;
  } | null;
}) {
  const statusLabel = useOrderStatusLabel();
  const reason = order?.editWindow?.closedReason;
  if (!show || !reason) return null;
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-1 text-xs font-medium text-amber-700 ring-1 ring-amber-200">
      {reason === "DISPATCHED"
        ? `${statusLabel("OUT_FOR_DELIVERY", "Out for delivery", order?.fulfillPath)} — editing closed`
        : "Order cancelled — editing closed"}
    </span>
  );
}
