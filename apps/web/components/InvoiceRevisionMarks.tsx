import * as React from "react";
import { overpaidText, revisedBadgeText } from "@/lib/invoice-revision";

/** P-4: "Revised {date}" badge and "Overpaid by $X" line. Both come from optional API fields; absent = nothing renders. */
export function InvoiceRevisionMarks({
  revisedAt,
  overpaidBy,
}: {
  revisedAt?: string | null;
  overpaidBy?: number | null;
}) {
  const revised = revisedBadgeText(revisedAt);
  const overpaid = overpaidText(overpaidBy);
  if (!revised && !overpaid) return null;
  return (
    <>
      {revised && (
        <span
          data-testid="invoice-revised-badge"
          className="inline-flex items-center rounded-full bg-warning-bg px-2 py-0.5 text-xs font-medium text-navy ring-1 ring-black/5"
        >
          {revised}
        </span>
      )}
      {overpaid && (
        <span
          data-testid="invoice-overpaid"
          className="inline-flex items-center rounded-full bg-warning-bg px-2 py-0.5 text-xs font-medium text-navy ring-1 ring-black/5"
        >
          {overpaid}
        </span>
      )}
    </>
  );
}
