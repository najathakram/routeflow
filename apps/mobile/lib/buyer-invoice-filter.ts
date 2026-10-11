/**
 * The buyer Invoices screen's filter chips -> `/buyer/invoices` query params (row 318e, SA-770). Pure, so the
 * chip mapping is unit-tested without rendering the screen.
 *
 * "Unpaid" is the OPEN set: an issued invoice that is not settled (SENT, VIEWED, PARTIAL, OVERDUE), the same four
 * statuses as the API's `OPEN_INVOICE_STATUSES` (the DRAFT a buyer never sees, PAID, VOID and WRITTEN_OFF are out).
 * "Overdue" is the derived `isOverdue` filter, not a status: the sweep never flips PARTIAL to OVERDUE, so a strict
 * `status=OVERDUE` query would drop a past-due part-paid invoice (R4).
 */
export type BuyerInvoiceFilterId = "ALL" | "UNPAID" | "PAID" | "OVERDUE";

export const BUYER_UNPAID_STATUSES = ["SENT", "VIEWED", "PARTIAL", "OVERDUE"] as const;

export interface BuyerInvoiceQuery {
  status?: string;
  statuses?: string[];
  isOverdue?: true;
}

export function buyerInvoiceQuery(filter: BuyerInvoiceFilterId): BuyerInvoiceQuery {
  return {
    status: filter === "PAID" ? "PAID" : undefined,
    statuses: filter === "UNPAID" ? [...BUYER_UNPAID_STATUSES] : undefined,
    isOverdue: filter === "OVERDUE" ? true : undefined,
  };
}
