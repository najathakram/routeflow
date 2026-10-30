import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { FulfillPath, UserRole } from "@prisma/client";
import type { OperatorPermissionGroup } from "@prisma/client";
import { operatorDeniedGroups } from "../../auth/permissions/operator-denied-groups";
import {
  OperatorPermissionsService,
  type PermissionPrincipal,
} from "../../auth/permissions/operator-permissions.service";
import { permissionDeniedException } from "../../auth/permissions/permission-errors";
import {
  STAFF_CAPABILITY_RULES,
  staffMay,
  type StaffCapability,
} from "../../auth/permissions/staff-capabilities";
import { PrismaService } from "../../prisma/prisma.service";

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
 * W-870: the denials the fulfil-path resolver's POS mode needs (`fulfilCaller(user, ...)`). POS mode only decides an
 * explicit PICKUP, so any other request reads nothing and is `[]`; a PICKUP request reads `operatorDeniedGroups`.
 */
export async function posModeDeniedGroups(
  prisma: PrismaService,
  user: PermissionPrincipal,
  requested: FulfillPath | null | undefined,
): Promise<OperatorPermissionGroup[]> {
  return requested === FulfillPath.PICKUP ? operatorDeniedGroups(prisma, user) : [];
}

/**
 * W-870: a staff capability decided on the request path, over the principal's denied groups read live; else the 403
 * PERMISSION_DENIED naming the capability's group. The office void of a till payment calls it with VOID_SALE.
 */
export async function assertStaffMay(
  prisma: PrismaService,
  user: PermissionPrincipal,
  action: StaffCapability,
): Promise<void> {
  if (!staffMay(user.role, action, await operatorDeniedGroups(prisma, user))) {
    throw permissionDeniedException([STAFF_CAPABILITY_RULES[action].group]);
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
