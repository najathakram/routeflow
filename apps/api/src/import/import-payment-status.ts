import { InvoiceStatus } from "@prisma/client";
import { sumConfirmed } from "../invoices/payment-predicates";

/**
 * The Zoho payments import's status rule for ONE invoice from its payments — shared by the per-row
 * transaction (#2262: each payment and its invoice's status are one tx) and the end-of-run sweep, so
 * the two can never disagree.
 *
 * DRAFT, VOID and WRITTEN_OFF are deliberate user/system states that are never auto-flipped (an unsent
 * draft or a voided invoice with a past due date must not appear OVERDUE). CONFIRMED-only (F03/B11): a
 * payment counts once an operator confirmed it (`sumConfirmed`). A tenth of a cent of slack, matching
 * InvoicesService.recomputeStatus. Returns the change to write, or null when the status stays.
 */
const TERMINAL: InvoiceStatus[] = [
  InvoiceStatus.DRAFT,
  InvoiceStatus.VOID,
  InvoiceStatus.WRITTEN_OFF,
];

export function importPaymentStatus(
  inv: { status: InvoiceStatus; total: unknown; dueDate: Date | null },
  payments: Array<{ amount: unknown; status?: string }>,
  now: Date,
): { status: InvoiceStatus; paidAt: Date | null } | null {
  if (TERMINAL.includes(inv.status)) return null;
  const totalPaid = sumConfirmed(payments as any);
  const total = Number(inv.total);
  let next: InvoiceStatus;
  if (totalPaid >= total - 0.001) next = InvoiceStatus.PAID;
  else if (totalPaid > 0) next = InvoiceStatus.PARTIAL;
  else if (inv.dueDate && inv.dueDate < now) next = InvoiceStatus.OVERDUE;
  else next = inv.status;
  if (next === inv.status) return null;
  return { status: next, paidAt: next === InvoiceStatus.PAID ? now : null };
}

/** A row the import refuses on purpose (reported by reason, not the generic "import failed"). */
export class ImportRowRefused extends Error {}

/**
 * SA-424 N1: an imported payment never lands on a VOID or WRITTEN_OFF invoice — checked on the row
 * the per-row tx has LOCKED, so a void committed while the import waited is refused, not written over.
 */
export function importPaymentRefusal(status: InvoiceStatus): string | null {
  if (status === InvoiceStatus.VOID) return "invoice is voided";
  if (status === InvoiceStatus.WRITTEN_OFF) return "invoice is written off";
  return null;
}
