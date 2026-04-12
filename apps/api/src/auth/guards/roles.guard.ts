import { Injectable, CanActivate, ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { UserRole } from "@prisma/client";
import { ROLES_KEY } from "../decorators/roles.decorator";

/**
 * Role hierarchy for access checks:
 * - SUPER_ADMIN satisfies every role requirement
 * - TENANT_ADMIN satisfies OPERATOR (and itself)
 * - OPERATOR/TENANT_ADMIN with canActAsDriver also satisfies DRIVER
 */
const ROLE_SATISFIES: Record<UserRole, UserRole[]> = {
  [UserRole.SUPER_ADMIN]: [
    UserRole.SUPER_ADMIN,
    UserRole.TENANT_ADMIN,
    UserRole.OPERATOR,
    UserRole.DRIVER,
    UserRole.CUSTOMER,
  ],
  [UserRole.TENANT_ADMIN]: [UserRole.TENANT_ADMIN, UserRole.OPERATOR],
  [UserRole.OPERATOR]: [UserRole.OPERATOR],
  [UserRole.DRIVER]: [UserRole.DRIVER],
  [UserRole.CUSTOMER]: [UserRole.CUSTOMER],
};

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!requiredRoles || requiredRoles.length === 0) return false;
    const { user } = context.switchToHttp().getRequest();
    if (!user?.role) return false;

    const satisfied = [...(ROLE_SATISFIES[user.role as UserRole] ?? [user.role])];

    // Operators / tenant admins who can act as drivers also satisfy DRIVER role
    if (
      user.canActAsDriver &&
      (user.role === UserRole.OPERATOR || user.role === UserRole.TENANT_ADMIN) &&
      !satisfied.includes(UserRole.DRIVER)
    ) {
      satisfied.push(UserRole.DRIVER);
    }

    return requiredRoles.some((r) => satisfied.includes(r));
  }
}
