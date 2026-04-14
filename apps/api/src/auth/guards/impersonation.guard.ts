import {
  Injectable,
  CanActivate,
  ExecutionContext,
  Logger,
} from "@nestjs/common";

/**
 * Impersonation audit-trail guard.
 *
 * Impersonation sessions have FULL write access — the super-admin acts with
 * the same permissions as the impersonated tenant-admin user. This guard
 * does NOT block any operations; it exists solely to log write actions for
 * the audit trail so support workflows are traceable.
 *
 * The `impersonatedBy` JWT claim is attached to every request for logging
 * and UI banner display purposes.
 */
@Injectable()
export class ImpersonationGuard implements CanActivate {
  private readonly logger = new Logger(ImpersonationGuard.name);

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const user = request.user;

    // If not impersonating, nothing to log
    if (!user?.impersonatedBy) {
      return true;
    }

    const method = request.method?.toUpperCase();
    const path = request.url?.split("?")[0] ?? "";

    // Log write operations made during impersonation for audit trail
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      this.logger.log(
        `Impersonation write: ${method} ${path} ` +
          `(admin=${user.impersonatedBy}, acting-as=${user.sub}, tenant=${user.tenantId})`,
      );
    }

    // Always allow — impersonation sessions have full write access
    return true;
  }
}
