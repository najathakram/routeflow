"use client";

import * as React from "react";
import { Badge, type BadgeStatus } from "@routeflow/ui/web";
import { useFulfilmentCaps, useOrderStatusLabel } from "@/lib/fulfilment-caps";

export { useFulfilmentCaps, useOrderStatusLabel };

/** `<Badge status>` for an ORDER status on a staff screen. The word comes from the shared fulfilment
 *  table: per order when `fulfillPath` is given (SHIP "Shipped", PICKUP "Ready for pickup"), else the
 *  account's default method. ROUTE / unset accounts render exactly as `<Badge status={status} />`. */
export function OrderStatusBadge({
  status,
  fulfillPath,
}: {
  status: BadgeStatus | string;
  fulfillPath?: string | null;
}) {
  const label = useOrderStatusLabel();
  const word = label(String(status), "", fulfillPath);
  return <Badge status={status as BadgeStatus} label={word || undefined} />;
}
