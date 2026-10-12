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

interface CachedStatus {
  status: string;
  expiresAt: number;
}

/** Cache TTL: 60 seconds. A suspended tenant may still make requests for up to 60s. */
const CACHE_TTL_MS = 60_000;

/**
 * The ONE read-only allow-list (SA-733r6 / SA-750r3 O1): the only non-read requests a READ_ONLY tenant may make.
 * Anchored patterns, never substrings, so a neighbouring route cannot ride in. Route-scoped, never a role bypass.
 *  - the auth routes and the plan-restore paths (a tenant must be able to sign in and buy its way out);
 *  - the admin's billing portal (`@Roles(TENANT_ADMIN)` on the route);
 *  - the end-of-day close (also the re-close), its reopen and the Z-report re-send (housekeeping on cash already taken);
 *  - the e-mailed receipt of an EXISTING sale (it counts as print / export; only the send log is written).
 * Everything else (sales, orders, invoices, estimates, payments) stays refused with 403 READ_ONLY.
 * The day-close routes ship with SA-750; until they land the entries match nothing.
 */
export const READ_ONLY_ALLOWED_MUTATIONS: ReadonlyArray<{
  methods: readonly string[] | "ANY";
  pattern: RegExp;
}> = [
  { methods: "ANY", pattern: /^\/api\/v1\/auth\// },
  { methods: ["POST"], pattern: /^\/api\/v1\/billing\/subscribe$/ },
  { methods: ["POST"], pattern: /^\/api\/v1\/billing\/quote$/ },
  { methods: ["POST"], pattern: /^\/api\/v1\/billing\/subscription$/ },
  {
    methods: ["POST"],
    pattern: /^\/api\/v1\/billing\/subscription\/(downgrade|cancel|resume|checkout)$/,
  },
  { methods: ["POST"], pattern: /^\/api\/v1\/billing\/portal$/ },
  // SA-750r3 O1 (as built on feat/counter-day-close): the close AND the re-close are the same POST.
  { methods: ["POST"], pattern: /^\/api\/v1\/orders\/counter-sale\/day-close$/ },
  {
    methods: ["POST"],
    pattern: /^\/api\/v1\/orders\/counter-sale\/day-close\/[0-9a-fA-F-]{36}\/reopen$/,
  },
  // The Z-report re-send (log-only).
  {
    methods: ["POST"],
    pattern: /^\/api\/v1\/orders\/counter-sale\/day-close\/[0-9a-fA-F-]{36}\/report$/,
  },
  // The e-mailed receipt of an EXISTING sale (SA r-note, lead ruling 10-10). NO such route exists on this base: it
  // ships with the counter receipt e-mail work (SA-751r; not on this base), so this entry matches nothing here.
  { methods: ["POST"], pattern: /^\/api\/v1\/orders\/[0-9a-fA-F-]{36}\/receipt$/ },
];

export function isReadOnlyAllowedMutation(method: string, path: string): boolean {
  const m = method.toUpperCase();
  return READ_ONLY_ALLOWED_MUTATIONS.some(
    (e) => (e.methods === "ANY" || e.methods.includes(m)) && e.pattern.test(path),
  );
}

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
    let role: string | null = null;
    try {
      const token = authHeader.slice(7);
      const payloadPart = token.split(".")[1];
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
      return this.assertAllowed(cached.status, req, role);
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

      return this.assertAllowed(tenant.status, req, role);
    } catch (err) {
      if (err instanceof ForbiddenException) throw err;
      // On DB error, prefer the last-known status (even past TTL) so the READ_ONLY /
      // SUSPENDED enforcement boundary doesn't evaporate during a DB blip. Only fail
      // open when status is genuinely unknown, to avoid bricking healthy tenants.
      const stale = this.statusCache.get(tenantId);
      if (stale) return this.assertAllowed(stale.status, req, role);
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

  private assertAllowed(status: string, req: Request, role: string | null = null): true {
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
      // Anchored allowlist (not substring): READ_ONLY_ALLOWED_MUTATIONS above. Global prefix is /api/v1.
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
        throw new ForbiddenException({
          code: API_ERROR_CODES.READ_ONLY,
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
