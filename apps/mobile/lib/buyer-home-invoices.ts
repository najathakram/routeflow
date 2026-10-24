/**
 * The buyer Home balance strip's invoice query and overdue count (pure, unit-tested; must-fix 1 of the row 318
 * review). The query asks for the shared OPEN set (SENT, VIEWED, PARTIAL, OVERDUE: issued and not settled), and
 * the overdue count follows the SERVER's `isOverdue` flag (open status AND balance due AND the due day ended in
 * the seller's zone), never the OVERDUE status: the sweep never flips a PARTIAL invoice to OVERDUE, and a stale
 * OVERDUE status can outlive a moved due date.
 */
import { OPEN_INVOICE_STATUS_VALUES } from "@routeflow/types";

export function buyerHomeInvoiceParams(): { statuses: string[]; limit: number } {
  return { statuses: [...OPEN_INVOICE_STATUS_VALUES], limit: 50 };
}

export function buyerHomeOverdueCount(
  invoices: ReadonlyArray<{ status?: string; isOverdue?: boolean }> | undefined,
): number {
  return (invoices ?? []).filter((inv) => inv.isOverdue === true).length;
}
