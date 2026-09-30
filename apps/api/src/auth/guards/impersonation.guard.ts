import { Injectable, CanActivate, ExecutionContext, Logger } from "@nestjs/common";

interface ImpersonationClaims {
  impersonatedBy?: string;
  sub?: string;
  tenantId?: string | null;
}

/** Claims plus their provenance — header-derived claims are UNVERIFIED (see the docblock). */
interface ClaimSource {
  claims: ImpersonationClaims;
  /** `true` only when the claims came from `request.user`, i.e. after JwtAuthGuard verified them. */
  verified: boolean;
}

/** Longest claim value that may reach a log line; ids are far shorter than this. */
const MAX_CLAIM_CHARS = 64;
/** Longest request path that may reach a log line. */
const MAX_PATH_CHARS = 200;
/**
 * Anything outside printable ASCII / non-control Unicode. Written as a NEGATED class
 * so the pattern itself carries no literal control character (eslint no-control-regex).
 */
const UNPRINTABLE = /[^\u0020-\u007e\u00a0-\uffff]/g;

/**
 * Render one untrusted value for the log line: strip control characters — CR/LF would
 * otherwise forge whole extra log lines — and cap the length, since an anonymous caller
 * can push ~8 KB through the Authorization header on every request.
 */
function forLog(value: unknown, max: number = MAX_CLAIM_CHARS): string {
  if (typeof value !== "string") return "?";
  const cleaned = value.replace(UNPRINTABLE, " ");
  return cleaned.length > max ? `${cleaned.slice(0, max)}...` : cleaned;
}

/**
 * Impersonation audit-trail guard.
 *
 * Impersonation sessions have FULL write access — the super-admin acts with
 * the same permissions as the impersonated tenant-admin user. This guard
 * does NOT block any operations; it exists solely to log write actions for
 * the audit trail so support workflows are traceable.
 *
 * B165: it is registered as an APP_GUARD (app.module.ts) and Nest runs global
 * guards BEFORE route-level guards, while JwtAuthGuard is route-level only — so
 * `request.user` is never populated here and the original `request.user`-based
 * check never fired once. We therefore decode the bearer payload segment WITHOUT
 * verifying the signature (the same approach TenantStatusGuard uses); that is
 * acceptable for a log-only side effect because JwtAuthGuard still verifies the
 * token downstream. `request.user` is preferred when a future ordering sets it.
 *
 * Because that decode runs BEFORE authentication, the claims it yields are
 * attacker-supplied: any anonymous caller can put whatever it likes in the
 * header. So every value is sanitised (`forLog`) before interpolation, and the
 * line records `claims=unverified-bearer` — an operator reading the log must be
 * able to tell a genuine impersonated write from an unauthenticated probe that
 * JwtAuthGuard 401'd a moment later. The DURABLE trail is AuditInterceptor's
 * row, which stamps the VERIFIED `req.user.impersonatedBy` (B165 / R9).
 */
@Injectable()
export class ImpersonationGuard implements CanActivate {
  private readonly logger = new Logger(ImpersonationGuard.name);

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const source = this.readClaims(request);

    // If not impersonating, nothing to log
    if (!source?.claims.impersonatedBy) return true;

    const method = String(request.method ?? "GET").toUpperCase();
    const path = forLog(String(request.url ?? "").split("?")[0], MAX_PATH_CHARS);

    // Log write operations made during impersonation for audit trail
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      const { claims, verified } = source;
      this.logger.log(
        `Impersonation write: ${method} ${path} ` +
          `(admin=${forLog(claims.impersonatedBy)}, acting-as=${forLog(claims.sub)}, ` +
          `tenant=${forLog(claims.tenantId)}, claims=${verified ? "verified" : "unverified-bearer"})`,
      );
    }

    // Always allow — impersonation sessions have full write access
    return true;
  }

  private readClaims(request: any): ClaimSource | null {
    if (request?.user?.impersonatedBy) {
      return { claims: request.user as ImpersonationClaims, verified: true };
    }
    const authHeader: unknown = request?.headers?.authorization;
    if (typeof authHeader !== "string" || !authHeader.startsWith("Bearer ")) return null;
    try {
      const payloadPart = authHeader.slice(7).split(".")[1];
      if (!payloadPart) return null;
      const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
      return typeof payload?.impersonatedBy === "string"
        ? { claims: payload as ImpersonationClaims, verified: false }
        : null;
    } catch {
      // Malformed JWT — nothing to log; JwtAuthGuard rejects it downstream.
      return null;
    }
  }
}
