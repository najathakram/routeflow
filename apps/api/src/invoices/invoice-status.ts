import { InvoiceStatus } from "@prisma/client";
import { isOverdue } from "../common/calendar-date";

/**
 * An invoice's payment-driven status: the ONE body both InvoicesService and CreditNotesService
 * delegate to (they held identical private copies). DRAFT, VOID and WRITTEN_OFF are
 * terminal/deliberate and never overridden. SA-488 (#2493 item 3): OVERDUE only once the due day
 * has ENDED in `timeZone` (UTC when it is null), the shared `isOverdue` rule, never at 00:00Z of it.
 */
export function recomputeInvoiceStatus(
  totalPaid: number,
  total: number,
  dueDate: Date | null,
  currentStatus: InvoiceStatus | undefined,
  // SA-495a: REQUIRED — `null` means the tenant has no zone configured (UTC), never "omitted", so
  // the compiler enumerates every writer of a persisted status.
  timeZone: string | null,
  now: Date = new Date(),
): InvoiceStatus {
  if (
    currentStatus === InvoiceStatus.DRAFT ||
    currentStatus === InvoiceStatus.VOID ||
    currentStatus === InvoiceStatus.WRITTEN_OFF
  ) {
    return currentStatus;
  }
  if (totalPaid >= total - 0.001) return InvoiceStatus.PAID;
  if (totalPaid > 0) return InvoiceStatus.PARTIAL;
  if (isOverdue(dueDate, now, timeZone)) return InvoiceStatus.OVERDUE;
  return InvoiceStatus.SENT;
}
