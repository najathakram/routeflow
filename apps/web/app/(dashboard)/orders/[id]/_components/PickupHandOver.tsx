"use client";

import * as React from "react";
import { Button } from "@routeflow/ui/web";
import { CheckCircle2 } from "lucide-react";
import type { Order } from "@/lib/api/orders";
import { PickupCompleteDialog } from "./PickupCompleteDialog";

/** The "Picked up" action of a PICKUP order (CONFIRMED or Ready for pickup) and the dialog it opens. */
export function PickupHandOver({ order }: { order: Order }) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button
        size="sm"
        leftIcon={<CheckCircle2 className="h-4 w-4" />}
        onClick={() => setOpen(true)}
      >
        Picked up
      </Button>
      <PickupCompleteDialog
        open={open}
        onClose={() => setOpen(false)}
        orderId={order.id}
        orderNumber={order.orderNumber}
        total={Number(order.total)}
        invoices={order.invoices ?? []}
        isWalkIn={order.customer?.isWalkIn === true}
      />
    </>
  );
}
