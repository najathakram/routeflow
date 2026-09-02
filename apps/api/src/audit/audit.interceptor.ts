import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from "@nestjs/common";
import type { Request } from "express";
import { AuditService } from "./audit.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";

/** HTTP methods that constitute a mutation */
const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

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

      // Derive entity type + id from the full URL path.
      // req.path in NestJS is the raw Express path, which does NOT include
      // the global prefix. The actual URL including prefix is in req.url.
      // We strip both /api/v1 and a leading slash to get clean segments.
      const rawPath = (req.url ?? req.path).split("?")[0]; // drop query string
      const pathParts = rawPath
        .replace(/^\/api\/v1\//, "")
        .replace(/^\//, "")
        .split("/")
        .filter(Boolean);
      const entityType = pathParts[0] ?? "unknown";
      const entityId = pathParts[1] ?? null;
      const action = `${req.method} /${pathParts.join("/")}`;

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
