import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from "@nestjs/common";
import type { Request } from "express";

/** HTTP methods that are considered mutations */
const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Global guard that blocks mutation requests when the JWT contains an
 * `impersonatedBy` claim — enforcing read-only impersonation.
 *
 * Because APP_GUARD runs before route-level guards (including JwtAuthGuard),
 * req.user is not yet populated at this point. We decode the JWT payload
 * directly from the Authorization header instead. No signature verification is
 * needed here — JwtAuthGuard still verifies the signature; we only need to
 * inspect the claim to decide whether to block.
 */
@Injectable()
export class ImpersonationGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();

    if (!MUTATION_METHODS.has(req.method)) {
      return true; // reads are always fine
    }

    const authHeader = req.headers["authorization"];
    if (!authHeader?.startsWith("Bearer ")) {
      return true; // no token — JwtAuthGuard will reject it if needed
    }

    try {
      const token = authHeader.slice(7);
      const payloadPart = token.split(".")[1];
      if (!payloadPart) return true;
      const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));

      if (payload.impersonatedBy) {
        throw new ForbiddenException(
          "Impersonation tokens are read-only. Mutations are not permitted while impersonating.",
        );
      }
    } catch (err) {
      if (err instanceof ForbiddenException) throw err;
      // Malformed JWT — pass through; JwtAuthGuard will handle it
    }

    return true;
  }
}
