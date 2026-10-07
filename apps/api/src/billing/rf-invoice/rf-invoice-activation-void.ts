import { AdminAuditAction } from "../../platform-admin/audit-actions.constant";
import { writeAdminNotice } from "../manual-invoice-notice";

export interface VoidCoveredInput {
  tenantId: string;
  /** The activation's prepaid window: [windowStart, windowEnd). */
  windowStart: Date;
  windowEnd: Date;
  actorId: string | null;
  now: Date;
}

/**
 * Owner ruling (PR4a): a Manual Activation that records a new prepaid period VOIDS every OPEN RouteFlow
 * invoice that period fully covers, in the SAME transaction, so the invoice queue never asks for money the
 * activation already recorded.
 *
 * "Covers" = invoice.periodStart >= windowStart AND invoice.periodEnd <= windowEnd (the window fully contains
 * the invoice's half-open period). A partial overlap, a legacy row with no period, a PAID or an already VOID
 * invoice is never touched. Each void is a CAS (`status: "OPEN"`, tenant-scoped) shaped exactly like the admin
 * void: periodKey becomes "<iso>:void:<id>" (frees the period slot), plus an RF_INVOICE_VOIDED audit row.
 */
export async function voidCoveredRfInvoices(
  tx: any,
  input: VoidCoveredInput,
): Promise<{ voided: string[] }> {
  const { tenantId, windowStart, windowEnd, actorId, now } = input;
  const candidates: Array<{
    id: string;
    number: string;
    amount: unknown;
    periodKey: string | null;
  }> = await tx.rfInvoice.findMany({
    where: {
      tenantId,
      status: "OPEN",
      periodStart: { gte: windowStart },
      periodEnd: { lte: windowEnd },
    },
    select: { id: true, number: true, amount: true, periodKey: true },
  });

  const reason = `Covered by manual activation on ${now.toISOString().slice(0, 10)}`;
  const voided: string[] = [];
  for (const row of candidates) {
    const { count } = await tx.rfInvoice.updateMany({
      where: { id: row.id, tenantId, status: "OPEN" },
      data: {
        status: "VOID",
        voidedAt: now,
        voidReason: reason,
        ...(row.periodKey ? { periodKey: `${row.periodKey}:void:${row.id}` } : {}),
      },
    });
    if (count === 0) continue; // paid / voided by someone else since the read: leave it alone
    await writeAdminNotice(tx, {
      tenantId,
      actorId,
      action: AdminAuditAction.RF_INVOICE_VOIDED,
      message: `RouteFlow invoice ${row.number} voided.`,
      meta: {
        invoiceId: row.id,
        number: row.number,
        amount: Number(row.amount),
        reason,
        trigger: "activation",
      },
    });
    voided.push(row.id);
  }
  return { voided };
}
