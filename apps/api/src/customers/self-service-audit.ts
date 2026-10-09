import type { PrismaService } from "../prisma/prisma.service";
import type { UpdateCustomerDto } from "./dto/update-customer.dto";
import { omitStaffOnlyCustomerFields, pickSelfServiceFields } from "./self-service-fields";

/** Which self-service route made the change (recorded in the audit meta). */
export type SelfServiceSource = "customers/me" | "buyer/me";

export const SELF_SERVICE_PROFILE_AUDIT_ACTION = "customer.self_service.profile_update";

/**
 * One audit row per self-service profile change: who (the signed-in customer or buyer account, plus the
 * platform operator when acting under impersonation), which customer record, through which route, and
 * which fields were SUBMITTED (allow-listed names; an unchanged value still counts). Field names only, never the values
 * (contact data stays out of the audit trail). Nothing is written for an empty edit. Written with
 * `auditLog.create` (not `AuditService.log`, which swallows errors) so a failed insert is visible.
 */
export async function auditSelfServiceProfileChange(
  prisma: PrismaService,
  args: SelfServiceWriteArgs & { fields: object },
): Promise<void> {
  const names = Object.keys(args.fields).sort();
  if (names.length === 0) return;
  await prisma.auditLog.create({
    data: {
      tenantId: prisma.getTenantId(),
      userId: args.actor.sub,
      impersonatedBy: args.actor.impersonatedBy ?? null,
      action: SELF_SERVICE_PROFILE_AUDIT_ACTION,
      entityType: "Customer",
      entityId: args.customerId,
      meta: {
        source: args.source,
        actorType: args.source === "buyer/me" ? "BUYER_ACCOUNT" : "USER",
        fields: names,
      },
    },
  });
}

export interface SelfServiceWriteArgs {
  customerId: string;
  /** The verified request user (JwtPayload or BuyerJwtPayload): `sub` plus the impersonating operator, if any. */
  actor: { sub: string; impersonatedBy?: string };
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
  // The audit write follows the update and is NOT in its transaction: update() takes no tx parameter, and
  // AuditLog has no FKs to roll back with. Accepted: a failed insert surfaces as an error (never swallowed).
  await auditSelfServiceProfileChange(prisma, { ...args, fields });
  return omitStaffOnlyCustomerFields(updated);
}
