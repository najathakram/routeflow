"use client";

// Extracted out of orders/[id]/page.tsx (#2406 prefactor — the page is pinned by
// common/size-ratchet.spec.ts and had no headroom left for the Returns wiring that PR adds).
// Intent (order.orderCreditNotes) vs money already moved (Σ CREDIT_NOTE payments across this
// order's invoices). Credits reduce the invoice balance due, never the order total itself.
import Link from "next/link";
import { formatMoney } from "@/lib/format";
import type { Order } from "@/lib/api/orders";

export interface AppliedCreditsSectionProps {
  order: Order;
}

export function AppliedCreditsSection({ order }: AppliedCreditsSectionProps) {
  if ((order.orderCreditNotes?.length ?? 0) === 0) return null;

  return (
    <div className="mt-3 space-y-2 border-t border-surface-border pt-3">
      <p className="text-xs font-semibold uppercase tracking-wider text-navy/70">Applied credits</p>
      {order.orderCreditNotes!.map((oc) => {
        const appliedSoFar = (order.invoices ?? []).reduce((sum, inv) => {
          const pays = inv.payments ?? [];
          return (
            sum +
            pays
              .filter((p) => p.creditNoteId === oc.creditNoteId)
              .reduce((s, p) => s + Number(p.amount), 0)
          );
        }, 0);
        return (
          <div key={oc.id} className="flex items-start justify-between gap-2 text-xs">
            <div className="min-w-0">
              <Link
                href={`/credit-notes/${oc.creditNoteId}`}
                className="font-mono font-medium text-brand-600 hover:underline"
              >
                {oc.creditNote?.creditNoteNumber ?? oc.creditNoteId.slice(0, 8)}
              </Link>
              {oc.creditNote?.reason && (
                <span className="ml-1.5 truncate text-navy/70" title={oc.creditNote.reason}>
                  {oc.creditNote.reason}
                </span>
              )}
              <div className="text-navy/50">
                {oc.amount != null ? `Requested ${formatMoney(oc.amount)}` : "Up to remaining"}
              </div>
            </div>
            <span className="shrink-0 font-medium text-navy">
              {formatMoney(appliedSoFar)} applied
            </span>
          </div>
        );
      })}
    </div>
  );
}
