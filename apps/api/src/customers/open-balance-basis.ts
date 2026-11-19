import { InvoiceStatus, type Prisma } from "@prisma/client";
import { KPI_SUMMARY_EXCLUDED } from "../invoices/invoice-status-sets";
import { POST_DELIVERY_ORDER_STATUSES } from "../common/terminal-order-statuses";

/**
 * The open-balance basis, a leaf module (SA-1164 22:24Z): it imports only Prisma and the two status lists, so the statements, the
 * customers list and the bookkeeping readers can all share it without an import cycle.
 */

/**
 * SA-1164 22:05Z: the unsent invoice that IS receivable: a DRAFT whose order is post-delivery (DELIVERED or REFUSED). Every reader under
 * the S9 "same cents everywhere" pin (statements, customers list, Customer Balance Summary, AR aging) joins it, through
 * OPEN_BALANCE_INVOICE_WHERE or an `OR` beside its own status set.
 */
export const RECEIVABLE_DRAFT_WHERE = {
  status: InvoiceStatus.DRAFT,
  order: { status: { in: [...POST_DELIVERY_ORDER_STATUSES] } },
} satisfies Prisma.InvoiceWhereInput;

/**
 * SA-1078 PR-5: the ONE basis of "what a customer owes" on a list. The statement, the customers list and its CSV all read the
 * invoices this where selects with this select (see `open-balances.ts`) and sum them with `statementOutstandingAmount`, so a
 * figure printed anywhere is the sheet's figure. PAID, VOID and WRITTEN_OFF are never receivable. A DRAFT is receivable only when its order is post-delivery
 * (DELIVERED or REFUSED: the goods left, the invoice just has not been sent), SA-1164 21:13Z (PR-2b, supersedes SA-1078 PR-5
 * "DRAFT is never receivable" for that case). Any other DRAFT (order still open, or no order) stays out, and the carrier-shipment
 * DRAFT (`settledAtShipment`) stays out until its own row. The credit-exposure basis (`CREDIT_EXPOSURE_EXCLUDED`) is a different
 * rule and unchanged. The where is a top-level `OR`: spread it next to other keys (an AND), never next to another `OR`.
 */
export const OPEN_BALANCE_INVOICE_WHERE = {
  OR: [{ status: { notIn: KPI_SUMMARY_EXCLUDED } }, RECEIVABLE_DRAFT_WHERE],
} satisfies Prisma.InvoiceWhereInput;
export const OPEN_BALANCE_INVOICE_SELECT = {
  customerId: true,
  total: true,
  status: true,
  dueDate: true,
  payments: { select: { amount: true, status: true } },
} as const;
