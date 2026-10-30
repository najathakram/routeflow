"use client";

import * as React from "react";
import { Button } from "@routeflow/ui/web";
import type { CounterItemName } from "@routeflow/types";
import { staffMay } from "@routeflow/types";
import { receiptEmailPrefill } from "@/lib/email-receipt";
import { useOrder } from "@/lib/api/orders";
import { useOptionalAuth } from "@/lib/auth-context";
import { useCounterSaleRow } from "@/lib/api/counter-sale-today";
import { ReadOnlyHint, useReadOnlyGate, WriteButton } from "@/lib/read-only-gate";
import { usePrintInvoice } from "@/lib/use-print-invoice";
import { CounterReturnAction } from "./CounterReturnAction";
import { CounterVoidSaleAction, CounterVoidSaleDialog } from "./CounterVoidSaleDialog";
import { EmailReceiptButton, EmailReceiptRow } from "./EmailReceipt";
import { METHOD_LABEL } from "./HandOverRows";
import { useEmailReceipt } from "./useEmailReceipt";

/** The receipt's own controls: a full 44 px target with a visible keyboard focus ring. */
const RECEIPT_BTN = "min-h-[44px] min-w-[44px] focus-visible:ring-2 focus-visible:ring-navy";

/**
 * The live counter receipt's controls (SA-751r, W-715, P-RCPT-1): Print · Email receipt · Return items · Void sale · New sale.
 * From `sm` up they sit in ONE row; at phone width they form a 2×2 grid with New sale (the one primary) full width under it.
 * The Email receipt row opens under them. Its own component because the email state is a hook and the screen returns the
 * receipt early. A walk-in (`customer` null) opens the row empty; a named customer's address is the pre-fill, never an
 * auto-send.
 *
 * W-716: Void sale opens the same void dialog Today's sales uses, for THIS sale (same role gate: `staffMay(role, "VOID_SALE", [])`,
 * disabled in a read-only workspace). After the void the receipt stays on screen and says so; the control reads Voided.
 * The dialog's methods line comes from the sale's own Today's-sales row (the order read carries no tender), worded as that sheet
 * words it ("Cash + Card", "On account" when nothing was paid); a passed `methodsText` wins. The same row says whether the sale is
 * already voided or has a return recorded: Void sale shows only in the state Today's sales shows it (not voided, no return),
 * a voided sale reads Voided, and Return items goes once the sale is voided.
 */
export function CounterReceiptActions({
  orderId,
  invoiceIds,
  customer,
  onNewSale,
  methodsText,
}: {
  orderId: string;
  /** SA-1026 B: every invoice the sale made (a mixed sale has siblings); with them, "Print invoice" prints the same Letter PDF the invoice page does, one per invoice. */
  invoiceIds?: readonly string[];
  customer: { email?: string | null; user?: { email?: string | null } | null } | null;
  onNewSale: () => void;
  methodsText?: string;
}) {
  const email = useEmailReceipt({ orderId, prefill: receiptEmailPrefill(customer) });
  const { data: order } = useOrder(orderId);
  const { row, isPending: rowPending } = useCounterSaleRow(orderId);
  const gate = useReadOnlyGate();
  const role = useOptionalAuth()?.user?.role;
  const [voidOpen, setVoidOpen] = React.useState(false);
  const [voided, setVoided] = React.useState(false);
  const items: CounterItemName[] = (order?.lineItems ?? [])
    .filter((l) => (l as { status?: string }).status !== "CANCELLED")
    .map((l) => ({ name: l.product?.name || l.name || "Item", qty: Number(l.qty) || 0 }));
  const [returnedHere, setReturnedHere] = React.useState(false);
  const voidedNow = voided || order?.status === "CANCELLED" || !!row?.voided;
  const hasReturn = returnedHere || (!!row && row.returned.state !== "NONE");
  const methods =
    methodsText ??
    (row
      ? row.methods.length > 0
        ? row.methods.map((m) => METHOD_LABEL[m.method]).join(" + ")
        : "On account"
      : undefined);
  // wait for the row (voided / returned / how it was paid) before offering Void; a failed read falls back to the order alone
  const canVoid = !!order && staffMay(role, "VOID_SALE", []) && !rowPending;
  const printInvoice = usePrintInvoice();
  return (
    <>
      {/* W-715 + P-RCPT-1 (lead ruling): ONE row from sm up; at phone width a 2×2 grid with New sale, the one primary, full
          width under it. Every action stays visible, and the DOM order is the visual and Tab order at every width. */}
      <div
        className="grid grid-cols-2 gap-2 print:hidden sm:flex sm:flex-wrap"
        data-testid="receipt-actions-main"
      >
        <Button className={RECEIPT_BTN} variant="secondary" onClick={() => window.print()}>
          Print
        </Button>
        {invoiceIds?.length ? (
          <Button
            className={RECEIPT_BTN}
            variant="secondary"
            disabled={printInvoice.printing}
            onClick={() => void printInvoice.print(invoiceIds)}
          >
            Print invoice
          </Button>
        ) : null}
        <EmailReceiptButton email={email} />
        <CounterReturnAction
          orderId={orderId}
          canReturn={!voidedNow}
          onRecorded={() => setReturnedHere(true)}
        />
        {canVoid && (voidedNow || !hasReturn) ? (
          voidedNow ? (
            <Button className={RECEIPT_BTN} variant="secondary" disabled>
              Voided
            </Button>
          ) : (
            <CounterVoidSaleAction
              orderNumber={order.orderNumber}
              onOpen={() => setVoidOpen(true)}
              describedBy={gate.hintId}
            />
          )
        ) : null}
        {/* SA-733r6: a new sale is a write; read-only keeps it visible and disabled. */}
        <WriteButton className={`${RECEIPT_BTN} col-span-2`} onClick={onNewSale}>
          New sale
        </WriteButton>
      </div>
      <ReadOnlyHint className="text-xs text-slate-600 print:hidden" />
      <EmailReceiptRow email={email} />
      {voidedNow ? (
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
          methodsText={methods}
          items={items}
          itemCount={items.length}
          onClose={() => setVoidOpen(false)}
          onVoided={() => setVoided(true)}
        />
      ) : null}
    </>
  );
}
