import { ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../../common/api-error-codes";
import { ADMIN_AUDIT_ENTITY, AdminAuditAction } from "../../platform-admin/audit-actions.constant";
import { writeAdminNotice } from "../manual-invoice-notice";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ActivationWindow {
  windowStart: Date;
  windowEnd: Date;
  /** The OLDEST open invoice with a period that anchored the window; null when the window starts at now. */
  blocking: { number: string; periodStart: Date; periodEnd: Date } | null;
}

/**
 * Owner ruling (option A): the prepaid window a Manual Activation records starts where the tenant's unpaid
 * RouteFlow billing starts, not at the click. With at least one OPEN invoice that has a period, windowStart is
 * the EARLIEST such invoice's periodStart and windowEnd = windowStart + the activation length; the subscription
 * period (and so the renewal the invoice issuer reads) is written from that window. With no OPEN invoice there
 * is nothing to anchor to, so windowStart = now (today's behaviour). PAID / VOID rows and rows with no period
 * never anchor. The invoice issuer bills ahead (a 7-day lead), so the oldest OPEN invoice can start in the
 * FUTURE: windowStart is then in the future too and the window is not "ended" (nothing is refused); the
 * activation records a prepaid period that starts later than today, exactly the period that invoice asked for.
 * Call it inside the activation transaction, after the Tenant row lock.
 */
export async function resolveActivationWindow(
  tx: any,
  input: { tenantId: string; now: Date; days: number },
): Promise<ActivationWindow> {
  const earliest: { number: string; periodStart: Date; periodEnd: Date | null } | null =
    await tx.rfInvoice.findFirst({
      where: { tenantId: input.tenantId, status: "OPEN", periodStart: { not: null } },
      orderBy: { periodStart: "asc" },
      select: { number: true, periodStart: true, periodEnd: true },
    });
  const windowStart = earliest?.periodStart ?? input.now;
  return {
    windowStart,
    windowEnd: new Date(windowStart.getTime() + input.days * DAY_MS),
    blocking: earliest
      ? {
          number: earliest.number,
          periodStart: earliest.periodStart,
          // a row with a start but no end (legacy) is treated as ending at the window start: it never extends minDays
          periodEnd: earliest.periodEnd ?? earliest.periodStart,
        }
      : null,
  };
}

/**
 * Owner ruling (SA): an activation whose prepaid window has already ended (windowEnd <= now) is REFUSED, never
 * clamped - the payment covers a period that is over, so recording it would leave the newer periods unbilled or
 * billed twice. 409 ACTIVATION_PERIOD_ALREADY_ENDED, thrown inside the activation transaction right after
 * `resolveActivationWindow` and BEFORE any write, so the transaction rolls back with nothing changed.
 *
 * The refusal NAMES the blocking invoice (the oldest OPEN one, which anchored the window) and the real fixes:
 * mark it paid or void it in RouteFlow invoices, or activate for at least `minDays`. The body carries
 * `invoiceNumber`, `endedOn` (ISO date the window ended) and `minDays` so the web builds its own copy.
 * `minDays` is the smallest whole-day length whose window ends after `now` AND covers the blocking invoice's
 * whole period (a shorter window would only flag it needsReview).
 */
export function assertActivationWindowNotEnded(window: ActivationWindow, now: Date): void {
  if (window.windowEnd.getTime() > now.getTime()) return;
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const endedOn = iso(window.windowEnd);
  const { blocking } = window;
  const reachNow = Math.floor((now.getTime() - window.windowStart.getTime()) / DAY_MS) + 1;
  const coverInvoice = blocking
    ? Math.ceil((blocking.periodEnd.getTime() - window.windowStart.getTime()) / DAY_MS)
    : 0;
  const minDays = Math.max(reachNow, coverInvoice);
  const message = blocking
    ? `Invoice ${blocking.number} (${iso(blocking.periodStart)} to ${iso(blocking.periodEnd)}) is still open and this payment's window ended on ${endedOn}. Mark it paid or void it in RouteFlow invoices, or activate for at least ${minDays} days.`
    : `This payment's window ended on ${endedOn}. Activate for at least ${minDays} days.`;
  throw new ConflictException({
    code: API_ERROR_CODES.ACTIVATION_PERIOD_ALREADY_ENDED,
    message,
    ...(blocking ? { invoiceNumber: blocking.number } : {}),
    endedOn,
    minDays,
  });
}

/**
 * PR4a (SA M2): a window anchored at the oldest OPEN invoice may run over a RouteFlow invoice that is already PAID
 * (OPEN Aug, PAID Sep, OPEN Oct, a 90-day activation from Aug 1). Recording that window would take September's
 * payment twice. REFUSED 409 ACTIVATION_OVERLAPS_PAID_PERIOD before any write, naming the paid invoice and the
 * longest activation that stops short of it (`maxDays`, 0 when the paid period already covers the window start).
 * Only an ANCHORED window is checked: with no OPEN invoice the window starts at now exactly as it always did.
 */
export async function assertWindowClearOfPaidInvoices(
  tx: any,
  input: { tenantId: string; window: ActivationWindow },
): Promise<void> {
  const { window } = input;
  if (!window.blocking) return;
  const paid: { number: string; periodStart: Date; periodEnd: Date } | null =
    await tx.rfInvoice.findFirst({
      where: {
        tenantId: input.tenantId,
        status: "PAID",
        periodStart: { lt: window.windowEnd },
        periodEnd: { gt: window.windowStart },
      },
      orderBy: { periodStart: "asc" },
      select: { number: true, periodStart: true, periodEnd: true },
    });
  if (!paid) return;
  const paidFrom = paid.periodStart.toISOString().slice(0, 10);
  const maxDays = Math.max(
    0,
    Math.floor((paid.periodStart.getTime() - window.windowStart.getTime()) / DAY_MS),
  );
  throw new ConflictException({
    code: API_ERROR_CODES.ACTIVATION_OVERLAPS_PAID_PERIOD,
    message:
      `Invoice ${paid.number} is already paid (its period starts ${paidFrom}) and this activation window would cover it again. ` +
      (maxDays >= 1
        ? `Activate for at most ${maxDays} days, or mark the older open invoices paid or void them instead.`
        : "Mark the older open invoices paid or void them in RouteFlow invoices instead."),
    invoiceNumber: paid.number,
    paidFrom,
    maxDays,
  });
}

/** How long the same payment, sent again, counts as a repeat of the first (a double-click or a retried request). */
const REPEAT_WINDOW_MS = 2 * 60 * 1000;

export interface RecentActivation {
  periodStart: Date;
  periodEnd: Date;
}

/**
 * PR4a idempotency (SA M3): the activation recorded by the SAME payment seconds ago. The marker row written in the
 * first activation's transaction carries the key (plan, payment method, payment reference, length); the caller
 * looks it up under the Tenant row lock, so two clicks serialise and the second one finds the first's marker.
 * Markers written before this field existed carry no `billingPeriodDays` and never match.
 */
export async function findRecentIdenticalActivation(
  tx: any,
  input: {
    tenantId: string;
    now: Date;
    plan: string;
    paymentMethod: string;
    paymentRef: string | null;
    days: number;
  },
): Promise<RecentActivation | null> {
  const row: { meta: Record<string, unknown> | null } | null = await tx.auditLog.findFirst({
    where: {
      tenantId: input.tenantId,
      entityType: ADMIN_AUDIT_ENTITY,
      action: AdminAuditAction.TENANT_MANUAL_ACTIVATION_MARKER,
      createdAt: { gte: new Date(input.now.getTime() - REPEAT_WINDOW_MS) },
    },
    orderBy: { createdAt: "desc" },
    select: { meta: true },
  });
  const m = row?.meta;
  if (!m) return null;
  if (
    m.plan !== input.plan ||
    m.paymentMethod !== input.paymentMethod ||
    (m.paymentRef ?? null) !== input.paymentRef ||
    m.billingPeriodDays !== input.days
  ) {
    return null;
  }
  const start = typeof m.periodStart === "string" ? new Date(m.periodStart) : null;
  const end = typeof m.periodEnd === "string" ? new Date(m.periodEnd) : null;
  if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  return { periodStart: start, periodEnd: end };
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
 * (`status: "OPEN"`, tenant-scoped) plus an RF_INVOICE_VOIDED audit row.
 *
 * ACTIVATION void vs ADMIN void (the difference is the periodKey). An activation void is "settled outside,
 * period consumed": the voided row KEEPS its periodKey, so the (tenant, periodKey) unique still holds the slot
 * and the issuer's catch-up branch (a paid prior row ends where this period starts) finds the key taken and
 * re-bills nothing. The admin void (RfInvoicesService.voidInvoice) is "period released": it renames the key to
 * "<iso>:void:<id>" so a corrected invoice can be issued for the same period. Do not copy that rename here.
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
        // periodKey is deliberately NOT renamed: the period is consumed (see the header), unlike the admin void.
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
