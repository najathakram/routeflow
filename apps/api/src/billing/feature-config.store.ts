import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { FEATURE_REGISTRY } from "./feature-registry";

/**
 * Feature grants v2 brief C (PR-4). `FEATURE_MODE_PROVIDER` is the optional DI token brief A's
 * (not-yet-built, PR-0a) shadow-resolver/authority injects to consult a tenant's config-mode
 * override while resolving entitlements — `@Optional() @Inject(FEATURE_MODE_PROVIDER)` on A's
 * side, so its absence (an older base, or a boot before this module loads) is a no-op, never a
 * DI error. `FeatureConfigStore` below is the concrete provider bound to it in
 * `feature-config.module.ts`.
 *
 * NOTE (brief C, 2026-09-17): brief A's authority/resolver code is not on this base yet (only
 * its schema + `packages/types/api/features.ts` contract landed, commit f6985746) — this token
 * and interface are defined here, against that contract, so A's future code has something to
 * inject against. Flagged as an open item in the PR description.
 */
export const FEATURE_MODE_PROVIDER = Symbol("FEATURE_MODE_PROVIDER");

export interface FeatureModeSource {
  value: string;
  source: "TENANT" | "REGISTRY_DEFAULT";
}

export interface FeatureModeProvider {
  getMode(tenantId: string, key: string): Promise<FeatureModeSource>;
}

interface CacheEntry {
  value: FeatureModeSource;
  expiresAt: number;
}

/** Mirrors EntitlementsService's own 30s cache TTL convention (entitlements.service.ts). */
const CACHE_TTL_MS = 30_000;

/**
 * Reads a tenant's per-feature config-mode override (`TenantFeatureConfig`), falling back to
 * the feature's registry `fallbackMode` when no row exists. Prisma-only, no authority
 * dependency (constructor-cycle guard) — this is deliberate: the (future) authority/resolver
 * injects THIS provider optionally, so this provider must never depend back on the authority
 * (or anything that transitively does), or the two would deadlock Nest's DI graph at boot.
 * Fails open to the registry default on any DB error — a config-store outage must never take
 * down entitlement resolution or route dispatch.
 */
@Injectable()
export class FeatureConfigStore implements FeatureModeProvider {
  private readonly logger = new Logger(FeatureConfigStore.name);
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly prisma: PrismaService) {}

  private registryDefault(key: string): string {
    return FEATURE_REGISTRY.find((f) => f.key === key)?.config?.fallbackMode ?? "unset";
  }

  async getMode(tenantId: string, key: string): Promise<FeatureModeSource> {
    const cacheKey = `${tenantId}:${key}`;
    const now = Date.now();
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > now) return cached.value;

    let result: FeatureModeSource;
    try {
      const row = await this.prisma.tenantFeatureConfig.findUnique({
        where: { tenantId_featureKey: { tenantId, featureKey: key } },
        select: { mode: true },
      });
      result = row ? { value: row.mode, source: "TENANT" } : this.defaultResult(key);
    } catch (err) {
      // Fail open to the registry default — never throw out of a mode read. A config-store
      // hiccup must degrade to "unset" behavior, not break dispatch/entitlement resolution.
      this.logger.warn(
        `FeatureConfigStore.getMode(${tenantId}, ${key}) DB error, falling back to registry default: ${
          (err as Error)?.message ?? err
        }`,
      );
      result = this.defaultResult(key);
    }

    this.cache.set(cacheKey, { value: result, expiresAt: now + CACHE_TTL_MS });
    return result;
  }

  private defaultResult(key: string): FeatureModeSource {
    return { value: this.registryDefault(key), source: "REGISTRY_DEFAULT" };
  }

  /** Test/ops escape hatch — mirrors EntitlementsService's cache shape; no invalidate() call
   * site exists yet outside specs (FeatureConfigService.set/clear write straight through Prisma
   * and simply let the 30s TTL expire, same tradeoff EntitlementsService documents for itself). */
  invalidate(tenantId: string, key: string): void {
    this.cache.delete(`${tenantId}:${key}`);
  }
}
