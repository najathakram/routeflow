"use client";

import * as React from "react";
import Link from "next/link";
import {
  orderAppliedCredits,
  requestedLabel,
  type OrderAppliedCreditsInput,
} from "@routeflow/types";
import { formatMoney } from "@/lib/format";
import { useUnapplyCreditNote } from "@/lib/api/credit-notes";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { RemoveCreditButton } from "../../invoices/[id]/RemoveCreditButton";

type AppliedRow = Extract<ReturnType<typeof orderAppliedCredits>[number], { kind: "applied" }>;

/** The applied rows only — what the edit-mode credit picker lists read-only (#2404). */
export function appliedOnOrderRows(order: OrderAppliedCreditsInput): AppliedRow[] {
  return orderAppliedCredits(order).filter((r): r is AppliedRow => r.kind === "applied");
}

/**
 * #2404 (P0, epic #2400, SA-436 PR-3): the order's "Applied credits" — EVERY credit actually on
 * the order's invoices (Automatic or Applied, each with its invoice) plus the picked credits not
 * yet applied, from the shared `orderAppliedCredits` rule (mobile renders the same rows). Staff
 * can Remove an applied credit: it un-applies from that invoice. Credits reduce the invoice
 * balance due, never the order total.
 */
export function AppliedCreditsPanel({
  order,
  role,
}: {
  order: OrderAppliedCreditsInput;
  role: string | undefined;
}) {
  const rows = orderAppliedCredits(order);
  const unapply = useUnapplyCreditNote();
  const [removing, setRemoving] = React.useState<AppliedRow | null>(null);
  if (rows.length === 0) return null;

  return (
    <div className="mt-3 space-y-2 border-t border-surface-border pt-3">
      <p className="text-xs font-semibold uppercase tracking-wider text-navy/70">Applied credits</p>
      {rows.map((row) => (
        <div
          key={row.key}
          data-testid={
            row.kind === "applied"
              ? `applied-credit-payment:${row.paymentId}`
              : `applied-credit-intent:${row.key.slice("intent:".length)}`
          }
          className="flex items-start justify-between gap-2 text-xs"
        >
          <div className="min-w-0">
            <Link
              href={`/credit-notes/${row.creditNoteId}`}
              className="font-mono font-medium text-brand-600 hover:underline"
            >
              {row.creditNoteNumber}
            </Link>
            {row.reason && (
              <span className="ml-1.5 truncate text-navy/70" title={row.reason}>
                {row.reason}
              </span>
            )}
            <div className="flex flex-wrap items-center gap-1.5 text-navy/50">
              {row.kind === "applied" ? (
                <>
                  <span>on</span>
                  <Link
                    href={`/invoices/${row.invoiceId}`}
                    className="font-mono text-brand-600 hover:underline"
                  >
                    {row.invoiceNumber}
                  </Link>
                  <span className="rounded bg-sunken px-1.5 py-0.5 font-medium text-navy/70">
                    {row.source === "automatic" ? "Automatic" : "Applied"}
                  </span>
                  <RemoveCreditButton
                    role={role}
                    voided={false}
                    onRemove={() => setRemoving(row)}
                  />
                </>
              ) : (
                <>
                  <span className="rounded bg-sunken px-1.5 py-0.5 font-medium text-navy/70">
                    Not yet applied
                  </span>
                  <span>{requestedLabel(row, formatMoney)}</span>
                </>
              )}
            </div>
          </div>
          {row.kind === "applied" && (
            <span className="money shrink-0 font-medium text-navy">{formatMoney(row.amount)}</span>
          )}
        </div>
      ))}

      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        onConfirm={() =>
          removing &&
          unapply.mutate(
            { id: removing.creditNoteId, invoiceId: removing.invoiceId },
            { onSettled: () => setRemoving(null) },
          )
        }
        title="Remove this credit?"
        description={`This will un-apply ${formatMoney(removing?.pairTotal ?? 0)} of ${removing?.creditNoteNumber ?? ""} from ${removing?.invoiceNumber ?? ""} and restore it to the credit note's balance.`}
        confirmLabel="Remove credit"
        loading={unapply.isPending}
      />
    </div>
  );
}
