"use client";

import * as React from "react";
import { Button } from "@routeflow/ui/web";
import { CheckCircle2 } from "lucide-react";
import type { Order } from "@/lib/api/orders";
import { useOptionalAuth } from "@/lib/auth-context";
import { heldPickupStoreKey } from "@/lib/counter-sale";
import { PickupCompleteDialog, type HeldPickupKey } from "./PickupCompleteDialog";

/**
 * The "Picked up" action of a PICKUP order (CONFIRMED or Ready for pickup). The button lives in the status-gated
 * action rows, but the DIALOG (`PickupHandOverDialog`) is mounted by the page OUTSIDE them: completing the pickup
 * refetches the order as DELIVERED, which unmounts those rows, and the dialog's result (cash change, "Payment not
 * recorded" + Retry) must outlive that.
 */
export function PickupHandOverButton({ onOpen }: { onOpen: () => void }) {
  return (
    <Button size="sm" leftIcon={<CheckCircle2 className="h-4 w-4" />} onClick={onOpen}>
      Picked up
    </Button>
  );
}

export function PickupHandOverDialog({
  order,
  open,
  onClose,
}: {
  order: Order;
  open: boolean;
  onClose: () => void;
}) {
  // An UNKNOWN outcome's key outlives the dialog's close/reopen (cleared only on a known outcome).
  const heldKey = React.useRef<HeldPickupKey>(null);
  const authUser = useOptionalAuth()?.user;
  const storeKey = heldPickupStoreKey(authUser?.tenantSlug, authUser?.id, order.id);
  return (
    <PickupCompleteDialog
      heldKey={heldKey}
      storeKey={storeKey}
      open={open}
      onClose={onClose}
      orderId={order.id}
      orderNumber={order.orderNumber}
      total={Number(order.total)}
      invoices={order.invoices ?? []}
      isWalkIn={order.customer?.isWalkIn === true}
    />
  );
}
