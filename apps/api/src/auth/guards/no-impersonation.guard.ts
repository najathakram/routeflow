import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AuditService } from "../../audit/audit.service";
import { AUDIT_ACTIONS } from "../../audit/audit-actions.constant";
import { API_ERROR_CODES } from "../../common/api-error-codes";
import type { JwtPayload } from "../jwt-payload.interface";

/** Metadata key `@NoImpersonation(scope)` writes; the guard reads it from the handler, then the class. */
export const NO_IMPERSONATION_KEY = "noImpersonation";

/**
 * Areas a support session may not act in. Extend the union to restrict another area.
 * "account": the signed-in user's own credentials and linked identities (a support session must not mint a
 * clean session or attach an identity to the account it is borrowing).
 */
export type NoImpersonationScope = "billing" | "account";

/** The one sentence the refusal carries (the web copy for the code says the same). */
export const SUPPORT_SESSION_REFUSAL_MESSAGE =
  "This action isn't available in a support session. Ask the account admin to do it.";

/** Longest route string stored on the audit row. */
const MAX_ROUTE_CHARS = 200;

/**
 * SA-778: refuses a request made in a support session (a token carrying `impersonatedBy`) before the
 * handler runs, for the handlers and classes marked with `@NoImpersonation(scope)`.
 *
 * It reads the claim from `request.user`, which JwtAuthGuard has verified, and NEVER from the bearer header:
 * unlike ImpersonationGuard (a global, log-only guard that runs before authentication), this one decides.
 * It is therefore route-level and must run after JwtAuthGuard; the decorator attaches it, so on a controller
 * with a class-level `@UseGuards(JwtAuthGuard, ...)` the order is right by construction. A request with no
 * `request.user` at all is refused 401 (fail closed) rather than waved through.
 *
 * Each refusal writes ONE audit row (`impersonation.action-refused`) before the 403. A failed audit write
 * never turns the refusal into a pass.
 */
@Injectable()
export class NoImpersonationGuard implements CanActivate {
  private readonly logger = new Logger(NoImpersonationGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const scope = this.reflector.getAllAndOverride<NoImpersonationScope | undefined>(
      NO_IMPERSONATION_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!scope) return true;

    const request = context.switchToHttp().getRequest();
    const user = request?.user as Partial<JwtPayload> | undefined;
    if (!user) throw new UnauthorizedException();
    if (user.impersonatedBy == null) return true;

    const method = String(request.method ?? "").toUpperCase();
    const route = String(request.route?.path ?? String(request.url ?? "").split("?")[0]).slice(
      0,
      MAX_ROUTE_CHARS,
    );
    try {
      await this.audit.log({
        tenantId: user.tenantId ?? null,
        userId: user.sub ?? null,
        impersonatedBy: user.impersonatedBy,
        action: AUDIT_ACTIONS.IMPERSONATION_ACTION_REFUSED,
        entityType: scope,
        ip: request.ip ?? null,
        meta: {
          superAdminId: user.impersonatedBy,
          tenantId: user.tenantId ?? null,
          method,
          route,
        },
      });
    } catch (err) {
      this.logger.error(`Failed to audit a refused support-session action: ${String(err)}`);
    }

    throw new ForbiddenException({
      code: API_ERROR_CODES.IMPERSONATION_NOT_ALLOWED,
      message: SUPPORT_SESSION_REFUSAL_MESSAGE,
    });
  }
}
