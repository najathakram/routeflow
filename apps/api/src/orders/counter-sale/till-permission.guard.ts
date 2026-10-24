import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import type { OperatorPermissionGroup } from "@prisma/client";
import {
  ALL_PERMISSION_GROUPS,
  OperatorPermissionsService,
  type PermissionPrincipal,
} from "../../auth/permissions/operator-permissions.service";
import { permissionDeniedException } from "../../auth/permissions/permission-errors";
import { STAFF_CAPABILITY_RULES, staffMay } from "../../auth/permissions/staff-capabilities";
import { PrismaService } from "../../prisma/prisma.service";

/**
 * The groups an OPERATOR is denied, read live from the user row (never a JWT claim, never cached). Everyone
 * else is `[]`: TENANT_ADMIN and SUPER_ADMIN (impersonation tokens carry TENANT_ADMIN) always pass, and no
 * permissions read is made for them. `effective()` reports groups HELD, so denied = all groups minus held;
 * an OPERATOR with no row holds nothing, so every group is denied (fail closed).
 */
export async function operatorDeniedGroups(
  prisma: PrismaService,
  user: PermissionPrincipal,
): Promise<OperatorPermissionGroup[]> {
  if (user.role !== UserRole.OPERATOR) return [];
  const held = new Set((await new OperatorPermissionsService(prisma).effective(user)).groups);
  return ALL_PERMISSION_GROUPS.filter((group) => !held.has(group));
}

/**
 * The ONE till predicate (BO-07): may this principal use POS mode? `staffMay` over the groups an OPERATOR is
 * denied, read live. TENANT_ADMIN / SUPER_ADMIN pass with no read; a DRIVER, CUSTOMER or missing principal is
 * refused. The guard, the PICKUP switch (`order-lifecycle.ts`) and the explicit-PICKUP order create all call it.
 */
export async function mayUseTill(
  prisma: PrismaService,
  user: PermissionPrincipal | null | undefined,
): Promise<boolean> {
  if (!user) return false;
  return staffMay(user.role, "USE_POS_MODE", await operatorDeniedGroups(prisma, user));
}

/** `mayUseTill`, or the 403 PERMISSION_DENIED naming the till's group (the guard's own refusal). */
export async function assertMayUseTill(
  prisma: PrismaService,
  user: PermissionPrincipal | null | undefined,
): Promise<void> {
  if (!(await mayUseTill(prisma, user))) {
    throw permissionDeniedException([STAFF_CAPABILITY_RULES.USE_POS_MODE.group]);
  }
}

/**
 * BO-07 (D3): an OPERATOR whose admin switched the ORDERS group off cannot use the till. Runs AFTER
 * RolesGuard (a DRIVER or CUSTOMER never reaches a permissions read). Refusal is a 403 PERMISSION_DENIED
 * naming the group. Not on the counter-sale void, which stays on VOID_SALE.
 */
@Injectable()
export class TillPermissionGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const user = context.switchToHttp().getRequest().user as PermissionPrincipal | undefined;
    // Fail closed: no principal means the auth guards did not run, never "allowed".
    if (!user) throw permissionDeniedException([STAFF_CAPABILITY_RULES.USE_POS_MODE.group]);
    if (user.role !== UserRole.OPERATOR) return true;
    await assertMayUseTill(this.prisma, user);
    return true;
  }
}
