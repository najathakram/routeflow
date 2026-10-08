"use client";

// Extracted so the two entry-point pages (order detail, customer detail) each add just an
// import + one render call — apps/web/app/(dashboard)/customers/[id]/page.tsx is pinned by
// common/size-ratchet.spec.ts and had no headroom left for the button/state/dialog wiring
// inlined there.
import * as React from "react";
import { RotateCcw } from "lucide-react";
import { Button } from "@routeflow/ui/web";
import { useHasAddon } from "@/lib/api/tobacco";
import { ORDERS_INLINE_RETURNS_ADDON } from "@/lib/api/addons";
import { RecordInlineReturnDialog } from "./RecordInlineReturnDialog";

export interface RecordReturnActionProps {
  customerId: string;
  customerName?: string;
  /** Pre-fills Step 1 to this order's line items and carries the credit — omit to show the
   *  dialog's own order picker (customer-detail entry). */
  orderId?: string;
  size?: "sm" | "md" | "lg";
  /** POS-4b: offer refund-vs-store-credit in the dialog (order detail only; customer detail omits it). */
  allowRefund?: boolean;
}

/** Renders nothing when the tenant lacks the orders_inline_returns add-on. */
export function RecordReturnAction({
  customerId,
  customerName,
  orderId,
  size = "sm",
  allowRefund = false,
}: RecordReturnActionProps) {
  const [open, setOpen] = React.useState(false);
  const hasInlineReturns = useHasAddon(ORDERS_INLINE_RETURNS_ADDON);
  if (!hasInlineReturns) return null;

  return (
    <>
      <Button
        variant="secondary"
        size={size}
        leftIcon={<RotateCcw className="h-3.5 w-3.5" />}
        onClick={() => setOpen(true)}
      >
        Record return
      </Button>
      <RecordInlineReturnDialog
        open={open}
        onClose={() => setOpen(false)}
        customerId={customerId}
        customerName={customerName}
        orderId={orderId}
        allowRefund={allowRefund}
      />
    </>
  );
}
