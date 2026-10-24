import { ADMIN_AUDIT_ENTITY } from "../platform-admin/audit-actions.constant";

/** What the platform must do on a manually-invoiced tenant's invoice for one add-on. */
export interface ManualInvoiceNotice {
  tenantId: string;
  actorId?: string | null;
  action: string;
  sku: string;
  quantity: number;
  monthlyPrice: number;
  message: string;
  kind: "add" | "stop" | "change";
  addonName: string;
  fromQty: number;
  toQty: number;
  /** Billing cycle the owner invoices on — written only for ANNUAL, with `cycleAmount`. */
  cycle?: "MONTHLY" | "ANNUAL";
  /** What this line comes to per `cycle` (annual: cyclePrice × qty). The ledger's MRR stays monthly. */
  cycleAmount?: number;
  /** Set when the owner must complete the line before invoicing it. */
  reason?: "price_unknown" | "quantity_missing";
}

/**
 * A platform notice for a manually-invoiced tenant, in the platform-admin audit feed (the one existing
 * per-tenant notice channel; same row shape as `PlatformAdminService.recordAdminAction`), written in the
 * caller's transaction so it can never exist without the change it announces. Shared by the self-serve
 * enable/disable paths and the manual activation that prices a trial's add-ons.
 */
export async function writeManualInvoiceNotice(tx: any, n: ManualInvoiceNotice): Promise<void> {
  await tx.auditLog.create({
    data: {
      tenantId: n.tenantId,
      userId: n.actorId ?? null,
      action: n.action,
      entityType: ADMIN_AUDIT_ENTITY,
      entityId: n.tenantId,
      meta: {
        platformAdmin: true,
        sku: n.sku,
        quantity: n.quantity,
        monthlyPrice: n.monthlyPrice,
        message: n.message,
        addonName: n.addonName,
        kind: n.kind,
        fromQty: n.fromQty,
        toQty: n.toQty,
        ...(n.cycle === "ANNUAL" ? { cycle: n.cycle, cycleAmount: n.cycleAmount } : {}),
        ...(n.reason ? { reason: n.reason } : {}),
      },
    },
  });
}

/**
 * A free-form platform notice in the same admin audit feed (same row shape as the manual-invoice notices),
 * written in the caller's transaction: an operator-facing message plus whatever ids they need to act on it.
 */
export async function writeAdminNotice(
  tx: any,
  n: {
    tenantId: string;
    actorId?: string | null;
    action: string;
    message: string;
    meta?: Record<string, unknown>;
  },
): Promise<void> {
  await tx.auditLog.create({
    data: {
      tenantId: n.tenantId,
      userId: n.actorId ?? null,
      action: n.action,
      entityType: ADMIN_AUDIT_ENTITY,
      entityId: n.tenantId,
      meta: { platformAdmin: true, message: n.message, ...(n.meta ?? {}) },
    },
  });
}
