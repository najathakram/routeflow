import {
  CallHandler,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  NestInterceptor,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { UserRole } from "@prisma/client";
import type { Observable } from "rxjs";
import { API_ERROR_CODES } from "../common/api-error-codes";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { PLATFORM_SCOPED_KEY } from "./platform-scoped.decorator";

export type TenantRequiredMode = "dark" | "enforced";

/**
 * W-767 (SA-908): DARK. It flips to "enforced" only in its own diff, after a read-only census of the would-deny warnings
 * over real traffic (`apps/api/scripts/report-tenantless-writes.mjs`) has classified every route a super admin writes to
 * without a business.
 */
export const TENANT_REQUIRED_MODE: TenantRequiredMode = "dark";

const READ_VERBS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * W-767 (SA-908): a tenant WRITE needs a business in the session.
 *
 * SUPER_ADMIN satisfies every role (roles.guard.ts), and its own token carries no tenant, so TenantInterceptor runs the
 * request with `tenantId: null`. Then `forTenant()` is the unscoped client and `tenantTransaction` the raw transaction, so a
 * tenant-scoped write could read and write across businesses (W-763 was one such route).
 *
 * The rule: a SUPER_ADMIN request with no tenant, on a non-GET/HEAD/OPTIONS route that is not `@PlatformScoped()`, is
 * refused with 403 `TENANT_CONTEXT_REQUIRED` BEFORE the handler runs, so nothing is read or written. A super admin does
 * tenant work through impersonation, whose token carries the tenant. While DARK it lets the request through and warns once
 * per route per process.
 *
 * An interceptor, not a global guard: every APP_GUARD runs before the per-route JwtAuthGuard and sees only UNVERIFIED claims
 * (the guard-order invariant in app.module.ts); interceptors run after every guard, on the verified `req.user`. Other
 * tenantless callers are not this rule's business: a buyer (CUSTOMER) token carries no tenant and is gated by the buyer
 * guards, and public and webhook routes have no user.
 */
@Injectable()
export class TenantRequiredInterceptor implements NestInterceptor {
  private readonly logger = new Logger(TenantRequiredInterceptor.name);
  /** The routes already logged in this process: one census line per route, never one per request. */
  private readonly warned = new Set<string>();
  /** The module constant; a spec sets "enforced" to prove the refusal. */
  mode: TenantRequiredMode = TENANT_REQUIRED_MODE;

  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== "http") return next.handle();
    const req = context.switchToHttp().getRequest();
    const user = req?.user as JwtPayload | undefined;
    if (!user || user.role !== UserRole.SUPER_ADMIN || user.tenantId != null) return next.handle();
    const platform = this.reflector.getAllAndOverride<boolean>(PLATFORM_SCOPED_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (platform) return next.handle();
    const method = String(req.method ?? "").toUpperCase();
    const route = `${method} ${req.route?.path ?? req.path ?? req.url}`;

    // SA-908 item 4: reads are out of the first cut (they aggregate across businesses, an exposure, not a corruption).
    // They are only LISTED for the census, once per route per process, and never refused here.
    if (READ_VERBS.has(method)) {
      if (this.once(route))
        this.logger.log(`[tenant-required] tenantless-read ${route} (role SUPER_ADMIN)`);
      return next.handle();
    }
    if (this.mode === "enforced") {
      throw new ForbiddenException({
        code: API_ERROR_CODES.TENANT_CONTEXT_REQUIRED,
        message: "Open a business first to make this change.",
      });
    }
    if (this.once(route)) {
      this.logger.warn(`[tenant-required] would-deny ${route} (role SUPER_ADMIN, no tenant)`);
    }
    return next.handle();
  }

  /** True the first time this process sees `route` (one census line per route, never one per request). */
  private once(route: string): boolean {
    if (this.warned.has(route)) return false;
    this.warned.add(route);
    return true;
  }
}
