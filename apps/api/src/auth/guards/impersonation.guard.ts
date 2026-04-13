import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Logger,
} from "@nestjs/common";

/**
 * Guards mutations during impersonation sessions.
 * Super admins impersonating a tenant can READ all data but WRITE operations
 * are restricted to a safe-list. Destructive operations (delete, void, etc.)
 * are blocked to prevent accidental damage to tenant data.
 *
 * The `impersonatedBy` JWT claim is used for audit trail and UI banners.
 */
@Injectable()
export class ImpersonationGuard implements CanActivate {
  private readonly logger = new Logger(ImpersonationGuard.name);

  // HTTP methods that are always safe (read-only)
  private readonly SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

  // Paths that are explicitly allowed even during impersonation (write operations
  // that are low-risk or needed for support workflows)
  private readonly ALLOWED_WRITE_PATHS = [
    // Auth operations (needed for session management)
    "/auth/",
    // Viewing/exporting data is fine
    "/export",
    "/pdf",
    "/download",
  ];

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const user = request.user;

    // If not impersonating, allow everything
    if (!user?.impersonatedBy) {
      return true;
    }

    const method = request.method?.toUpperCase();
    const path = request.url?.split("?")[0] ?? "";

    // Read-only requests are always allowed during impersonation
    if (this.SAFE_METHODS.has(method)) {
      return true;
    }

    // Check if this write path is in the allowed list
    const isAllowed = this.ALLOWED_WRITE_PATHS.some((p) => path.includes(p));
    if (isAllowed) {
      return true;
    }

    // Log the blocked mutation for audit trail
    this.logger.warn(
      `Impersonation mutation blocked: ${method} ${path} ` +
        `(admin=${user.impersonatedBy}, acting-as=${user.sub}, tenant=${user.tenantId})`,
    );

    throw new ForbiddenException(
      "Write operations are restricted during impersonation. " +
        "Exit impersonation to make changes directly.",
    );
  }
}
