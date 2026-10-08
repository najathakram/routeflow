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
import {
  RecordInlineReturnDialog,
  type RecordedInfo,
} from "@/app/(dashboard)/returns/_components/RecordInlineReturnDialog";
import { handBackLine, REFUND_COPY } from "@/app/(dashboard)/returns/_components/refund-copy";
import { orderActionAccess } from "../[id]/order-action-access";

function money(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

/** Store credit stays on the account: this line must never tell the clerk to hand money back
 *  (that would give the value twice). Only the refund path says "Hand $X back". */
function storeCreditLine(amount: number | undefined, customer: string | null | undefined): string {
  const who = customer?.trim() || "the customer's account";
  return amount !== undefined
    ? `Return recorded. Store credit of ${money(amount)} added to ${who}.`
    : `Return recorded. Store credit added to ${who}.`;
}

export function CounterReturnAction({
  orderId,
  onDone,
}: {
  orderId: string;
  /** called when the return dialog closes or records (Today's sales refetches its list) */
  onDone?: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [recorded, setRecorded] = React.useState<RecordedInfo | null>(null);
  const hasInlineReturns = useHasAddon(ORDERS_INLINE_RETURNS_ADDON);
  const role = useOptionalAuth()?.user?.role;
  const staff = orderActionAccess(role, "", false).staff;
  const { data: order } = useOrder(orderId);
  if (!hasInlineReturns || !staff || !order) return null;

  return (
    <>
      <Button
        variant="secondary"
        className="min-h-11 w-full sm:w-auto"
        leftIcon={<RotateCcw className="h-3.5 w-3.5" />}
        onClick={() => setOpen(true)}
      >
        Return items
      </Button>
      <RecordInlineReturnDialog
        open={open}
        onClose={() => {
          setOpen(false);
          onDone?.();
        }}
        customerId={order.customerId}
        customerName={order.customer?.businessName}
        orderId={order.id}
        allowRefund
        onRecorded={(_ret, info) => {
          setRecorded(info ?? { resolution: "STORE_CREDIT" });
          onDone?.();
        }}
      />
      {recorded ? (
        <p role="status" className="order-last basis-full text-sm font-medium text-navy">
          {recorded.pending
            ? REFUND_COPY.pendingReceipt
            : recorded.resolution === "REFUND" && recorded.tender && recorded.amount !== undefined
              ? `Return recorded. ${handBackLine(recorded.tender, money(recorded.amount))}`
              : storeCreditLine(recorded.amount, order.customer?.businessName)}
        </p>
      ) : null}
    </>
  );
}
