/**
 * The ONE PDF date formatter ("Jan 15, 2026"), anchored to UTC. Calendar dates (issueDate, dueDate,
 * statement day bounds, payment days) are stored as UTC-midnight instants; reading them through the
 * host's local zone renders a day early for any host west of UTC (B954). Shared by the
 * bookkeeping-invoice and buyer-statement PDF templates (invoices/invoice-pdf-template.tsx keeps
 * its own, already UTC-anchored copy).
 */
export function fmtPdfDate(val: Date | string | null | undefined): string {
  if (!val) return "—";
  return new Date(val).toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
