"use client";

import * as React from "react";
import { Button } from "@routeflow/ui/web";
import { useHasAddon } from "@/lib/api/tobacco";
import { ORDERS_INLINE_RETURNS_ADDON } from "@/lib/api/addons";
import {
  orderOverpayCopy,
  parseOrderEditWouldOverpay,
  type OrderOverpayInfo,
} from "@/lib/order-overpay";
import { RecordInlineReturnDialog } from "../../../returns/_components/RecordInlineReturnDialog";

/**
 * P-4: a refused edit (`409 ORDER_EDIT_WOULD_OVERPAY`) shows FIXED copy and a "Record a return" button that opens the
 * order's existing inline-return dialog (web has no separate new-return route). Extracted so orders/[id]/page.tsx (pinned by
 * size-ratchet.spec.ts) adds only a hook call, a capture line and a render.
 */
export function useOrderOverpayGuard(
  order: { id: string; customerId: string; customer?: { businessName?: string } } | undefined,
  editing = true,
) {
  const [info, setInfo] = React.useState<OrderOverpayInfo | null>(null);
  const [returnOpen, setReturnOpen] = React.useState(false);
  const hasInlineReturns = useHasAddon(ORDERS_INLINE_RETURNS_ADDON);

  // The notice renders only in edit mode, so only an edit-mode 409 is ours; anywhere else it falls through
  // to the global toast (mutation-error-toast.ts no longer swallows the code).
  const capture = (err: unknown): boolean => {
    const parsed = editing ? parseOrderEditWouldOverpay(err) : null;
    if (parsed) setInfo(parsed);
    return parsed !== null;
  };
  /** `meta.localErrorToast` predicate for the edit-save mutation: skip the global toast when the notice shows. */
  const ownsToast = (err: unknown): boolean => editing && parseOrderEditWouldOverpay(err) !== null;

  const node = info ? (
    <div
      role="alert"
      data-testid="order-overpay-notice"
      className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-navy"
    >
      <p>{orderOverpayCopy(info, hasInlineReturns)}</p>
      <div className="mt-2 flex gap-2">
        {hasInlineReturns && (
          <Button
            variant="secondary"
            size="sm"
            className="h-11"
            onClick={() => setReturnOpen(true)}
          >
            Record a return
          </Button>
        )}
        <Button variant="ghost" size="sm" className="h-11" onClick={() => setInfo(null)}>
          Dismiss
        </Button>
      </div>
      <RecordInlineReturnDialog
        open={returnOpen}
        onClose={() => setReturnOpen(false)}
        customerId={order?.customerId ?? ""}
        customerName={order?.customer?.businessName}
        orderId={order?.id}
        allowRefund
      />
    </div>
  ) : null;

  return { capture, ownsToast, node };
}
