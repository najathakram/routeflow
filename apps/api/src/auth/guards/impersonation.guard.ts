import { Injectable, CanActivate } from "@nestjs/common";

/**
 * Previously blocked mutations during impersonation. Now a no-op —
 * super admins have full authority when impersonating a tenant.
 * The `impersonatedBy` JWT claim is kept for audit trail and UI banners.
 */
@Injectable()
export class ImpersonationGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}
