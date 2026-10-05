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
      },
    },
  });
}
