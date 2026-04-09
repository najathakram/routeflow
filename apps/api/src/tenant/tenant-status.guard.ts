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
      return this.assertNotSuspended(cached.status);
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

      return this.assertNotSuspended(tenant.status);
    } catch (err) {
      if (err instanceof ForbiddenException) throw err;
      // DB error — fail open (log + allow) to avoid blocking all requests
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

  private assertNotSuspended(status: string): true {
    if (status === "SUSPENDED" || status === "CANCELLED") {
      throw new ForbiddenException("Tenant account is suspended. Please contact support.");
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
