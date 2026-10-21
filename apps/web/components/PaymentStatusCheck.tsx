"use client";

import * as React from "react";
import { Button } from "@routeflow/ui/web";
import { PAYMENT_STATUS_COPY } from "@routeflow/types/payment-submit-key";
import type { PaymentStatusCheck as Check } from "@/lib/use-payment-status-check";

/**
 * SA-824: the block every record-payment dialog shows beside its Save buttons. While the outcome is unknown
 * it explains and offers "Check payment status" (the Save buttons are disabled by the dialog meanwhile);
 * afterwards it shows the answer's fixed line. Renders nothing otherwise.
 */
export function PaymentStatusCheck({ status }: { status: Check }) {
  if (!status.unknown && !status.message) return null;
  return (
    <div role="status" className="flex flex-col gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm">
      {status.unknown && <p className="text-navy">{PAYMENT_STATUS_COPY.unknownHint}</p>}
      {status.message && <p className="font-medium text-navy">{status.message}</p>}
      {status.unknown && (
        <div>
          <Button variant="secondary" onClick={() => void status.check()} loading={status.checking}>
            {PAYMENT_STATUS_COPY.action}
          </Button>
        </div>
      )}
    </div>
  );
}
