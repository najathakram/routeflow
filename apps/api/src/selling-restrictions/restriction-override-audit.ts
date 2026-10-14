import { AUDIT_ACTIONS } from "../audit/audit-actions.constant";

/**
 * Row 510: the audit trail of a staff restriction override. ONE AuditLog row per NEWLY stamped line, written through
 * the caller's transaction client (`tx.auditLog.create`), never `AuditService.log` (outside the tx, and it swallows
 * errors): an override without its audit row is a compliance hole, so a failed insert rolls the whole write back.
 * A carried stamp (an existing override copied or re-applied) writes no row; the caller passes only new stamps.
 *
 * Pure apart from the writes; the stamping itself (restriction-override-stamps.ts) and the callers are brief 2.
 */

export type OverrideLineEntity = "OrderItem" | "InvoiceItem";
export type OverrideDocumentType = "ORDER" | "INVOICE";
export type OverrideBasis = "CUSTOMER" | "STORE";

/** The write all the stamped lines belong to. */
export interface OverrideAuditContext {
  tenantId: string;
  /** The overriding User id (the stamp's `restrictionOverrideBy`). */
  by: string;
  /** The platform operator's id when the write happened under impersonation (AuditLog.impersonatedBy). */
  impersonatedBy?: string | null;
  entityType: OverrideLineEntity;
  documentType: OverrideDocumentType;
  documentId: string;
  /** The hash the client acknowledged; null for a stamp with no warning round trip (the historical import marker). */
  warningHash: string | null;
  basis: OverrideBasis;
}

/** One newly stamped line. */
export interface OverrideAuditLine {
  lineId: string;
  productId: string;
  lineKey: string;
  ruleIds: string[];
  reason: string;
}

/** The minimal transaction-client surface this needs (a Prisma tx, or a test double). */
export interface AuditLogTx {
  auditLog: { create(args: { data: OverrideAuditRow }): Promise<unknown> };
}

export interface OverrideAuditRow {
  tenantId: string;
  userId: string;
  impersonatedBy: string | null;
  action: typeof AUDIT_ACTIONS.SELLING_RESTRICTION_OVERRIDDEN;
  entityType: OverrideLineEntity;
  entityId: string;
  meta: {
    documentType: OverrideDocumentType;
    documentId: string;
    productId: string;
    ruleIds: string[];
    reason: string;
    lineKey: string;
    warningHash: string | null;
    basis: OverrideBasis;
  };
}

function required(value: string, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`restriction override audit: ${name} is required`);
  }
  return value;
}

/** The rows for `lines`, in order. Throws on a missing id (an audit row must name what it audits). */
export function overrideAuditRows(
  ctx: OverrideAuditContext,
  lines: readonly OverrideAuditLine[],
): OverrideAuditRow[] {
  const tenantId = required(ctx.tenantId, "tenantId");
  const userId = required(ctx.by, "by");
  const documentId = required(ctx.documentId, "documentId");
  return lines.map((line) => ({
    tenantId,
    userId,
    impersonatedBy: ctx.impersonatedBy ?? null,
    action: AUDIT_ACTIONS.SELLING_RESTRICTION_OVERRIDDEN,
    entityType: ctx.entityType,
    entityId: required(line.lineId, "lineId"),
    meta: {
      documentType: ctx.documentType,
      documentId,
      productId: required(line.productId, "productId"),
      ruleIds: [...line.ruleIds].sort(),
      reason: line.reason,
      lineKey: line.lineKey,
      warningHash: ctx.warningHash,
      basis: ctx.basis,
    },
  }));
}

/**
 * Write one audit row per newly stamped line through `tx`, sequentially (one tx connection), and return the count.
 * All rows are built (and every id checked) before the first insert. Zero lines writes nothing.
 */
export async function writeOverrideAuditRows(
  tx: AuditLogTx,
  ctx: OverrideAuditContext,
  lines: readonly OverrideAuditLine[],
): Promise<number> {
  const rows = overrideAuditRows(ctx, lines);
  for (const data of rows) await tx.auditLog.create({ data });
  return rows.length;
}
