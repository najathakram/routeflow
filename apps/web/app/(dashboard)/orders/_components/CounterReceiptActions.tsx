"use client";

import * as React from "react";
import { Button } from "@routeflow/ui/web";
import { receiptEmailPrefill } from "@/lib/email-receipt";
import { CounterReturnAction } from "./CounterReturnAction";
import { EmailReceiptButton, EmailReceiptRow } from "./EmailReceipt";
import { useEmailReceipt } from "./useEmailReceipt";

/** The receipt's own controls: a full 44 px target with a visible keyboard focus ring. */
const RECEIPT_BTN = "min-h-[44px] min-w-[44px] focus-visible:ring-2 focus-visible:ring-navy";

/**
 * The live counter receipt's button row: Print (the one primary) · Email receipt · Return items · New sale, with the Email
 * receipt row under it when opened (SA-751r). Its own component because the email state is a hook and the screen returns the
 * receipt early. A walk-in (`customer` null) opens the row empty; a named customer's address is the pre-fill, never an auto-send.
 */
export function CounterReceiptActions({
  orderId,
  customer,
  onNewSale,
}: {
  orderId: string;
  customer: { email?: string | null; user?: { email?: string | null } | null } | null;
  onNewSale: () => void;
}) {
  const email = useEmailReceipt({ orderId, prefill: receiptEmailPrefill(customer) });
  return (
    <>
      <div className="flex flex-wrap gap-2 print:hidden">
        <Button className={RECEIPT_BTN} onClick={() => window.print()}>
          Print
        </Button>
        <EmailReceiptButton email={email} />
        <CounterReturnAction orderId={orderId} />
        <Button className={RECEIPT_BTN} variant="secondary" onClick={onNewSale}>
          New sale
        </Button>
      </div>
      <EmailReceiptRow email={email} />
    </>
  );
}
