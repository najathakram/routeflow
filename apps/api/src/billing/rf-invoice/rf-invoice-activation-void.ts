import { ADMIN_AUDIT_ENTITY, AdminAuditAction } from "../../platform-admin/audit-actions.constant";
import { writeAdminNotice } from "../manual-invoice-notice";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Owner ruling (option A): the prepaid window a Manual Activation records starts where the tenant's unpaid
 * RouteFlow billing starts, not at the click. With at least one OPEN invoice that has a period, windowStart is
 * the EARLIEST such invoice's periodStart and windowEnd = windowStart + the activation length; the subscription
 * period (and so the renewal the invoice issuer reads) is written from that window. With no OPEN invoice there
 * is nothing to anchor to, so windowStart = now (today's behaviour). PAID / VOID rows and rows with no period
 * never anchor. Call it inside the activation transaction, after the Tenant row lock.
 */
export async function resolveActivationWindow(
  tx: any,
  input: { tenantId: string; now: Date; days: number },
): Promise<{ windowStart: Date; windowEnd: Date }> {
  const earliest: { periodStart: Date | null } | null = await tx.rfInvoice.findFirst({
    where: { tenantId: input.tenantId, status: "OPEN", periodStart: { not: null } },
    orderBy: { periodStart: "asc" },
    select: { periodStart: true },
  });
  const windowStart = earliest?.periodStart ?? input.now;
  return { windowStart, windowEnd: new Date(windowStart.getTime() + input.days * DAY_MS) };
}

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
 * no period are never touched. A `needsReview` row gets no automatic email (the mailer
 * skips it); the office resolves it by hand (void or mark paid), and a manual resend still works.
 *
 * LOCK ORDER (the caller already holds the first): `Tenant FOR UPDATE` -> admin-alert advisory locks ->
 * RfInvoice row writes. The advisory locks for every partly covered invoice are therefore taken UP FRONT, in
 * id order, before any RfInvoice row is updated. The other admin-alert takers (the invoice issuer's
 * raiseOnce, the subscription mutation service's raiseAdminAlertOnce) each take ONE lock in their own short
 * transaction, on a key built from a different action, and touch no RfInvoice row under it. Their audit insert
 * may wait on the Tenant row this activation holds, but the activation never waits on their key, so no cycle.
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
  const isFull = (row: { periodStart: Date; periodEnd: Date }) =>
    row.periodStart.getTime() >= windowStart.getTime() &&
    row.periodEnd.getTime() <= windowEnd.getTime();

  // Lock order: the admin-alert advisory locks come BEFORE the first RfInvoice write, in a stable order.
  const partial = overlapping.filter((r) => !isFull(r)).sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const row of partial) {
    await lockAdminAlert(tx, partlyCoveredKey(tenantId, row.id));
  }

  const voided: string[] = [];
  const flagged: string[] = [];
  for (const row of overlapping) {
    if (!isFull(row)) {
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

function partlyCoveredKey(tenantId: string, invoiceId: string): string {
  return `${AdminAuditAction.RF_INVOICE_PARTLY_COVERED}:${tenantId}:${invoiceId}`;
}

/** Transaction-scoped admin-alert advisory lock, the SAME key every `raise...Once` taker uses. */
async function lockAdminAlert(tx: any, dedupeKey: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"admin-alert"}), hashtext(${dedupeKey}))`;
}

/**
 * One notice per invoice: the claim key is looked up in the caller's transaction, under the admin-alert
 * advisory lock the caller already took (see the lock order on `voidCoveredRfInvoices`).
 */
async function raisePartlyCoveredOnce(
  tx: any,
  tenantId: string,
  actorId: string | null,
  row: { id: string; number: string },
  day: string,
): Promise<void> {
  const action = AdminAuditAction.RF_INVOICE_PARTLY_COVERED;
  const dedupeKey = partlyCoveredKey(tenantId, row.id);
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
