import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { EntitlementsService } from "./entitlements.service";
import { FeatureOverrideService, FeatureOverrideEffect } from "./feature-override.service";
import { PlanCatalogService } from "./plan-catalog.service";
import { FeatureConfigService } from "./feature-config.service";
import { FEATURE_REGISTRY } from "./feature-registry";
import { effectivePlanFlags, findPlanDefinition } from "./plan-catalog.constants";
import { resolveOneKey, toEffectiveFeature, ResolveContext } from "./feature-resolver.service";
import type { FeaturePreviewRequest, FeaturePreviewResponse } from "@routeflow/types";

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
    // The tenant's stored mode, read through the SAME `getState` as the Feature Console row (B1132).
    private readonly featureConfig: FeatureConfigService,
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
    // #2700 (SA-559d): before AND after read the plan's flags through the ONE flags-gain-forward
    // predicate, as compute/apply do — a gained-forward flag is never previewed as lost.
    const currentPlanFlags = currentDef
      ? effectivePlanFlags(currentDef, version.id, publishedCatalog)
      : [];
    const activeAddonSet = new Set(activeAddonKeys);
    const activeSkuSet = new Set(ent.addons);

    const beforeCtx: ResolveContext = {
      overrides: currentOverrides,
      activeAddonSet,
      planFeatureFlags: new Set(currentPlanFlags),
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
    const afterPlanFlags = isSwap
      ? afterDef
        ? effectivePlanFlags(afterDef, afterCatalogVersionId, publishedCatalog)
        : []
      : currentPlanFlags;
    const afterEntFlags = [...new Set([...afterPlanFlags, ...addonGrantedFlags])];

    const afterCtx: ResolveContext = {
      overrides: afterOverrides,
      activeAddonSet,
      planFeatureFlags: new Set(afterPlanFlags),
      entFlags: afterEntFlags,
      activeSkuSet,
    };

    // The mode state of every config-bearing key: before = the tenant's stored mode; after = the
    // requested mode, else the stored one carried over. Reads only; writes nothing.
    const modes = await Promise.all(
      FEATURE_REGISTRY.map(async (f) => {
        if (!f.config) return undefined;
        const stored = await this.featureConfig.getState(tenantId, f.key);
        const requested = request.modes?.[f.key];
        const hypothetical =
          requested === undefined
            ? stored
            : await this.featureConfig.getState(tenantId, f.key, requested);
        return { before: stored, after: hypothetical };
      }),
    );

    const before = FEATURE_REGISTRY.map((f, i) => {
      const resolved = resolveOneKey(f, beforeCtx);
      return {
        ...toEffectiveFeature(resolved, resolved.effective, ent.planKey, version.id, true),
        ...(modes[i] ? { mode: modes[i].before } : {}),
      };
    });
    const after = FEATURE_REGISTRY.map((f, i) => {
      const resolved = resolveOneKey(f, afterCtx);
      return {
        ...toEffectiveFeature(
          resolved,
          resolved.effective,
          afterPlanKey,
          afterCatalogVersionId,
          true,
        ),
        ...(modes[i] ? { mode: modes[i].after } : {}),
      };
    });

    const changed = FEATURE_REGISTRY.filter(
      (_f, i) => before[i].resolver !== after[i].resolver,
    ).map((f) => f.key);

    return { before, after, changed };
  }
}
