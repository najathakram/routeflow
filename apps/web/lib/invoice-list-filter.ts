/**
 * The invoices-list query params for the status tab / KPI tile that is active (R4 / SA-770).
 *
 * "Overdue" is DERIVED, not a status: open status AND balance due AND past the due day. The hourly sweep
 * only flips SENT/VIEWED to OVERDUE, so a past-due PARTIAL invoice that still owes is never status OVERDUE;
 * a strict `status=OVERDUE` query therefore listed fewer invoices than the Overdue KPI tile counted. The tab
 * (URL state `status=OVERDUE`, kept so existing links still work) asks the API's `isOverdue` filter instead:
 * the same rule the tile, the dashboard and the mobile app use. Any other tab stays a strict status.
 */
export const OVERDUE_FILTER = "OVERDUE";

export function invoiceListStatusParams(statusFilter: string): {
  status?: string;
  isOverdue?: true;
} {
  if (statusFilter === OVERDUE_FILTER) return { isOverdue: true };
  return statusFilter ? { status: statusFilter } : {};
}
