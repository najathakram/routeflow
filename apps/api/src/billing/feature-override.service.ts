import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { isRegisteredFeatureKey } from "./feature-registry";

export type FeatureOverrideEffect = "GRANT" | "DENY";

export interface CreateFeatureOverrideParams {
  tenantId: string;
  featureKey: string;
  effect: FeatureOverrideEffect;
  reason: string;
  expiresAt: Date | null;
  createdById: string | null;
}

const CACHE_TTL_MS = 30_000;

interface CachedRow {
  featureKey: string;
  effect: FeatureOverrideEffect;
  expiresAt: Date | null;
}

interface CacheEntry {
  rows: CachedRow[];
  cacheExpiresAt: number;
}

/**
 * Per-tenant entitlement overrides. When a non-revoked, non-expired row exists for
 * (tenantId, featureKey) it decides the gate outright — GRANT allows, DENY denies —
 * regardless of plan/addon state or dark/enforced gate mode (owner ruling, feature-grants
 * PR-1): only the absence of a row falls through to today's plan+dark behaviour.
 *
 * Mirrors EntitlementsService's own cache shape (30s Map + invalidate/invalidateAll) so the
 * two collaborators behave identically to callers already familiar with one of them.
 */
@Injectable()
export class FeatureOverrideService {
  private readonly logger = new Logger(FeatureOverrideService.name);
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Non-revoked rows for a tenant, cached 30s. `revokedAt` is filtered at the DB query (a
   * write-driven state, fully covered by invalidate() on every create()/revoke()) but
   * `expiresAt` is deliberately NOT filtered here — it drifts stale purely by wall-clock time
   * within an otherwise-valid cache window, so it is rechecked on every read in effectAt().
   */
  private async activeRows(tenantId: string): Promise<CachedRow[]> {
    const now = Date.now();
    const cached = this.cache.get(tenantId);
    if (cached && cached.cacheExpiresAt > now) return cached.rows;

    const rows = await this.prisma.tenantFeatureOverride.findMany({
      where: { tenantId, revokedAt: null },
      select: { featureKey: true, effect: true, expiresAt: true },
    });
    const value = rows.map((r) => ({
      featureKey: r.featureKey,
      effect: r.effect,
      expiresAt: r.expiresAt,
    }));
    this.cache.set(tenantId, { rows: value, cacheExpiresAt: now + CACHE_TTL_MS });
    if (this.cache.size > 1000) this.pruneExpired(now);
    return value;
  }

  private effectAt(
    rows: CachedRow[],
    featureKey: string,
    now: number,
  ): FeatureOverrideEffect | null {
    const row = rows.find(
      (r) => r.featureKey === featureKey && (r.expiresAt === null || r.expiresAt.getTime() > now),
    );
    return row?.effect ?? null;
  }

  /**
   * The active override effect for one key, or null when none applies. Fails open to null on
   * a DB error — every consulting guard/read path then falls back to its plan-only decision,
   * never a 500 into a guarded route.
   */
  async get(tenantId: string, featureKey: string): Promise<FeatureOverrideEffect | null> {
    try {
      const rows = await this.activeRows(tenantId);
      return this.effectAt(rows, featureKey, Date.now());
    } catch (err) {
      this.logger.error(
        `Override lookup failed for tenant ${tenantId} key ${featureKey}`,
        err as Error,
      );
      return null;
    }
  }

  /** Batch form for an any-of key set (AddonGuard). Same fail-open contract as get(). */
  async getMany(
    tenantId: string,
    featureKeys: readonly string[],
  ): Promise<Map<string, FeatureOverrideEffect>> {
    try {
      const rows = await this.activeRows(tenantId);
      const now = Date.now();
      const result = new Map<string, FeatureOverrideEffect>();
      for (const key of featureKeys) {
        const effect = this.effectAt(rows, key, now);
        if (effect) result.set(key, effect);
      }
      return result;
    } catch (err) {
      this.logger.error(`Override lookup failed for tenant ${tenantId}`, err as Error);
      return new Map();
    }
  }

  /**
   * Every active override for a tenant, keyed by featureKey — for a caller that needs the
   * full set rather than a specific candidate list (e.g. /tenants/me/addons, which must also
   * surface a GRANT-overridden key the tenant holds no addon row for at all). Same fail-open
   * contract as get()/getMany().
   */
  async allActive(tenantId: string): Promise<Map<string, FeatureOverrideEffect>> {
    try {
      const rows = await this.activeRows(tenantId);
      const now = Date.now();
      const result = new Map<string, FeatureOverrideEffect>();
      for (const row of rows) {
        const effect = this.effectAt(rows, row.featureKey, now);
        if (effect) result.set(row.featureKey, effect);
      }
      return result;
    } catch (err) {
      this.logger.error(`Override lookup failed for tenant ${tenantId}`, err as Error);
      return new Map();
    }
  }

  /** Every row (including revoked/expired) for the platform-admin history table. */
  async list(tenantId: string) {
    return this.prisma.tenantFeatureOverride.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
    });
  }

  async create(params: CreateFeatureOverrideParams) {
    if (!isRegisteredFeatureKey(params.featureKey)) {
      throw new BadRequestException({
        statusCode: 400,
        code: "FEATURE_KEY_UNKNOWN",
        message: `"${params.featureKey}" is not a registered feature key.`,
      });
    }
    try {
      const row = await this.prisma.tenantFeatureOverride.create({
        data: {
          tenantId: params.tenantId,
          featureKey: params.featureKey,
          effect: params.effect,
          reason: params.reason,
          expiresAt: params.expiresAt,
          createdById: params.createdById,
        },
      });
      this.invalidate(params.tenantId);
      return row;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        throw new ConflictException(
          `An active override already exists for "${params.featureKey}" on this tenant — revoke it first.`,
        );
      }
      throw e;
    }
  }

  async revoke(tenantId: string, id: string) {
    try {
      // `where: { id, tenantId }` -- not just `{ id }` (Opus review of 8130b204, item 3): id
      // alone would let tenant B revoke tenant A's row by id under tenant B's URL, mis-audited
      // and mis-invalidated (tenant A's own cache never cleared). Prisma enforces both
      // conditions together and throws P2025 when the row doesn't belong to this tenant.
      const row = await this.prisma.tenantFeatureOverride.update({
        where: { id, tenantId },
        data: { revokedAt: new Date() },
      });
      this.invalidate(tenantId);
      return row;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
        throw new NotFoundException(`No feature override "${id}" found for this tenant.`);
      }
      throw e;
    }
  }

  invalidate(tenantId: string): void {
    this.cache.delete(tenantId);
  }

  invalidateAll(): void {
    this.cache.clear();
  }

  private pruneExpired(now: number): void {
    for (const [key, entry] of this.cache) {
      if (entry.cacheExpiresAt <= now) this.cache.delete(key);
    }
  }
}
