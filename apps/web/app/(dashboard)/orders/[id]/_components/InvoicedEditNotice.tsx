import * as React from "react";

/** The invoice rows this notice reads - a structural subset of the order read's `invoices`. */
export interface InvoicedEditNoticeInvoice {
  invoiceNumber?: string | null;
  status?: string | null;
}

/** An invoice that still stands: everything except a VOID one. */
export function liveInvoices(invoices?: InvoicedEditNoticeInvoice[] | null) {
  return (invoices ?? []).filter((inv) => inv.status !== "VOID");
}

/**
 * O7 (apple-ux run 2026-10-16, owner ruling 10-16): Edit Items stays available on an invoiced order
 * (no feature removed), but the moment of decision says what saving does. ONE inline line above the
 * lines - no dialog. Renders nothing when the order has no live invoice.
 */
export function InvoicedEditNotice({
  invoices,
}: {
  invoices?: InvoicedEditNoticeInvoice[] | null;
}) {
  const live = liveInvoices(invoices);
  if (live.length === 0) return null;
  const numbers = live
    .map((inv) => inv.invoiceNumber)
    .filter(Boolean)
    .join(", ");
  return (
    <p
      role="status"
      data-testid="invoiced-edit-notice"
      className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-navy"
    >
      This order is invoiced{numbers ? ` (${numbers})` : ""}. Saving changes marks the invoice
      {live.length > 1 ? "s" : ""} for review.
    </p>
  );
}
