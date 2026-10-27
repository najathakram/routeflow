import { Injectable, CanActivate, ExecutionContext, Logger, Optional } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { UserRole } from "@prisma/client";
import { ROLES_KEY } from "../decorators/roles.decorator";
import { PERMISSION_BASE_KEY, PERMISSION_KEY } from "../permissions/permission.decorators";
import { OperatorPermissionsService } from "../permissions/operator-permissions.service";
import { permissionDeniedException } from "../permissions/permission-errors";
import type { OperatorPermissionGroup } from "@prisma/client";

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
  private readonly logger = new Logger(RolesGuard.name);

  // The permission service is optional so every spec that builds `new RolesGuard(reflector)` is unchanged. In the app it
  // is always injected: `roles.guard.optional-di.spec.ts` pins that the global module provides it, because an
  // @Optional() that silently resolves to undefined would turn the whole permission check off.
  constructor(
    private readonly reflector: Reflector,
    @Optional() private readonly permissions?: OperatorPermissionsService,
  ) {}

  canActivate(context: ExecutionContext): boolean | Promise<boolean> {
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

    if (!requiredRoles.some((r) => satisfied.includes(r))) return false;

    // Operator feature groups (spec-operator-permissions §4.1): only an OPERATOR on a handler that names groups.
    // Still synchronous for everyone else, so no existing caller or spec changes.
    if (user.role !== UserRole.OPERATOR || !this.permissions) return true;
    // Method metadata overrides class metadata, and a method may state EITHER a group list OR "base" (any operator).
    const groups = this.permissionGroupsOf(context);
    if (!groups || groups.length === 0) return true;
    return this.checkGroups(context, user, groups);
  }

  /** The groups the handler names, or null when it is PermissionBase / unmarked (any operator). Nearest metadata wins. */
  private permissionGroupsOf(context: ExecutionContext): OperatorPermissionGroup[] | null {
    for (const target of [context.getHandler(), context.getClass()]) {
      if (this.reflector.get(PERMISSION_BASE_KEY, target) !== undefined) return null;
      const groups = this.reflector.get<OperatorPermissionGroup[] | undefined>(
        PERMISSION_KEY,
        target,
      );
      if (groups !== undefined) return groups;
    }
    return null;
  }

  private async checkGroups(
    context: ExecutionContext,
    user: { sub: string; tenantId: string | null; role: UserRole },
    groups: OperatorPermissionGroup[],
  ): Promise<boolean> {
    const permissions = this.permissions!;
    // Everything that can throw sits inside the try: in SHADOW nothing here may ever block an operator.
    let mode: ReturnType<OperatorPermissionsService["mode"]> | undefined;
    let where = `handler=${context.getClass().name}.${context.getHandler().name} tenant=${user.tenantId ?? "-"}`;
    let allowed: boolean;
    try {
      mode = permissions.mode();
      where += ` route=${routeOf(context)}`;
      allowed = await permissions.hasAny(user, groups);
    } catch (err) {
      // SHADOW observes only: a failed lookup must never block an operator, so log it and allow.
      if (mode === "shadow") {
        this.logger.error(
          `permission lookup failed (shadow, allowed) groups=${groups.join("|")} ${where}: ${describeLookupError(err)}`,
        );
        return true;
      }
      // Anything but a confirmed shadow (live, or mode() itself threw) fails closed: no answer is never an allow.
      if (mode !== "live") {
        this.logger.error(
          `permission lookup failed (mode unknown, refused) mode=${String(mode)} groups=${groups.join("|")} ${where}: ${describeLookupError(err)}`,
        );
      }
      throw err;
    }
    if (allowed) return true;
    // Only a confirmed shadow allows a deny: live, or any mode this guard does not know, is refused.
    if (mode !== "shadow") {
      if (mode !== "live") {
        this.logger.error(
          `permission mode unknown (refused) mode=${String(mode)} groups=${groups.join("|")} ${where}`,
        );
      }
      throw permissionDeniedException(groups);
    }
    // SHADOW: record what enforcement would do, allow the request.
    this.logger.warn(`would-deny groups=${groups.join("|")} ${where}`);
    return true;
  }
}

/** "METHOD /path" without the query string (ids and search terms stay out of the log), as the add-on gate logs it. */
function routeOf(context: ExecutionContext): string {
  const req = context.switchToHttp().getRequest<{
    method?: string;
    originalUrl?: string;
    url?: string;
  }>();
  const path = (req.originalUrl ?? req.url ?? "?").split("?")[0];
  return `${req.method ?? "?"} ${path}`;
}

/**
 * The name and Prisma code of a failed lookup, never its message: a database error message can carry the query's
 * where-arguments (user and tenant ids), the host and port, and a code frame.
 */
function describeLookupError(err: unknown): string {
  if (!(err instanceof Error)) return "non-error";
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? `${err.name} code=${code}` : err.name;
}
