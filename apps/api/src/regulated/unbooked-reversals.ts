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

/** Notices written in [from, toExclusive), tenant-scoped through the caller's `forTenant()` client. */
export async function countUnbookedReversals(
  db: any,
  range: { from: Date; toExclusive: Date },
): Promise<number> {
  return db.auditLog.count({
    where: {
      action: AdminAuditAction.REGULATED_REVERSAL_UNBOOKED,
      createdAt: { gte: range.from, lt: range.toExclusive },
    },
  });
}

export function unbookedReversalsWarning(count: number): ReportWarning | null {
  if (count <= 0) return null;
  return {
    code: "UNBOOKED_REVERSALS",
    message: `${count} reversals could not be booked; contact support.`,
  };
}
