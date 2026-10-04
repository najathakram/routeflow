"use client";

import * as React from "react";
import { Badge, type BadgeStatus } from "@routeflow/ui/web";
import { useShipMode } from "@/lib/ship-mode";
import { orderStatusLabelOverride, orderStatusText } from "@/lib/order-status-label";

export { useShipMode };

/** Plain-text status label for the current account: `(status, normalLabel) => label` (Shipped in SHIP mode). */
export function useOrderStatusText() {
  const ship = useShipMode();
  return (status: string, normalLabel: string) => orderStatusText(status, ship, normalLabel);
}

/** `<Badge status>` for an ORDER status on a staff screen: an account in SHIP mode sees "Shipped" for
 *  OUT_FOR_DELIVERY (display only). Anything else renders exactly as `<Badge status={status} />`. */
export function OrderStatusBadge({
  status,
  label,
}: {
  status: BadgeStatus | string;
  /** The caller's own label, when it already passes one (kept unless the fleet-off override applies). */
  label?: string;
}) {
  const ship = useShipMode();
  return (
    <Badge
      status={status as BadgeStatus}
      label={orderStatusLabelOverride(String(status), ship) ?? label}
    />
  );
}
