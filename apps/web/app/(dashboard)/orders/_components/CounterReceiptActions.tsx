"use client";

import * as React from "react";
import { Button } from "@routeflow/ui/web";
import type { CounterItemName } from "@routeflow/types";
import { staffMay } from "@routeflow/types";
import { receiptEmailPrefill } from "@/lib/email-receipt";
import { useOrder } from "@/lib/api/orders";
import { useOptionalAuth } from "@/lib/auth-context";
import { ReadOnlyHint, WriteButton } from "@/lib/read-only-gate";
import { CounterReturnAction } from "./CounterReturnAction";
import { CounterVoidSaleAction, CounterVoidSaleDialog } from "./CounterVoidSaleDialog";
import { EmailReceiptButton, EmailReceiptRow } from "./EmailReceipt";
import { useEmailReceipt } from "./useEmailReceipt";

/** The receipt's own controls: a full 44 px target with a visible keyboard focus ring. */
const RECEIPT_BTN = "min-h-[44px] min-w-[44px] focus-visible:ring-2 focus-visible:ring-navy";

/**
 * The live counter receipt's controls (SA-751r, W-715). On a phone the row is Print · More · New sale (the one primary, widest),
 * all in ONE row; Email receipt · Return items · Void sale sit behind More. From `sm` up every control is in the row, as before. The
 * Email receipt row opens under them. Its own component because the email state is a hook and the screen returns the receipt
 * early. A walk-in (`customer` null) opens the row empty; a named customer's address is the pre-fill, never an auto-send.
 *
 * W-716: Void sale opens the same void dialog Today's sales uses, for THIS sale (same role gate: `staffMay(role, "VOID_SALE")`,
 * disabled in a read-only workspace). After the void the receipt stays on screen and says so; the control reads Voided.
 * `methodsText` is how the sale was paid, already worded ("Cash + Card"); omit it and the dialog just does not show methods.
 */
export function CounterReceiptActions({
  orderId,
  customer,
  onNewSale,
  methodsText,
}: {
  orderId: string;
  customer: { email?: string | null; user?: { email?: string | null } | null } | null;
  onNewSale: () => void;
  methodsText?: string;
}) {
  const email = useEmailReceipt({ orderId, prefill: receiptEmailPrefill(customer) });
  const { data: order } = useOrder(orderId);
  const role = useOptionalAuth()?.user?.role;
  const [moreOpen, setMoreOpen] = React.useState(false);
  const [voidOpen, setVoidOpen] = React.useState(false);
  const [voided, setVoided] = React.useState(false);
  const items: CounterItemName[] = (order?.lineItems ?? [])
    .filter((l) => (l as { status?: string }).status !== "CANCELLED")
    .map((l) => ({ name: l.product?.name || l.name || "Item", qty: Number(l.qty) || 0 }));
  const canVoid = !!order && staffMay(role, "VOID_SALE");
  return (
    <>
      <div className="flex flex-wrap gap-2 print:hidden" data-testid="receipt-actions-main">
        {/* The DOM order IS the visual and Tab order at every width (Print · [More] · Email · Return · Void · New sale). On a
            phone only the opened More panel moves, below the one row. */}
        <Button className={RECEIPT_BTN} variant="secondary" onClick={() => window.print()}>
          Print
        </Button>
        <Button
          className={`${RECEIPT_BTN} sm:hidden`}
          variant="secondary"
          aria-expanded={moreOpen}
          aria-controls="receipt-actions-more"
          onClick={() => setMoreOpen((o) => !o)}
        >
          More
        </Button>
        <div
          id="receipt-actions-more"
          data-testid="receipt-actions-more"
          className={`${moreOpen ? "flex" : "hidden"} flex-wrap gap-2 max-sm:order-last max-sm:basis-full sm:contents`}
        >
          <EmailReceiptButton email={email} />
          <CounterReturnAction orderId={orderId} />
          {canVoid ? (
            voided ? (
              <Button className={RECEIPT_BTN} variant="secondary" disabled>
                Voided
              </Button>
            ) : (
              <CounterVoidSaleAction
                orderNumber={order.orderNumber}
                onOpen={() => setVoidOpen(true)}
              />
            )
          ) : null}
        </div>
        {/* SA-733r6: a new sale is a write; read-only keeps it visible and disabled. */}
        <WriteButton className={`${RECEIPT_BTN} max-sm:flex-1`} onClick={onNewSale}>
          New sale
        </WriteButton>
      </div>
      <ReadOnlyHint className="text-xs text-slate-600 print:hidden" />
      <EmailReceiptRow email={email} />
      {voided ? (
        <p role="status" className="text-sm font-medium text-navy" data-testid="receipt-voided">
          This sale was voided.
        </p>
      ) : null}
      {order && voidOpen ? (
        <CounterVoidSaleDialog
          open
          orderId={orderId}
          orderNumber={order.orderNumber}
          total={Number(order.total) || 0}
          methodsText={methodsText}
          items={items}
          itemCount={items.length}
          onClose={() => setVoidOpen(false)}
          onVoided={() => setVoided(true)}
        />
      ) : null}
    </>
  );
}
