import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { EntitlementsService } from "./entitlements.service";
import { FeatureOverrideService, FeatureOverrideEffect } from "./feature-override.service";
import { PlanCatalogService } from "./plan-catalog.service";
import { FEATURE_REGISTRY, FeatureDef } from "./feature-registry";
import { findPlanDefinition } from "./plan-catalog.constants";
import { resolveOneKey, toEffectiveFeature, ResolveContext } from "./feature-resolver.service";
import type {
  FeaturePreviewRequest,
  FeaturePreviewResponse,
  FeatureModeState,
} from "@routeflow/types";

/**
 * Opus review of 9923b87c, item 6: brief A ships no tenant-level mode provider (that's
 * brief C's TenantFeatureConfig) — there is no enforcement to preview yet. "Applying"
 * `request.modes` here means reflecting the REQUESTED value back in the response (source
 * "TENANT") rather than silently dropping it, so the preview UI shows what the admin is
 * about to set even though it can't yet change any gate. Mirrors
 * EntitlementAuthority.config()'s REGISTRY_DEFAULT shape for the un-requested case.
 */
function modeStateFor(
  feature: FeatureDef,
  requestedModes: Record<string, string> | undefined,
): FeatureModeState | undefined {
  if (!feature.config) return undefined;
  const allowed = Object.keys(feature.config.modes);
  const requested = requestedModes?.[feature.key];
  if (requested !== undefined) {
    return { value: requested, effective: requested, source: "TENANT", allowed, blocked: [] };
  }
  const fallback = feature.config.fallbackMode;
  return { value: fallback, effective: fallback, source: "REGISTRY_DEFAULT", allowed, blocked: [] };
}

/**
 * Design 2026-09-17 §2 "Preview": before/after per key for a hypothetical plan/override change,
 * writing nothing (oracle 6: "preview == post-apply trace, 0 writes"). Reuses
 * `resolveOneKey` — the SAME pure function the real resolver calls — against a hypothetical
 * `ResolveContext` built from the tenant's real current state plus the requested changes, so a
 * preview is provably what `apply` would compute, never a separately-maintained approximation.
 */
@Injectable()
export class FeaturePreviewService {
  constructor(
    private readonly entitlements: EntitlementsService,
    private readonly featureOverrides: FeatureOverrideService,
    private readonly catalog: PlanCatalogService,
    // Direct Prisma, not AddonService — see FeatureResolverService's constructor comment.
    private readonly prisma: PrismaService,
  ) {}

  async preview(tenantId: string, request: FeaturePreviewRequest): Promise<FeaturePreviewResponse> {
    const [ent, activeAddonRows, currentOverrides, publishedCatalog] = await Promise.all([
      this.entitlements.resolve(tenantId),
      this.prisma.tenantAddon.findMany({
        where: { tenantId, active: true },
        select: { addonKey: true },
      }),
      this.featureOverrides.allActive(tenantId),
      // Opus review of 9923b87c, item 6: a hypothetical plan swap targets what an admin would
      // ACTUALLY move the tenant onto — the current published catalog — never the tenant's own
      // (possibly stale) pinned version, which may not even carry the target plan key.
      this.catalog.getPublishedCatalog(),
    ]);
    const activeAddonKeys = activeAddonRows.map((a) => a.addonKey);
    const version = await this.catalog.getVersionForTenant(ent.planVersionId);
    const currentDef = findPlanDefinition(version.definitions, ent.planKey);
    const activeAddonSet = new Set(activeAddonKeys);
    const activeSkuSet = new Set(ent.addons);

    const beforeCtx: ResolveContext = {
      overrides: currentOverrides,
      activeAddonSet,
      planFeatureFlags: new Set(currentDef?.featureFlags ?? []),
      entFlags: ent.flags,
      activeSkuSet,
    };

    const afterOverrides = new Map<string, FeatureOverrideEffect>(currentOverrides);
    for (const o of request.overrides ?? []) {
      afterOverrides.set(o.featureKey, o.effect);
    }
    const afterPlanKey = request.planKey ?? ent.planKey;
    const isSwap = afterPlanKey !== ent.planKey;
    const afterDef = isSwap
      ? findPlanDefinition(publishedCatalog.definitions, afterPlanKey)
      : currentDef;
    const afterCatalogVersionId = isSwap ? publishedCatalog.id : version.id;
    // Opus review of 3585e1ec (re-review nit 3): addon-granted flags must be read from the
    // addon SKU's OWN grantsFlags metadata, never inferred by subtracting the current plan's
    // featureFlags from ent.flags — that subtraction silently drops a flag that happens to be
    // granted by BOTH the current plan AND an active addon (a real, common shape), losing it
    // the moment a swap targets a plan that doesn't also include it. Falls back to the
    // published catalog for a SKU code absent from the tenant's pinned version, mirroring
    // EntitlementsService.compute()'s own addon-metadata fallback.
    const pinnedSkuByCode = new Map(version.addonSkus.map((s) => [s.sku, s]));
    const publishedSkuByCode = new Map(publishedCatalog.addonSkus.map((s) => [s.sku, s]));
    const addonGrantedFlags = new Set<string>();
    for (const code of ent.addons) {
      const meta = pinnedSkuByCode.get(code) ?? publishedSkuByCode.get(code);
      if (meta) for (const flag of meta.grantsFlags) addonGrantedFlags.add(flag);
    }
    const afterEntFlags = [...new Set([...(afterDef?.featureFlags ?? []), ...addonGrantedFlags])];

    const afterCtx: ResolveContext = {
      overrides: afterOverrides,
      activeAddonSet,
      planFeatureFlags: new Set(afterDef?.featureFlags ?? []),
      entFlags: afterEntFlags,
      activeSkuSet,
    };

    const before = FEATURE_REGISTRY.map((f) => {
      const resolved = resolveOneKey(f, beforeCtx);
      return {
        ...toEffectiveFeature(resolved, resolved.effective, ent.planKey, version.id, true),
        ...(modeStateFor(f, undefined) ? { mode: modeStateFor(f, undefined) } : {}),
      };
    });
    const after = FEATURE_REGISTRY.map((f) => {
      const resolved = resolveOneKey(f, afterCtx);
      const mode = modeStateFor(f, request.modes);
      return {
        ...toEffectiveFeature(
          resolved,
          resolved.effective,
          afterPlanKey,
          afterCatalogVersionId,
          true,
        ),
        ...(mode ? { mode } : {}),
      };
    });

    const changed = FEATURE_REGISTRY.filter(
      (_f, i) => before[i].resolver !== after[i].resolver,
    ).map((f) => f.key);

    return { before, after, changed };
  }
}
