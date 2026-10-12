import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Logger,
} from "@nestjs/common";
import type { Request } from "express";
import { PrismaService } from "../prisma/prisma.service";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { bearerTokenOf } from "../auth/bearer-token";
import { isReadOnlyAllowedMutation } from "./read-only-registry";

interface CachedStatus {
  status: string;
  /** `Tenant.readOnlyReason` (trial_expired | ...), carried in the READ_ONLY 403 body; null when none. */
  readOnlyReason: string | null;
  expiresAt: number;
}

/** Cache TTL: 60 seconds. A suspended tenant may still make requests for up to 60s. */
const CACHE_TTL_MS = 60_000;

/**
 * Global tenant-status guard (APP_GUARD): the ONE place a tenant's STATUS limits what its staff sessions may do.
 *
 *  - SUSPENDED / CANCELLED: every request is refused (403).
 *  - READ_ONLY: GET / HEAD / OPTIONS pass; any other method must match `READ_ONLY_ALLOWED_MUTATIONS`
 *    (./read-only-registry - the single allow-list, pinned route by route by read-only-route-pin.spec.ts: the
 *    billing restore paths, `/auth/*`, the counter day-close + its reopen and Z-report, and the e-mailed receipt)
 *    or is refused with 403 `{ code: "READ_ONLY", reason }` (`SELLER_UNAVAILABLE` for a CUSTOMER-role JWT).
 *    `reason` is the tenant's recorded readOnlyReason; clients map it to fixed copy and never show server text.
 *  - TRIAL / ACTIVE: everything passes.
 *
 * Runs as an APP_GUARD (before route-level guards), so `req.user` is NOT populated yet. We decode the JWT payload
 * directly from the Authorization header - the same approach used by ImpersonationGuard. JwtAuthGuard still
 * verifies the signature downstream; the `tenantId` / `role` claims are read here ONLY to look up status, never to
 * authorize. SUPER_ADMIN users (tenantId === null), and requests with no / a malformed Bearer token, pass through
 * to the route's own guards.
 *
 * A buyer (CUSTOMER) token carries no tenantId, so buyer writes are gated per route by BuyerSellerContextGuard
 * (SELLER_READ_ONLY_BUYER_GATE), not here. System-initiated work (cron, queue) follows the same status rule
 * through `acceptsAutomatedWrites` in ./tenant-automation.
 *
 * An in-memory cache (Map) with 60 s TTL avoids a DB hit on every request. Call `invalidate(tenantId)` when a
 * tenant's status changes.
 *
 * Accepted gap (SA-776 GAP-7): when the status lookup throws AND no status was ever cached for the tenant, the
 * request FAILS OPEN (logged). Availability wins over a blanket outage on a DB blip; the stale cache (kept past its
 * TTL) covers short blips for any tenant seen in the last process lifetime, and an unknown tenant is refused later
 * at JwtAuthGuard.
 */
@Injectable()
export class TenantStatusGuard implements CanActivate {
  private readonly logger = new Logger(TenantStatusGuard.name);
  private readonly statusCache = new Map<string, CachedStatus>();

  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();

    // ── Extract tenantId from JWT payload (no signature check needed) ─────────
    // Read exactly as the JWT strategy reads it (auth/bearer-token.ts: scheme case-insensitive, any whitespace).
    const bearer = bearerTokenOf(req.headers["authorization"]);
    if (!bearer) {
      return true; // No token — let JwtAuthGuard handle auth later
    }

    let tenantId: string | null = null;
    let role: string | null = null;
    try {
      const payloadPart = bearer.split(".")[1];
      if (!payloadPart) return true;
      const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
      tenantId = payload.tenantId ?? null;
      role = typeof payload.role === "string" ? payload.role : null;
    } catch {
      // Malformed JWT — pass through; JwtAuthGuard will reject it downstream
      return true;
    }

    // SUPER_ADMIN (tenantId === null) — always allow
    if (!tenantId) return true;

    // ── Check cache ──────────────────────────────────────────────────────────
    const now = Date.now();
    const cached = this.statusCache.get(tenantId);
    if (cached && cached.expiresAt > now) {
      return this.assertAllowed(cached.status, req, role, cached.readOnlyReason);
    }

    // ── Query DB ─────────────────────────────────────────────────────────────
    try {
      const tenant = await this.prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { status: true, readOnlyReason: true },
      });

      if (!tenant) {
        // Tenant deleted or ID invalid — let downstream guards handle it
        return true;
      }

      // Cache the result
      const readOnlyReason = tenant.readOnlyReason ?? null;
      this.statusCache.set(tenantId, {
        status: tenant.status,
        readOnlyReason,
        expiresAt: now + CACHE_TTL_MS,
      });

      // Periodic cleanup when cache grows beyond 500 entries
      if (this.statusCache.size > 500) {
        this.cleanExpiredEntries(now);
      }

      return this.assertAllowed(tenant.status, req, role, readOnlyReason);
    } catch (err) {
      if (err instanceof ForbiddenException) throw err;
      // On DB error, prefer the last-known status (even past TTL) so the READ_ONLY /
      // SUSPENDED enforcement boundary doesn't evaporate during a DB blip. Only fail
      // open when status is genuinely unknown, to avoid bricking healthy tenants.
      const stale = this.statusCache.get(tenantId);
      if (stale) return this.assertAllowed(stale.status, req, role, stale.readOnlyReason);
      this.logger.error("Failed to check tenant status", err);
      return true;
    }
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /** Evict the cached status for a tenant (call after status changes). */
  invalidate(tenantId: string): void {
    this.statusCache.delete(tenantId);
  }

  /** Evict all cached entries (e.g. for tests or bulk status changes). */
  invalidateAll(): void {
    this.statusCache.clear();
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private assertAllowed(
    status: string,
    req: Request,
    role: string | null = null,
    readOnlyReason: string | null = null,
  ): true {
    if (status === "SUSPENDED" || status === "CANCELLED") {
      throw new ForbiddenException("Tenant account is suspended. Please contact support.");
    }
    // READ_ONLY (e.g. expired trial): reads + exports + sign-in still work, and the
    // billing subscribe/upgrade paths stay open so the tenant can restore full access.
    // Any other mutating request is blocked with a structured READ_ONLY 403.
    if (status === "READ_ONLY") {
      const method = (req.method ?? "GET").toUpperCase();
      const path = req.path || (req as unknown as { originalUrl?: string }).originalUrl || "";
      const isRead = method === "GET" || method === "HEAD" || method === "OPTIONS";
      // Anchored allow-list (not substring): READ_ONLY_ALLOWED_MUTATIONS in ./read-only-registry, the ONE copy
      // (pinned route by route by read-only-route-pin.spec.ts). Global prefix is /api/v1.
      const allowedMutation = isReadOnlyAllowedMutation(method, path);
      if (!isRead && !allowedMutation) {
        // SA-733r6: a BUYER's write to a read-only seller is a coded, seller-neutral refusal. The buyer is never
        // told about the seller's billing or plan; the buyer UI turns this into its one quiet line.
        if (role === "CUSTOMER") {
          throw new ForbiddenException({
            code: API_ERROR_CODES.SELLER_UNAVAILABLE,
            message: "This seller isn't taking online orders right now. Please check back soon.",
          });
        }
        // SA-776: `reason` is the tenant's recorded readOnlyReason (null = set by an administrator). Clients map it
        // to fixed copy (packages/types/read-only-copy.ts) and never render server text.
        throw new ForbiddenException({
          code: API_ERROR_CODES.READ_ONLY,
          reason: readOnlyReason,
          message:
            "Your workspace is read-only. Subscribe to restore full access — exports still work.",
        });
      }
    }
    return true;
  }

  private cleanExpiredEntries(now: number): void {
    for (const [key, value] of this.statusCache) {
      if (value.expiresAt <= now) {
        this.statusCache.delete(key);
      }
    }
  }
}
