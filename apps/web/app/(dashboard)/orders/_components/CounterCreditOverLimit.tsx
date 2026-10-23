"use client";

import * as React from "react";
import type { CounterSaleResponse } from "@routeflow/types";
import { formatMoney } from "@/lib/format";

/** SA-849: the one sentence (server figures, formatted only). */
export function creditOverLimitSentence(
  customerName: string | null | undefined,
  over: { limit: number; exposure: number },
): string {
  const who = customerName?.trim() || "the customer";
  return `Until this payment is recorded, ${who} is over their credit limit (${formatMoney(over.exposure)} of ${formatMoney(over.limit)}).`;
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
