import { InvoiceStatus } from "@prisma/client";
import { OVERPAID_EPSILON, roundMoney } from "@routeflow/pricing";
import { isOverdue } from "../common/calendar-date";

/**
 * What a caller wants when the confirmed payments exceed the total. `"NOT_PAID"` is the answer for every
 * restating, editing and sending path (the B1098 class: an overpaid invoice is never shown PAID).
 * `"PAID"` is the operator's DELIBERATE standalone overpayment (recordStandalonePayment) and nothing else;
 * a structural spec pins that it appears at exactly one call site.
 */
export type OnOverpaid = "NOT_PAID" | "PAID";

/**
 * An invoice's payment-driven status: the ONE body both InvoicesService and CreditNotesService
 * delegate to (they held identical private copies). DRAFT, VOID and WRITTEN_OFF are
 * terminal/deliberate and never overridden. SA-488 (#2493 item 3): OVERDUE only once the due day
 * has ENDED in `timeZone` (UTC when it is null), the shared `isOverdue` rule, never at 00:00Z of it.
 *
 * SA-763r P-3 [L-O1] (B1098): `totalPaid > total + OVERPAID_EPSILON` is never PAID (unless `onOverpaid` is `"PAID"`):
 * OVERDUE once the due day has ended, else SENT (VIEWED falls back to SENT). The balance is then zero
 * and `overpaidBy` (below) carries the excess.
 */
export function statusFromPayments(
  totalPaid: number,
  total: number,
  dueDate: Date | null,
  currentStatus: InvoiceStatus | undefined,
  // SA-495a: REQUIRED — `null` means the tenant has no zone configured (UTC), never "omitted", so
  // the compiler enumerates every writer of a persisted status.
  timeZone: string | null,
  // [L-O2]: REQUIRED for the same reason: no caller can reach PAID-on-overpay by omission.
  onOverpaid: OnOverpaid,
  now: Date = new Date(),
): InvoiceStatus {
  if (
    currentStatus === InvoiceStatus.DRAFT ||
    currentStatus === InvoiceStatus.VOID ||
    currentStatus === InvoiceStatus.WRITTEN_OFF
  ) {
    return currentStatus;
  }
  if (onOverpaid === "NOT_PAID" && totalPaid > total + OVERPAID_EPSILON) {
    return isOverdue(dueDate, now, timeZone) ? InvoiceStatus.OVERDUE : InvoiceStatus.SENT;
  }
  if (totalPaid >= total - 0.001) return InvoiceStatus.PAID;
  if (totalPaid > 0) return InvoiceStatus.PARTIAL;
  if (isOverdue(dueDate, now, timeZone)) return InvoiceStatus.OVERDUE;
  return InvoiceStatus.SENT;
}

/**
 * The derived `overpaidBy` on an invoice read: `max(0, confirmed EXTERNAL paid - total)`, cents. External =
 * the cash-only split (`splitConfirmed().cash`): a credit-note or advance application is re-settled by the
 * credit sync, not money the customer overpaid. No column; never `invoicesNeedReview` (a line-partition check).
 */
export function overpaidByOf(total: unknown, externalPaid: number): number {
  const excess = roundMoney(externalPaid - Number(total));
  return excess > OVERPAID_EPSILON ? excess : 0;
}
