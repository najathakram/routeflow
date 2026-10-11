/**
 * Whether the invoice detail page offers "Send Reminder" (R4 / SA-770).
 *
 * A reminder demands money, so it is offered on an ISSUED, UNPAID invoice that still owes a balance:
 * SENT, VIEWED, PARTIAL or OVERDUE with `balanceDue > 0`. PARTIAL was missing from the old status gate, so a
 * past-due invoice that still owed $5 had no button. The sweep never flips PARTIAL to OVERDUE, so PARTIAL is
 * the status a part-paid, past-due invoice keeps.
 *
 * `balanceDue` is the API's classifier-derived field (the same figure the API's `sendReminder` re-checks and
 * refuses at zero with REMINDER_NO_BALANCE_DUE), so an exactly-paid or overpaid invoice (P-3 keeps it out of
 * PAID) hides the button here instead of failing on click. DRAFT / PAID / VOID / WRITTEN_OFF never qualify.
 * An unknown balance hides the button: never offer an action whose precondition cannot be shown.
 */
const REMINDABLE_STATUSES: readonly string[] = ["SENT", "VIEWED", "PARTIAL", "OVERDUE"];

export function canSendReminder(inv: {
  status: string;
  balanceDue?: number | string | null;
}): boolean {
  if (!REMINDABLE_STATUSES.includes(inv.status)) return false;
  if (inv.balanceDue == null) return false;
  const balance = Number(inv.balanceDue);
  return Number.isFinite(balance) && balance > 0;
}
