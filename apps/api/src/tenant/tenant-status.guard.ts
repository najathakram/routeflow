import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Logger,
} from "@nestjs/common";
import type { Request } from "express";
import { PrismaService } from "../prisma/prisma.service";

interface CachedStatus {
  status: string;
  expiresAt: number;
}

/** Cache TTL: 60 seconds. A suspended tenant may still make requests for up to 60s. */
const CACHE_TTL_MS = 60_000;

/**
 * Global guard that blocks all API requests from tenants whose status is
 * SUSPENDED or CANCELLED.
 *
 * Runs as an APP_GUARD (before route-level guards), so `req.user` is NOT
 * populated yet. We decode the JWT payload directly from the Authorization
 * header — the same approach used by ImpersonationGuard. JwtAuthGuard still
 * verifies the signature downstream; we only inspect the `tenantId` claim.
 *
 * SUPER_ADMIN users (tenantId === null) always pass.
 *
 * An in-memory cache (Map) with 60 s TTL avoids a DB hit on every request.
 * Call `invalidate(tenantId)` when a tenant's status changes.
 */
@Injectable()
export class TenantStatusGuard implements CanActivate {
  private readonly logger = new Logger(TenantStatusGuard.name);
  private readonly statusCache = new Map<string, CachedStatus>();

  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();

    // ── Extract tenantId from JWT payload (no signature check needed) ─────────
    const authHeader = req.headers["authorization"];
    if (!authHeader?.startsWith("Bearer ")) {
      return true; // No token — let JwtAuthGuard handle auth later
    }

    let tenantId: string | null = null;
    try {
      const token = authHeader.slice(7);
      const payloadPart = token.split(".")[1];
      if (!payloadPart) return true;
      const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
      tenantId = payload.tenantId ?? null;
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
      return this.assertAllowed(cached.status, req);
    }

    // ── Query DB ─────────────────────────────────────────────────────────────
    try {
      const tenant = await this.prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { status: true },
      });

      if (!tenant) {
        // Tenant deleted or ID invalid — let downstream guards handle it
        return true;
      }

      // Cache the result
      this.statusCache.set(tenantId, {
        status: tenant.status,
        expiresAt: now + CACHE_TTL_MS,
      });

      // Periodic cleanup when cache grows beyond 500 entries
      if (this.statusCache.size > 500) {
        this.cleanExpiredEntries(now);
      }

      return this.assertAllowed(tenant.status, req);
    } catch (err) {
      if (err instanceof ForbiddenException) throw err;
      // On DB error, prefer the last-known status (even past TTL) so the READ_ONLY /
      // SUSPENDED enforcement boundary doesn't evaporate during a DB blip. Only fail
      // open when status is genuinely unknown, to avoid bricking healthy tenants.
      const stale = this.statusCache.get(tenantId);
      if (stale) return this.assertAllowed(stale.status, req);
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

  private assertAllowed(status: string, req: Request): true {
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
      // Anchored allowlist (not substring) so an unrelated route can't smuggle a mutation
      // through by merely containing these strings. Global prefix is /api/v1.
      const allowedMutation =
        path.startsWith("/api/v1/auth/") ||
        path === "/api/v1/billing/subscribe" ||
        path === "/api/v1/billing/quote" ||
        path === "/api/v1/billing/subscription" ||
        path.startsWith("/api/v1/billing/subscription/");
      if (!isRead && !allowedMutation) {
        throw new ForbiddenException({
          code: "READ_ONLY",
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
