import { ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";

/**
 * SA-1050 A-1: the ONE home of "an invoice with a bad-debt history is never deleted", for every door that destroys a
 * single invoice row (InvoicesService.deleteInvoice and the order-side `deleteOrderInvoice`; L-072, never re-inline).
 *
 * `InvoiceWriteOffEvent.invoice` is ON DELETE RESTRICT: the events are the bad-debt ledger and a past period is never
 * re-derived. Without this refusal the delete is a raw P2003 (500); deleting the history with the invoice would silently
 * move a past month's bad-debt expense. ANY event (WRITE_OFF or REINSTATE) refuses: after a reinstate the history still
 * exists. A legacy written-off invoice with no event has no history and still deletes.
 *
 * Throws 409 INVOICE_HAS_WRITE_OFF_HISTORY. Call INSIDE the deleting transaction, BEFORE any write, with that tx: it
 * reads under the caller's locks (the write-off takes the same Invoice row lock before it appends).
 */
export async function assertNoWriteOffHistory(tx: any, invoiceIds: string[]): Promise<void> {
  if (invoiceIds.length === 0) return;
  const event = await tx.invoiceWriteOffEvent.findFirst({
    where: { invoiceId: { in: invoiceIds } },
    select: { invoiceId: true },
  });
  if (!event) return;
  throw new ConflictException({
    code: API_ERROR_CODES.INVOICE_HAS_WRITE_OFF_HISTORY,
    message: "This invoice has a bad-debt history, so it can't be deleted.",
    invoiceId: event.invoiceId,
  });
}
