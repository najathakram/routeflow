import type { PrismaService } from "../prisma/prisma.service";
import type { UpdateCustomerDto } from "./dto/update-customer.dto";
import { omitStaffOnlyCustomerFields, pickSelfServiceFields } from "./self-service-fields";

/** Which self-service route made the change (recorded in the audit meta). */
export type SelfServiceSource = "customers/me" | "buyer/me";

export const SELF_SERVICE_PROFILE_AUDIT_ACTION = "customer.self_service.profile_update";

/**
 * One audit row per self-service profile change: who (the signed-in customer or buyer account), which
 * customer record, through which route, and WHICH fields changed. Field names only, never the values
 * (contact data stays out of the audit trail). Nothing is written for an empty edit. Written with
 * `auditLog.create` (not `AuditService.log`, which swallows errors) so a failed insert is visible.
 */
export async function auditSelfServiceProfileChange(
  prisma: PrismaService,
  args: {
    customerId: string;
    actorId: string;
    source: SelfServiceSource;
    fields: object;
  },
): Promise<void> {
  const names = Object.keys(args.fields).sort();
  if (names.length === 0) return;
  await prisma.auditLog.create({
    data: {
      tenantId: prisma.getTenantId(),
      userId: args.actorId,
      action: SELF_SERVICE_PROFILE_AUDIT_ACTION,
      entityType: "Customer",
      entityId: args.customerId,
      meta: { source: args.source, fields: names },
    },
  });
}

export interface SelfServiceWriteArgs {
  customerId: string;
  actorId: string;
  source: SelfServiceSource;
  body: object;
}

/**
 * The ONE self-service profile write (PATCH /customers/me and PATCH /buyer/me): only the allowlisted
 * contact fields reach `update`, whatever the body carries, a change leaves an audit row, and the reply
 * omits the staff-only fields. Lives here (not in customers.service.ts) to hold that file's size ratchet.
 */
export async function writeSelfServiceProfile<T extends Record<string, unknown>>(
  prisma: PrismaService,
  update: (fields: UpdateCustomerDto) => Promise<T>,
  args: SelfServiceWriteArgs,
) {
  const fields = pickSelfServiceFields({ ...args.body }) as UpdateCustomerDto;
  const updated = await update(fields);
  await auditSelfServiceProfileChange(prisma, { ...args, fields });
  return omitStaffOnlyCustomerFields(updated);
}
