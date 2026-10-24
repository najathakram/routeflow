"use client";

import * as React from "react";
import { Button } from "@routeflow/ui/web";

/**
 * The reason prompt for demoting an order (to PENDING / CONFIRMED). Extracted verbatim from
 * orders/[id]/page.tsx (size ratchet, SA-065); behaviour unchanged.
 */
export function DemoteReasonModal({
  open,
  onClose,
  onConfirm,
  loading,
  targetStatus,
  fulfillPath,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void;
  loading: boolean;
  targetStatus: string;
  /** The order's path: a SHIP order walking back to CONFIRMED is "unmarking shipped", never "Return to Confirmed". */
  fulfillPath?: string | null;
}) {
  const [reason, setReason] = React.useState("");

  const unmarkShipped = fulfillPath === "SHIP" && targetStatus === "CONFIRMED";
  const label: Record<string, string> = {
    PENDING: "Return to Pending",
    CONFIRMED: unmarkShipped ? "Unmark shipped" : "Return to Confirmed",
  };
  const description: Record<string, string> = {
    PENDING: "Why is this order being returned to pending?",
    CONFIRMED: unmarkShipped
      ? "Why is this order being unmarked as shipped?"
      : "Why is this order being returned to confirmed?",
  };

  React.useEffect(() => {
    if (open) setReason("");
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-2xl bg-white shadow-xl">
        <div className="border-b border-surface-border px-5 py-4">
          <h2 className="text-base font-semibold text-navy">
            {label[targetStatus] ?? "Change Status"}
          </h2>
          <p className="mt-1 text-sm text-navy/70">
            {description[targetStatus] ?? "Reason for this status change."}
          </p>
        </div>
        <div className="px-5 py-4">
          <label className="block text-sm font-medium text-navy/80 mb-1.5">Reason</label>
          <textarea
            className="w-full resize-none rounded-lg border border-surface-border bg-surface-raised px-3 py-2 text-sm text-navy placeholder:text-navy/30 focus:outline-none focus:ring-2 focus:ring-brand-500"
            rows={3}
            placeholder="e.g. Customer called to request a change..."
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        <div className="flex justify-end gap-2 border-t border-surface-border px-5 py-3">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => onConfirm(reason)}
            disabled={!reason.trim()}
            loading={loading}
          >
            Confirm
          </Button>
        </div>
      </div>
    </div>
  );
}
