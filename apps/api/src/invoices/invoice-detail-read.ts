import { roundMoney } from "@routeflow/pricing";
import { InvoiceStatus } from "@prisma/client";
import { computeDepositFields } from "./deposit-fields";
import { splitConfirmed } from "./payment-predicates";
import { overpaidByOf } from "./invoice-status";
import { AUDIT_ACTIONS } from "../audit/audit-actions.constant";

/**
 * The derived read-time fields of InvoicesService.findOne (moved verbatim out of invoices.service.ts,
 * #2717, to keep the size ratchet's ceiling): the confirmed-payment split, balance due, overdue and
 * the deposit fields. `inv` is the loaded invoice with its `payments`.
 */
export function deriveInvoiceDetailFields(inv: any, now: Date = new Date()) {
  // F03/R1: CONFIRMED (PAID) payments only. VOID payments (manually voided OR
  // bounced checks) must not count toward the paid amount — and neither must an
  // unconfirmed DRAFT one; every other paid-sum in this file matches.
  //
  // B421: paidAmount is CASH-ONLY; creditApplied/advanceApplied are separate
  // — see findAll's matching comment for why balanceDue/deposit still use
  // the full confirmed total.
  const { cash: paidAmount, creditApplied, advanceApplied } = splitConfirmed(inv.payments);
  const totalConfirmed = paidAmount + creditApplied + advanceApplied;
  const isSettled =
    inv.status === InvoiceStatus.PAID ||
    inv.status === InvoiceStatus.VOID ||
    inv.status === InvoiceStatus.WRITTEN_OFF;
  // B421 (review F3): roundMoney before the > 0 comparison — see findAll's
  // matching comment (totalConfirmed sums three floats; a sub-cent remnant
  // would otherwise render a red "Balance Due $0.00" on a settled invoice).
  const balanceDue = isSettled ? 0 : Math.max(0, roundMoney(Number(inv.total) - totalConfirmed));
  // RF-202: date-string comparison — invoice due today is NOT overdue.
  const dueDateIso = inv.dueDate
    ? (inv.dueDate instanceof Date ? inv.dueDate : new Date(inv.dueDate)).toISOString().slice(0, 10)
    : null;
  const todayIso = now.toISOString().slice(0, 10);
  const isOverdue = !isSettled && balanceDue > 0 && dueDateIso != null && dueDateIso < todayIso;
  const { depositAmount, depositOverdue } = computeDepositFields(inv, totalConfirmed, todayIso);
  return {
    balanceDue,
    overpaidBy: overpaidByOf(inv.total, paidAmount), // SA-763r P-3: external cash beyond the total
    paidAmount,
    creditApplied,
    advanceApplied,
    isOverdue,
    depositAmount,
    depositOverdue,
  };
}

/**
 * SA-763r P-3 (R5.1): the derived `revisedAt` — when the invoice's final document was last restated by an
 * order edit (the latest `invoice.revised` audit row), keyed by invoice id. The issue date is never moved
 * by a revision. One grouped read; `db` is the tenant client.
 */
export async function revisedAtByInvoice(
  db: { auditLog: { groupBy(args: any): Promise<any[]> } },
  invoiceIds: string[],
): Promise<Map<string, Date>> {
  if (invoiceIds.length === 0) return new Map();
  const rows = await db.auditLog.groupBy({
    by: ["entityId"],
    where: {
      entityType: "invoice",
      action: AUDIT_ACTIONS.INVOICE_REVISED,
      entityId: { in: invoiceIds },
    },
    _max: { createdAt: true },
  });
  return new Map(rows.filter((r) => r.entityId).map((r) => [r.entityId, r._max.createdAt]));
}
