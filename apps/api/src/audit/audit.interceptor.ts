import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from "@nestjs/common";
import type { Request } from "express";
import { AuditService } from "./audit.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";

/** HTTP methods that constitute a mutation */
const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** The global prefix Nest bakes into every route template (main.ts `setGlobalPrefix`). */
const GLOBAL_PREFIX = /^\/api\/v1(?=\/|$)/;

/** Stored in place of a path when the request matched no route template. */
export const AUDIT_UNMATCHED_PATH = "<unmatched>";

/** Marker stored for an id that came from a secret-bearing path parameter. */
export const AUDIT_REDACTED = "[redacted]";

/** A path parameter whose name contains "token" carries a secret, never an id. */
const TOKEN_PARAM = /^:[A-Za-z0-9_]*token/i;

/**
 * The audit target for a mutation, built from the ROUTE TEMPLATE (`req.route.path`, e.g.
 * `/buyer/invites/:token/accept`), never from the raw URL: a secret carried in a path parameter
 * therefore never reaches storage, and neither does a query string. The template is known before
 * the handler runs, so a request that later fails is recorded exactly like one that succeeds.
 *
 * - `action`   `METHOD /template` (global prefix removed), or `METHOD <unmatched>` when the request
 *              matched no route (the raw path is never stored then).
 * - `entityType` the first template segment.
 * - `entityId` the second segment's value when it is an ordinary path parameter, the template text
 *              when it is a literal, and `[redacted]` when it is a token-named parameter.
 */
export function deriveAuditTarget(req: Request): {
  action: string;
  entityType: string;
  entityId: string | null;
} {
  const template = typeof req.route?.path === "string" ? (req.route.path as string) : null;
  if (template === null) {
    return {
      action: `${req.method} ${AUDIT_UNMATCHED_PATH}`,
      entityType: "unknown",
      entityId: null,
    };
  }
  const templateParts = template.replace(GLOBAL_PREFIX, "").split("/").filter(Boolean);
  const rawParts = (req.originalUrl ?? req.url ?? req.path ?? "")
    .split("?")[0]
    .replace(GLOBAL_PREFIX, "")
    .split("/")
    .filter(Boolean);

  const idSegment = templateParts[1];
  let entityId: string | null = null;
  if (idSegment !== undefined) {
    if (!idSegment.startsWith(":")) entityId = idSegment;
    else if (TOKEN_PARAM.test(idSegment)) entityId = AUDIT_REDACTED;
    else entityId = rawParts[1] ?? null;
  }
  return {
    action: `${req.method} /${templateParts.join("/")}`,
    entityType: templateParts[0] ?? "unknown",
    entityId,
  };
}

/**
 * Global interceptor that logs every mutation request (POST/PUT/PATCH/DELETE)
 * to the AuditLog table. Logging is fire-and-forget — it never blocks or
 * fails the main request. No rxjs imports needed (avoids monorepo dual-version
 * conflict).
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(private readonly auditService: AuditService) {}

  intercept(context: ExecutionContext, next: CallHandler) {
    const req = context.switchToHttp().getRequest<Request>();

    if (MUTATION_METHODS.has(req.method)) {
      const user = (req as any).user as JwtPayload | undefined;
      // F9-006: use Express's trust-proxy-aware req.ip (trust proxy = 2 is set in
      // main.ts) — NOT the raw LEFTMOST X-Forwarded-For entry, which a client can
      // spoof by prepending a fake value (the leftmost is caller-supplied; Express
      // strips the 2 trusted proxy hops from the RIGHT to get the real client IP).
      const ip = req.ip ?? req.socket?.remoteAddress ?? null;

      const { action, entityType, entityId } = deriveAuditTarget(req);

      // Fire-and-forget: log in the next microtask so it doesn't block
      setImmediate(() => {
        this.auditService
          .log({
            tenantId: user?.tenantId ?? null,
            userId: user?.sub ?? null,
            // B165: the interceptor runs AFTER route guards, so this is the VERIFIED
            // req.user (JwtStrategy output) — the durable trail names who really wrote.
            impersonatedBy: user?.impersonatedBy ?? null,
            action,
            entityType,
            entityId,
            ip,
          })
          .catch(() => {});
      });
    }

    return next.handle();
  }
}
