import { roundMoney } from "@routeflow/pricing";
import { InvoiceStatus } from "@prisma/client";
import { startOfCalendarDay } from "../common/calendar-date";
import { OPEN_INVOICE_STATUSES } from "./invoice-status-sets";
import { type ConfirmablePaymentRow, sumConfirmed } from "./payment-predicates";

/**
 * SA-770 r-note: THE TypeScript answer to "what is still owed on this invoice, and is it overdue?".
 * One copy, replacing the inline `total - sumConfirmed` / overdue-flag arithmetic that invoice-detail-read,
 * the list enrichment (findAll), the KPI tiles and the two buyer readers each carried. Its SQL twin is
 * `balanceDueSql` (invoice-balance-sql.ts); invoice-balance-sql.parity.db.spec.ts pins the two against
 * each other row for row, so SQL and TS cannot drift.
 *
 * The rule: balance = `roundMoney(total - Σ CONFIRMED payments)` floored at 0 (cash, credit-note and
 * advance applications all reduce it; DRAFT, VOID and PENDING never do). A PAID / VOID / WRITTEN_OFF
 * invoice reads as settled (0). Overdue = not settled AND a balance is due AND the due DAY has ended
 * before `cutoff` (RF-202: the whole due day is grace). `cutoff` is `overdueCutoff(now, zone)` in the
 * INVOICE'S OWN tenant zone, so a reader spanning sellers passes each invoice its own seller's cutoff.
 */

const SETTLED: readonly string[] = [
  InvoiceStatus.PAID,
  InvoiceStatus.VOID,
  InvoiceStatus.WRITTEN_OFF,
];

export interface ClassifiableInvoice {
  status: string;
  total: unknown;
  dueDate?: Date | string | null;
  payments?: ReadonlyArray<ConfirmablePaymentRow> | null;
}

/** `max(0, roundMoney(total - Σ confirmed payments))`: the balance of an invoice that is not settled by status. */
export function confirmedBalance(
  total: unknown,
  payments: ReadonlyArray<Pick<ConfirmablePaymentRow, "amount" | "status">> | null | undefined,
): number {
  return Math.max(0, roundMoney(Number(total) - sumConfirmed(payments)));
}

export function classifyInvoiceBalance(
  inv: ClassifiableInvoice,
  cutoff: Date,
): { balanceDue: number; isOverdue: boolean } {
  const settled = SETTLED.includes(inv.status);
  const balanceDue = settled ? 0 : confirmedBalance(inv.total, inv.payments);
  const isOverdue =
    !settled &&
    balanceDue > 0 &&
    inv.dueDate != null &&
    startOfCalendarDay(inv.dueDate, "UTC").getTime() < cutoff.getTime();
  return { balanceDue, isOverdue };
}

export interface OpenInvoiceSummary {
  /** PAID invoices, and open ones whose confirmed payments already cover the total (paid in substance). */
  settledCount: number;
  /** Open invoices that still owe and are inside their due day (or have none). */
  unpaidCount: number;
  /** Open invoices that still owe and whose due day has ended. */
  overdueCount: number;
  /** Σ BALANCE DUE of the unpaid + overdue invoices, in cents — never gross `total`. */
  unpaidTotal: number;
}

/** The buyer-facing receivables figures over one seller's invoices; DRAFT / VOID / WRITTEN_OFF are ignored. */
export function summarizeOpenInvoices(
  invoices: ReadonlyArray<ClassifiableInvoice>,
  cutoff: Date,
): OpenInvoiceSummary {
  const out: OpenInvoiceSummary = {
    settledCount: 0,
    unpaidCount: 0,
    overdueCount: 0,
    unpaidTotal: 0,
  };
  for (const inv of invoices) {
    if (inv.status === InvoiceStatus.PAID) {
      out.settledCount++;
      continue;
    }
    if (!(OPEN_INVOICE_STATUSES as readonly string[]).includes(inv.status)) continue;
    const { balanceDue, isOverdue } = classifyInvoiceBalance(inv, cutoff);
    if (balanceDue <= 0) out.settledCount++;
    else {
      if (isOverdue) out.overdueCount++;
      else out.unpaidCount++;
      out.unpaidTotal = roundMoney(out.unpaidTotal + balanceDue);
    }
  }
  return out;
}
