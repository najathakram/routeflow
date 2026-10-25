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
import { useReadOnlyGate } from "@/lib/read-only-gate";
import {
  RecordInlineReturnDialog,
  type RecordedInfo,
} from "@/app/(dashboard)/returns/_components/RecordInlineReturnDialog";
import {
  handOverLine,
  REFUND_COPY,
  refundedLine,
  storeCreditAddedLine,
} from "@/app/(dashboard)/returns/_components/refund-copy";
import { orderActionAccess } from "../[id]/order-action-access";

function money(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

/** Store credit stays on the account: this line must never tell the clerk to hand money back
 *  (that would give the value twice). Only the refund path says to hand it back. (A walk-in return is never
 *  store credit: the dialog refuses it, SA-959.) */
function storeCreditLine(amount: number | undefined, customer: string | null | undefined): string {
  const who = customer?.trim() || "the customer";
  return amount !== undefined
    ? `Return recorded. ${storeCreditAddedLine(money(amount)).replace(/\.$/, "")} for ${who}.`
    : `Return recorded. Store credit added for ${who}.`;
}

/** SA-929: the words come from what the server recorded (RecordedInfo is read off its answer). */
function recordedLine(recorded: RecordedInfo, customer: string | null | undefined): string {
  if (recorded.pending) return REFUND_COPY.pendingReceipt;
  if (recorded.resolution === "REFUND" && recorded.amount !== undefined) {
    const hand = recorded.tender ? ` ${handOverLine(recorded.tender)}` : "";
    return `Return recorded. ${refundedLine(recorded.tender, money(recorded.amount))}${hand}`;
  }
  return storeCreditLine(recorded.amount, customer);
}

export function CounterReturnAction({
  orderId,
  onDone,
  canReturn = true,
}: {
  orderId: string;
  /** false hides the Return items button (a fully returned sale) once the dialog is closed, WITHOUT
   *  unmounting, so a success line shown after a whole-sale return survives the refetch */
  canReturn?: boolean;
  /** called when the return dialog closes or records (Today's sales refetches its list) */
  onDone?: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  // the line lands at the foot of a scrolling sheet: bring it into view so the confirmation is never below the fold
  const statusRef = React.useRef<HTMLParagraphElement>(null);
  const buttonRef = React.useRef<HTMLButtonElement>(null);
  const [recorded, setRecorded] = React.useState<RecordedInfo | null>(null);
  React.useEffect(() => {
    if (recorded) statusRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [recorded]);
  // the sheet re-lays out when the return dialog closes (its list refetches), which can push the line's second row
  // below the fold again: scroll once more, after that layout, to the foot of the sheet
  React.useEffect(() => {
    if (!recorded || open) return;
    const frame = requestAnimationFrame(() =>
      statusRef.current?.scrollIntoView?.({ block: "end" }),
    );
    return () => cancelAnimationFrame(frame);
  }, [recorded, open]);
  const hasInlineReturns = useHasAddon(ORDERS_INLINE_RETURNS_ADDON);
  const role = useOptionalAuth()?.user?.role;
  const staff = orderActionAccess(role, "", false).staff;
  const { data: order } = useOrder(orderId);
  // A return is a new transaction: in a READ-ONLY workspace the control is disabled up front with the one shared
  // read-only line (as Complete and Void sale are), so the clerk is not walked through the dialog before a refusal.
  const gate = useReadOnlyGate();
  if (!hasInlineReturns || !staff || !order) return null;

  const showButton = canReturn || open;
  return (
    <>
      {showButton ? (
        <Button
          ref={buttonRef}
          variant="secondary"
          className="min-h-11 w-full sm:w-auto"
          leftIcon={<RotateCcw className="h-3.5 w-3.5" />}
          disabled={gate.readOnly}
          aria-describedby={gate.readOnly ? gate.hintId : undefined}
          title={gate.readOnly ? (gate.line ?? undefined) : undefined}
          onClick={() => {
            if (!gate.readOnly) setOpen(true);
          }}
        >
          Return items
        </Button>
      ) : null}
      <RecordInlineReturnDialog
        open={open}
        onClose={() => {
          setOpen(false);
          onDone?.();
        }}
        customerId={order.customerId}
        customerName={order.customer?.businessName}
        orderId={order.id}
        // SA-740: a counter return is from THIS sale; the walk-in is one shared customer, so the server pins the match to it
        sourceOrderId={order.id}
        allowRefund
        onCloseAutoFocus={(e) => {
          // no Radix trigger opened the dialog: put focus back on the button that did
          if (!buttonRef.current) return;
          e.preventDefault();
          buttonRef.current.focus();
        }}
        onRecorded={(_ret, info) => {
          setRecorded(info ?? { resolution: "STORE_CREDIT" });
          onDone?.();
        }}
      />
      {recorded ? (
        <p
          ref={statusRef}
          role="status"
          className="order-last basis-full text-sm font-medium text-navy"
        >
          {recordedLine(recorded, order.customer?.businessName)}
        </p>
      ) : null}
    </>
  );
}
