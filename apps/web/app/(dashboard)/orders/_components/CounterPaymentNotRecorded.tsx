"use client";

import * as React from "react";
import { Button } from "@routeflow/ui/web";
import {
  API_ERROR_CODES,
  RECORD_ANYWAY_LABEL,
  canRecordAnyway,
  type CounterSaleResponse,
} from "@routeflow/types";
import { useCreateCounterSale } from "@/lib/api/counter-sale";
import { useOptionalAuth } from "@/lib/auth-context";
import { counterSaleToResend } from "@/lib/counter-last-sale";
import { duplicatePaymentRefMessage } from "@/lib/duplicate-payment-ref";

/**
 * SA-837b item 3 (review I3): the till's escape when the sale's payment was refused as a DUPLICATE payment reference. It
 * sits under the receipt's existing "payment not recorded" state and shows only for that cause: the one shared sentence that
 * names the existing payment (date, amount, invoice) and, for a staff role, a "Record anyway" action.
 *
 * "Record anyway" is not a counter rule: it re-sends the SAME sale (same Idempotency-Key, same cart) with the generic
 * `payment.recordAnyway` flag every payment surface uses. The server resumes only the missing payment, as the signed-in
 * cashier, and writes one audit row; a role that may not use the flag is shown the sentence and no action.
 */
export function CounterPaymentNotRecorded({
  receipt,
  onReceipt,
}: {
  receipt: CounterSaleResponse;
  /** the server's answer to the resend replaces the receipt on screen */
  onReceipt: (next: CounterSaleResponse) => void;
}) {
  const createSale = useCreateCounterSale();
  const role = (useOptionalAuth()?.user as { role?: string } | null | undefined)?.role;
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const message =
    receipt.paymentRecorded === false &&
    receipt.paymentCauseCode === API_ERROR_CODES.DUPLICATE_PAYMENT_REF &&
    receipt.existingPayment
      ? duplicatePaymentRefMessage({
          response: {
            status: 409,
            data: {
              code: API_ERROR_CODES.DUPLICATE_PAYMENT_REF,
              existingPayment: receipt.existingPayment,
            },
          },
        })
      : null;
  if (!message) return null;

  const sale = counterSaleToResend(receipt.orderId);
  const recordAnyway = async () => {
    if (!sale || busy) return;
    setBusy(true);
    setError("");
    try {
      const next = await createSale.mutateAsync({
        dto: { ...sale.dto, payment: { ...sale.dto.payment, recordAnyway: true } },
        idempotencyKey: sale.key,
      });
      onReceipt({ ...next, method: next.method ?? sale.dto.payment.method });
    } catch {
      setError("The payment could not be recorded. Try again, or record it on the invoice.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="space-y-2 rounded border border-amber-300 bg-amber-50 p-3 text-sm print:hidden"
      data-testid="counter-payment-duplicate"
    >
      <p>{message}</p>
      {sale && canRecordAnyway(role) ? (
        <Button
          type="button"
          variant="secondary"
          className="min-h-[44px] min-w-[44px]"
          loading={busy}
          onClick={() => void recordAnyway()}
        >
          {RECORD_ANYWAY_LABEL}
        </Button>
      ) : null}
      {error ? (
        <p role="alert" className="text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
