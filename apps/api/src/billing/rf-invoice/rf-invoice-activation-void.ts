import { ADMIN_AUDIT_ENTITY, AdminAuditAction } from "../../platform-admin/audit-actions.constant";
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
 * Owner ruling (PR4a): a Manual Activation that records a new prepaid period [windowStart, windowEnd) - the
 * period the activation itself writes - VOIDS every OPEN RouteFlow invoice that period fully covers, in the
 * SAME transaction, so the queue never asks for money the activation already recorded.
 *
 * Fully covered = invoice.periodStart >= windowStart AND invoice.periodEnd <= windowEnd. Each void is a CAS
 * (`status: "OPEN"`, tenant-scoped) shaped exactly like the admin void: periodKey becomes "<iso>:void:<id>",
 * plus an RF_INVOICE_VOIDED audit row.
 *
 * A PARTIAL overlap is never voided: it stays OPEN, is flagged `needsReview`, and one claim-keyed
 * RF_INVOICE_PARTLY_COVERED notice is raised per invoice (a rerun adds none). PAID / VOID rows and rows with
 * no period are never touched.
 */
export async function voidCoveredRfInvoices(
  tx: any,
  input: VoidCoveredInput,
): Promise<{ voided: string[]; flagged: string[] }> {
  const { tenantId, windowStart, windowEnd, actorId, now } = input;
  const overlapping: Array<{
    id: string;
    number: string;
    amount: unknown;
    periodKey: string | null;
    periodStart: Date;
    periodEnd: Date;
  }> = await tx.rfInvoice.findMany({
    where: {
      tenantId,
      status: "OPEN",
      periodStart: { lt: windowEnd },
      periodEnd: { gt: windowStart },
    },
    select: {
      id: true,
      number: true,
      amount: true,
      periodKey: true,
      periodStart: true,
      periodEnd: true,
    },
  });

  const day = now.toISOString().slice(0, 10);
  const reason = `Covered by manual activation on ${day}`;
  const voided: string[] = [];
  const flagged: string[] = [];
  for (const row of overlapping) {
    const full =
      row.periodStart.getTime() >= windowStart.getTime() &&
      row.periodEnd.getTime() <= windowEnd.getTime();
    if (!full) {
      const { count } = await tx.rfInvoice.updateMany({
        where: { id: row.id, tenantId, status: "OPEN" },
        data: { needsReview: true },
      });
      if (count === 0) continue;
      flagged.push(row.id);
      await raisePartlyCoveredOnce(tx, tenantId, actorId, row, day);
      continue;
    }
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
  return { voided, flagged };
}

/** One notice per invoice: the claim key is looked up under an advisory lock, in the caller's transaction. */
async function raisePartlyCoveredOnce(
  tx: any,
  tenantId: string,
  actorId: string | null,
  row: { id: string; number: string },
  day: string,
): Promise<void> {
  const action = AdminAuditAction.RF_INVOICE_PARTLY_COVERED;
  const dedupeKey = `${action}:${tenantId}:${row.id}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"admin-alert"}), hashtext(${dedupeKey}))`;
  const seen = await tx.auditLog.findFirst({
    where: {
      tenantId,
      entityType: ADMIN_AUDIT_ENTITY,
      action,
      meta: { path: ["dedupeKey"], equals: dedupeKey },
    },
    select: { id: true },
  });
  if (seen) return;
  await writeAdminNotice(tx, {
    tenantId,
    actorId,
    action,
    message: `Partly covered by manual activation on ${day}`,
    meta: { invoiceId: row.id, number: row.number, dedupeKey },
  });
}
