"use client";

import * as React from "react";
import { useToast } from "@routeflow/ui/web";
import { ShipmentCard } from "@/components/ShipmentCard";
import { genericToastCopy } from "@/lib/generic-toast-copy";
import { useMessagingConfig } from "@/lib/api/messaging";
import { shipWithTracking } from "@/lib/ship-with-tracking";
import type { Order, useUpdateOrderShipment } from "@/lib/api/orders";
import { ShipWithTrackingDialog } from "../ShipWithTrackingDialog";

/**
 * The carrier-shipment pair of the order page: the "Mark shipped" tracking dialog (staff, SHIP orders) and the
 * Shipment card. Moved out of page.tsx (size ratchet) so the page can place the card above Summary on a SHIP
 * order (M8) and below it on the historical rows that merely carry tracking data. Renders nothing for an
 * order that is neither SHIP nor carries tracking.
 */
export function showsShipment(
  order: Pick<Order, "fulfillPath" | "shippingCarrier" | "shippingTrackingNumber">,
): boolean {
  return !!(order.fulfillPath === "SHIP" || order.shippingCarrier || order.shippingTrackingNumber);
}

export function OrderShipmentSection({
  order,
  status,
  staff,
  canEditShipment,
  dialogOpen,
  onDialogClose,
  updateShipment,
  statusPending,
  onShip,
}: {
  order: Order;
  /** The page's current (local) status: the badge's source, so the card agrees with it. */
  status: string;
  staff: boolean;
  canEditShipment: boolean;
  dialogOpen: boolean;
  onDialogClose: () => void;
  updateShipment: ReturnType<typeof useUpdateOrderShipment>;
  statusPending: boolean;
  /** Marks the order shipped (the status call); the dialog saves the tracking first. */
  onShip: () => void;
}) {
  const { toast } = useToast();
  // The "customer is told" line is true only while the order-shipped notification is on for the account
  // (an enabled, available channel). Staff read it; anyone else (or while it loads) gets no claim.
  const { data: messaging } = useMessagingConfig({ enabled: staff && showsShipment(order) });
  const customerNotified = !!messaging?.events
    ?.find((e) => e.eventKey === "ORDER_SHIPPED")
    ?.channels.some((c) => c.enabled && !c.unavailable);
  return (
    <>
      {order.fulfillPath === "SHIP" && staff && (
        <ShipWithTrackingDialog
          open={dialogOpen}
          onClose={onDialogClose}
          isPending={updateShipment.isPending || statusPending}
          initialCarrier={order.shippingCarrier}
          initialTracking={order.shippingTrackingNumber}
          onSkip={onShip}
          onShipWithTracking={(values) =>
            shipWithTracking(
              {
                saveShipment: (v) =>
                  updateShipment.mutateAsync({ id: order.id, ...v }).catch((e: unknown) => {
                    toast({
                      title: "Could not save shipment",
                      description: genericToastCopy(e),
                      variant: "error",
                    });
                    throw e;
                  }),
                ship: onShip,
              },
              values,
            )
          }
        />
      )}
      {showsShipment(order) && (
        <ShipmentCard
          carrier={order.shippingCarrier}
          trackingNumber={order.shippingTrackingNumber}
          shippedAt={order.shippedAt}
          orderStatus={status}
          fulfillPath={order.fulfillPath}
          customerNotified={customerNotified}
          isSaving={updateShipment.isPending}
          onSave={(values) => updateShipment.mutateAsync({ id: order.id, ...values })}
          readOnly={!canEditShipment}
        />
      )}
    </>
  );
}
