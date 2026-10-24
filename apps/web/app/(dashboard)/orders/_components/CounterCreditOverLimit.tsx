"use client";

import * as React from "react";
import {
  creditOverLimitSentence as sharedSentence,
  type CounterSaleResponse,
  type CreditOverLimit,
} from "@routeflow/types";
import { formatMoney } from "@/lib/format";

/** SA-849: the one sentence (packages/types, shared with mobile), in web money. */
export function creditOverLimitSentence(
  customerName: string | null | undefined,
  over: CreditOverLimit,
): string {
  return sharedSentence(customerName, over, formatMoney);
}

/**
 * SA-849 (S1 S-1): the credit gate counted this sale's till tender, the tender did not record, and without it the customer
 * is over their credit limit (the tenant enforces it). One line under the receipt's "payment not recorded" state, like the
 * duplicate-reference panel beside it; the sale stands, and recording the payment (Record payment / retry) clears it.
 */
export function CounterCreditOverLimit({
  receipt,
  customerName,
}: {
  receipt: CounterSaleResponse;
  customerName?: string | null;
}) {
  if (receipt.paymentRecorded !== false || !receipt.creditOverLimit) return null;
  return (
    <p
      role="status"
      className="rounded border border-amber-300 bg-amber-50 p-3 text-sm print:hidden"
      data-testid="counter-credit-over-limit"
    >
      {creditOverLimitSentence(customerName, receipt.creditOverLimit)}
    </p>
  );
}
