"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button, Modal } from "@routeflow/ui/web";
import { formatMoney } from "@/lib/format";
import type { CreditLimitInfo } from "@/lib/api/credit-limit";

/**
 * Shown instead of a bare error toast when a save / send-out / delivery is refused for credit
 * (409 CREDIT_LIMIT_EXCEEDED). The numbers and the sentence are the server's. There is no override,
 * so the exits are: collect a payment on the customer (reduces exposure — the operator then
 * re-taps the action; nothing is retried automatically) or cancel.
 */
export function CreditLimitGuardDialog({
  info,
  customerId,
  onClose,
}: {
  info: CreditLimitInfo | null;
  customerId?: string | null;
  onClose: () => void;
}) {
  const router = useRouter();
  return (
    <Modal
      open={!!info}
      onClose={onClose}
      title="Credit limit exceeded"
      description={info?.message}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          {customerId && (
            <Button
              onClick={() => {
                onClose();
                router.push(`/customers/${customerId}`);
              }}
            >
              Collect payment
            </Button>
          )}
        </>
      }
    >
      {info && (
        <dl className="grid grid-cols-2 gap-3">
          <div className="rounded-lg bg-surface-raised p-3">
            <dt className="text-xs uppercase tracking-wide text-navy/60">Limit</dt>
            <dd className="text-lg font-semibold text-navy">{formatMoney(info.limit)}</dd>
          </div>
          <div className="rounded-lg bg-surface-raised p-3">
            <dt className="text-xs uppercase tracking-wide text-navy/60">Would be</dt>
            <dd className="text-lg font-semibold text-danger">{formatMoney(info.exposure)}</dd>
          </div>
        </dl>
      )}
    </Modal>
  );
}
