import { AdminAuditAction } from "../platform-admin/audit-actions.constant";
import type { ReportWarning } from "./report-types";

/**
 * SA-789 / SA-835: a regulated reversal the ledger could not book (its sold line resolves nowhere) is
 * raised as an admin notice (`REGULATED_REVERSAL_UNBOOKED`). The report for the period counts these
 * notices so a filing never looks clean while a reversal is missing.
 */

/** The notice meta: ids and numbers only (no names). Exactly one of returnId / creditNoteId is set. */
export interface UnbookedReversalMeta {
  tenantId: string;
  returnId: string | null;
  creditNoteId: string | null;
  /** The line the reversal was for: the sold order line (return) or the credit-note item (credit note). */
  lineId: string | null;
  saleEntryId: string;
  qty: number;
  /** Return path: the returned units still unbooked after the walk, per product id. */
  unbookedByProduct?: Record<string, number>;
  /** "YYYY-MM" the reversal would have booked into. */
  period: string;
}

export function unbookedReversalMeta(m: UnbookedReversalMeta): Record<string, unknown> {
  return {
    tenantId: m.tenantId,
    returnId: m.returnId,
    creditNoteId: m.creditNoteId,
    lineId: m.lineId,
    saleEntryId: m.saleEntryId,
    qty: m.qty,
    ...(m.unbookedByProduct ? { unbookedByProduct: m.unbookedByProduct } : {}),
    period: m.period,
  };
}

/**
 * Reversals (distinct returns / credit notes, not notice rows) with a notice written in
 * [from, toExclusive) for ONE tenant. The count is per tenant, not per tracked category: a notice
 * does not name its category, so a period shows the tenant's whole count, which leans safe (never
 * hides a missing reversal). The tenant is explicit because `forTenant()` does not scope a super
 * admin who is not impersonating.
 */
export async function countUnbookedReversals(
  db: any,
  range: { from: Date; toExclusive: Date },
  tenantId: string | null | undefined,
): Promise<number> {
  if (!tenantId) return 0;
  const notices: Array<{ meta: unknown }> = await db.auditLog.findMany({
    where: {
      tenantId,
      action: AdminAuditAction.REGULATED_REVERSAL_UNBOOKED,
      createdAt: { gte: range.from, lt: range.toExclusive },
    },
    select: { meta: true },
  });
  const reversals = new Set<string>();
  for (const n of notices ?? []) {
    const m = (n.meta ?? {}) as { returnId?: string | null; creditNoteId?: string | null };
    const id = m.returnId ?? m.creditNoteId;
    if (id) reversals.add(id);
  }
  return reversals.size;
}

export function unbookedReversalsWarning(count: number): ReportWarning | null {
  if (count <= 0) return null;
  return {
    code: "UNBOOKED_REVERSALS",
    message: `${count} reversals could not be booked; contact support.`,
  };
}
