import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { EntitlementsService } from "./entitlements.service";
import { FeatureOverrideService, FeatureOverrideEffect } from "./feature-override.service";
import { PlanCatalogService } from "./plan-catalog.service";
import { FEATURE_REGISTRY, FeatureDef } from "./feature-registry";
import { findPlanDefinition } from "./plan-catalog.constants";
import type { EffectiveFeature, FeatureSource } from "@routeflow/types";

/** One key's fully-resolved verdict — the pieces `EntitlementAuthority`/the explain-trace/preview need. */
export interface ResolvedKey {
  key: string;
  effective: boolean;
  source: FeatureSource;
  term?: "flag" | "includedSku" | "default";
  overrideId?: string;
  reason?: string;
  kind?: string;
  expiresAt?: string | null;
  sku?: string;
  charged: boolean;
}

export interface ResolvedFeatures {
  tenantId: string;
  planKey: string;
  catalogVersionId: string;
  byKey: Map<string, ResolvedKey>;
  computedAt: string;
}

interface CacheEntry {
  value: ResolvedFeatures;
  expiresAt: number;
}

const CACHE_TTL_MS = 30_000;

/**
 * Design 2026-09-17 §2 "Effective": `(preset[plan] ∪ purchasedAddons ∪ grants) − denies`, one
 * evaluation point for every registry key. Deliberately reads the SAME underlying data
 * AddonGuard/PlanFlagGuard/EntitlementsService.hasFlag already read (active addon keys, the
 * merged entitlement flags array, active overrides) rather than re-deriving plan-preset logic —
 * this is what makes shadow parity (oracle 1) true by construction, not by coincidence.
 *
 * Returns `null` on any resolution failure (DB down / unseeded catalog) — callers decide what
 * "unknown" means for their own surface (EntitlementAuthority skips the diff; the explain trace
 * reports `source: UNKNOWN`).
 */
@Injectable()
export class FeatureResolverService {
  private readonly logger = new Logger(FeatureResolverService.name);
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly entitlements: EntitlementsService,
    private readonly featureOverrides: FeatureOverrideService,
    private readonly catalog: PlanCatalogService,
    // Direct Prisma, not AddonService: AddonService lives in BillingModule, which itself
    // imports EntitlementsModule — a reverse import here would be circular. Mirrors
    // EntitlementsService.compute()'s own addon lookup, which takes the identical shortcut
    // for the identical reason.
    private readonly prisma: PrismaService,
  ) {}

  async resolve(tenantId: string): Promise<ResolvedFeatures | null> {
    const now = Date.now();
    const cached = this.cache.get(tenantId);
    if (cached && cached.expiresAt > now) return cached.value;

    try {
      const value = await this.compute(tenantId);
      this.cache.set(tenantId, { value, expiresAt: now + CACHE_TTL_MS });
      if (this.cache.size > 1000) this.pruneExpired(now);
      return value;
    } catch (err) {
      this.logger.error(`Feature resolution failed for tenant ${tenantId}`, err as Error);
      return null;
    }
  }

  invalidate(tenantId: string): void {
    this.cache.delete(tenantId);
  }

  invalidateAll(): void {
    this.cache.clear();
  }

  private async compute(tenantId: string): Promise<ResolvedFeatures> {
    const [ent, activeAddonRows, overrides] = await Promise.all([
      this.entitlements.resolve(tenantId),
      this.prisma.tenantAddon.findMany({
        where: { tenantId, active: true },
        select: { addonKey: true },
      }),
      this.featureOverrides.allActive(tenantId),
    ]);
    const activeAddonKeys = activeAddonRows.map((a) => a.addonKey);
    const version = await this.catalog.getVersionForTenant(ent.planVersionId);
    const def = findPlanDefinition(version.definitions, ent.planKey);
    const planFeatureFlags = new Set(def?.featureFlags ?? []);
    const activeAddonSet = new Set(activeAddonKeys);
    const activeSkuSet = new Set(ent.addons);

    const byKey = new Map<string, ResolvedKey>();
    for (const feature of FEATURE_REGISTRY) {
      byKey.set(
        feature.key,
        resolveOneKey(feature, {
          overrides,
          activeAddonSet,
          planFeatureFlags,
          entFlags: ent.flags,
          activeSkuSet,
        }),
      );
    }

    return {
      tenantId,
      planKey: ent.planKey,
      catalogVersionId: version.id,
      byKey,
      computedAt: new Date().toISOString(),
    };
  }

  private pruneExpired(now: number): void {
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt <= now) this.cache.delete(key);
    }
  }
}

export interface ResolveContext {
  overrides: Map<string, FeatureOverrideEffect>;
  activeAddonSet: Set<string>;
  planFeatureFlags: Set<string>;
  entFlags: string[];
  activeSkuSet: Set<string>;
}

/**
 * Standalone, side-effect-free — the SAME resolution rule `FeatureResolverService.compute()`
 * and `FeaturePreviewService` both call, so "preview == post-apply trace" (oracle 6) holds by
 * construction: preview computes this with a hypothetical `ctx`, apply computes it with the
 * real post-write one, and nothing else differs.
 */
export function resolveOneKey(feature: FeatureDef, ctx: ResolveContext): ResolvedKey {
  const override = ctx.overrides.get(feature.key);
  if (override === "GRANT") {
    return { key: feature.key, effective: true, source: "OVERRIDE_GRANT", charged: false };
  }
  if (override === "DENY") {
    return { key: feature.key, effective: false, source: "OVERRIDE_DENY", charged: false };
  }

  // Addon-keyed gates (RequireAddon and the one hand-written "guard" row, driver_payments):
  // mirrors AddonGuard's own `active.includes(k)` check exactly.
  const isAddonKeyed = feature.gate.via === "RequireAddon" || feature.gate.via === "guard";
  if (isAddonKeyed) {
    const active = ctx.activeAddonSet.has(feature.key);
    if (!active) {
      return { key: feature.key, effective: false, source: "NONE", charged: false };
    }
    const grantingSku = feature.billing.skus.find((s) => ctx.activeSkuSet.has(s));
    if (grantingSku) {
      return {
        key: feature.key,
        effective: true,
        source: "ADDON_SKU",
        sku: grantingSku,
        charged: true,
      };
    }
    return {
      key: feature.key,
      effective: true,
      source: "PRESET",
      term: "includedSku",
      charged: false,
    };
  }

  // Everything else uses the dotted flag-key convention (RequirePlanFlag/service/none):
  // mirrors PlanFlagGuard/EntitlementsService.hasFlag's `ent.flags.includes(key)` exactly —
  // ent.flags is ALREADY plan.featureFlags ∪ activeAddon.grantsFlags, so this alone
  // reproduces "preset ∪ purchasedAddons" for the flag-keyed half of the registry.
  if (ctx.entFlags.includes(feature.key)) {
    if (ctx.planFeatureFlags.has(feature.key)) {
      return { key: feature.key, effective: true, source: "PRESET", term: "flag", charged: false };
    }
    // In ent.flags but not the plan's own featureFlags → granted by an active addon's
    // grantsFlags bridge (e.g. addon.buyer_portal via the BUYER_PORTAL SKU).
    return { key: feature.key, effective: true, source: "ADDON_SKU", charged: true };
  }

  if (feature.defaultGranted) {
    return { key: feature.key, effective: true, source: "PRESET", term: "default", charged: false };
  }

  return { key: feature.key, effective: false, source: "NONE", charged: false };
}

/** Shape a single resolved key into the wire-format `EffectiveFeature` the explain-trace/preview return. */
export function toEffectiveFeature(
  resolved: ResolvedKey,
  serving: boolean,
  planKey: string,
  catalogVersionId: string,
  enforced: boolean,
): EffectiveFeature {
  const feature = FEATURE_REGISTRY.find((f) => f.key === resolved.key);
  return {
    key: resolved.key,
    area: feature?.area ?? "platform",
    serving,
    resolver: resolved.effective,
    source: resolved.source,
    detail: {
      overrideId: resolved.overrideId,
      reason: resolved.reason,
      kind: resolved.kind,
      expiresAt: resolved.expiresAt ?? null,
      sku: resolved.sku,
      planKey,
      catalogVersionId,
      term: resolved.term,
      enforced,
    },
    billing: { charged: resolved.charged, sku: resolved.sku },
  };
}
