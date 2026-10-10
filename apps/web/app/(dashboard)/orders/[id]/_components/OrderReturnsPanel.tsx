"use client";

// ─── "Returns on this order" — server figures only (#2406) ─────────────────────────────────
//
// Renders beside the order-detail "Applied credits" section, right after a return has been
// captured (create or edit, both carrying `inlineReturn`), or for any return ever recorded
// against this order (including the standalone RecordInlineReturnDialog). Reads GET
// /returns?orderId=<id> — never the quote's own numbers, which are an ESTIMATE only. Its own
// file so a later credit-notes epic (#2400) can reuse it.
import Link from "next/link";
import { Badge, Card, type BadgeStatus } from "@routeflow/ui/web";
import { useReturns } from "@/lib/api/returns";
import { formatMoney } from "@/lib/format";
import { refundAmountOf } from "@routeflow/returns";

export interface OrderReturnsPanelProps {
  orderId: string;
}

/** W21b: label a REFUNDED return by how it was resolved: a store-credit resolution (a credit note, or refundMethod
 *  CREDIT_NOTE) reads "Store credit"; a cash/card/check refund (refundMethod EXTERNAL_REFUND) keeps "Refunded". */
function resolutionLabel(ret: {
  status: string;
  refundMethod?: string | null;
  creditNoteId?: string | null;
}): string | undefined {
  if (ret.status !== "REFUNDED" || ret.refundMethod === "EXTERNAL_REFUND") return undefined;
  return ret.refundMethod === "CREDIT_NOTE" || ret.creditNoteId ? "Store credit" : undefined;
}

export function OrderReturnsPanel({ orderId }: OrderReturnsPanelProps) {
  // #2406: "ALL" so a captured INLINE return (every return this panel is meant to show) is
  // included alongside any STANDARD (post-delivery RMA) return on this order.
  const { data } = useReturns({ orderId, kind: "ALL", limit: 50 });
  const returns = data?.data ?? [];

  if (returns.length === 0) return null;

  return (
    <Card title="Returns on this order">
      <div className="space-y-2">
        {returns.map((ret) => {
          const amount = refundAmountOf(ret.refundAmount);
          return (
            <div
              key={ret.id}
              data-testid="order-return-row"
              className="flex items-center justify-between gap-2 text-sm"
            >
              <div className="min-w-0">
                <Link
                  href={`/returns/${ret.id}`}
                  className="font-mono font-medium text-brand-600 hover:underline"
                >
                  #{ret.returnNumber}
                </Link>
                <Badge status={ret.status as BadgeStatus} label={resolutionLabel(ret)} />
              </div>
              <div className="flex items-center gap-2 text-navy/70">
                {amount !== null && <span className="money text-navy">{formatMoney(amount)}</span>}
                {ret.creditNoteId && (
                  <Link
                    href={`/credit-notes/${ret.creditNoteId}`}
                    className="text-brand-600 underline"
                  >
                    Credit note
                  </Link>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
