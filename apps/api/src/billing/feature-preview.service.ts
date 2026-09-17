import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { EntitlementsService } from "./entitlements.service";
import { FeatureOverrideService, FeatureOverrideEffect } from "./feature-override.service";
import { PlanCatalogService } from "./plan-catalog.service";
import { FEATURE_REGISTRY } from "./feature-registry";
import { findPlanDefinition } from "./plan-catalog.constants";
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
  ) {}

  async preview(tenantId: string, request: FeaturePreviewRequest): Promise<FeaturePreviewResponse> {
    const [ent, activeAddonRows, currentOverrides] = await Promise.all([
      this.entitlements.resolve(tenantId),
      this.prisma.tenantAddon.findMany({
        where: { tenantId, active: true },
        select: { addonKey: true },
      }),
      this.featureOverrides.allActive(tenantId),
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
    const afterDef =
      afterPlanKey === ent.planKey
        ? currentDef
        : findPlanDefinition(version.definitions, afterPlanKey);
    // Addon-granted flags don't depend on plan — isolate them from the current merged set so a
    // hypothetical plan swap doesn't lose or fabricate an addon-sourced flag.
    const addonGrantedFlags = ent.flags.filter(
      (f) => !(currentDef?.featureFlags ?? []).includes(f),
    );
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
      return toEffectiveFeature(resolved, resolved.effective, ent.planKey, version.id, true);
    });
    const after = FEATURE_REGISTRY.map((f) => {
      const resolved = resolveOneKey(f, afterCtx);
      return toEffectiveFeature(resolved, resolved.effective, afterPlanKey, version.id, true);
    });

    const changed = FEATURE_REGISTRY.filter(
      (_f, i) => before[i].resolver !== after[i].resolver,
    ).map((f) => f.key);

    return { before, after, changed };
  }
}
