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

/**
 * W-861 (SA-944 §3): the order read's `editItemsLocked` (a paid walk-in sale) hides Edit Items; this line says what
 * to do instead. The page passes the server's verdict; nothing here re-derives it.
 */
export function EditItemsLockedNote({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <span
      data-testid="edit-items-locked"
      className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-1 text-xs font-medium text-amber-700 ring-1 ring-amber-200"
    >
      This sale is paid. Ring up added items as a new sale, or use Return to take items back.
    </span>
  );
}
