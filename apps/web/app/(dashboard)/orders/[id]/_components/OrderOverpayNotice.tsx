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
) {
  const [info, setInfo] = React.useState<OrderOverpayInfo | null>(null);
  const [returnOpen, setReturnOpen] = React.useState(false);
  const hasInlineReturns = useHasAddon(ORDERS_INLINE_RETURNS_ADDON);

  const capture = (err: unknown): boolean => {
    const parsed = parseOrderEditWouldOverpay(err);
    if (parsed) setInfo(parsed);
    return parsed !== null;
  };

  const node = info ? (
    <div
      role="alert"
      data-testid="order-overpay-notice"
      className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-navy"
    >
      <p>{orderOverpayCopy(info)}</p>
      <div className="mt-2 flex gap-2">
        {hasInlineReturns && (
          <Button variant="secondary" size="sm" onClick={() => setReturnOpen(true)}>
            Record a return
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={() => setInfo(null)}>
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

  return { capture, node };
}
