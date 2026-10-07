"use client";

// POS-4: the counter-sale receipt's "Return items" entry point. Own file so CounterSaleScreen
// takes one mount line. Same gates as order detail's "Record return": the orders_inline_returns
// add-on + orderActionAccess(...).staff. Hidden (not disabled) until the sale's order is loaded.
import * as React from "react";
import { RotateCcw } from "lucide-react";
import { Button } from "@routeflow/ui/web";
import { useHasAddon } from "@/lib/api/tobacco";
import { ORDERS_INLINE_RETURNS_ADDON } from "@/lib/api/addons";
import { useOrder } from "@/lib/api/orders";
import { useOptionalAuth } from "@/lib/auth-context";
import { RecordInlineReturnDialog } from "@/app/(dashboard)/returns/_components/RecordInlineReturnDialog";
import { orderActionAccess } from "../[id]/order-action-access";

export function CounterReturnAction({ orderId }: { orderId: string }) {
  const [open, setOpen] = React.useState(false);
  const [recorded, setRecorded] = React.useState(false);
  const hasInlineReturns = useHasAddon(ORDERS_INLINE_RETURNS_ADDON);
  const role = useOptionalAuth()?.user?.role;
  const staff = orderActionAccess(role, "", false).staff;
  const { data: order } = useOrder(orderId);
  if (!hasInlineReturns || !staff || !order) return null;

  return (
    <>
      <Button
        variant="secondary"
        leftIcon={<RotateCcw className="h-3.5 w-3.5" />}
        onClick={() => setOpen(true)}
      >
        Return items
      </Button>
      <RecordInlineReturnDialog
        open={open}
        onClose={() => setOpen(false)}
        customerId={order.customerId}
        customerName={order.customer?.businessName}
        orderId={order.id}
        onRecorded={() => setRecorded(true)}
      />
      {recorded ? (
        <p role="status" className="basis-full text-sm font-medium text-navy">
          Return recorded. Stock is back and a credit note was issued. Hand the refund to the
          customer yourself.
        </p>
      ) : null}
    </>
  );
}
