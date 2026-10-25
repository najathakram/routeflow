"use client";

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth-context";
import { parseCreditLimitError } from "@/lib/api/credit-limit";
import { isStaffRole } from "@/lib/default-unit-line";
import { WriteButton } from "@/lib/read-only-gate";
import { CustomerRecordPaymentModal } from "@/components/CustomerRecordPaymentModal";

/**
 * Row 661 (Ask 1, step 3): when New order is refused for the tenant's credit limit (409 CREDIT_LIMIT_EXCEEDED), the
 * refusal also offers "Record payment" for that customer, which is the moment a payment unblocks real work. It opens
 * the same dialog as the Account strip, over the order, so the draft is kept. After a payment the refusal is cleared
 * (`onPaid`) and the operator re-taps Create; nothing is retried automatically. Renders nothing for any other error
 * and for a role that may not record payments. Adds no block of its own.
 */
export function CreditRefusalRecordPayment({
  error,
  customerId,
  customerName,
  onPaid,
}: {
  error: unknown;
  customerId: string;
  customerName?: string;
  onPaid: () => void;
}) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const [open, setOpen] = React.useState(false);
  if (!parseCreditLimitError(error) || !isStaffRole(user?.role)) return null;
  return (
    <>
      <WriteButton type="button" size="sm" variant="secondary" onClick={() => setOpen(true)}>
        Record payment
      </WriteButton>
      {open ? (
        <CustomerRecordPaymentModal
          customerId={customerId}
          customerName={customerName}
          onClose={() => setOpen(false)}
          onSuccess={() => {
            void qc.invalidateQueries({ queryKey: ["customers", customerId] });
            void qc.invalidateQueries({ queryKey: ["invoices"] });
            onPaid();
          }}
        />
      ) : null}
    </>
  );
}
