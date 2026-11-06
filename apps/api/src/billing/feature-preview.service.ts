import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { EntitlementsService } from "./entitlements.service";
import {
  FeatureOverrideService,
  FeatureOverrideEffect,
  FeatureOverrideDetail,
} from "./feature-override.service";
import { PlanCatalogService } from "./plan-catalog.service";
import { FeatureConfigService } from "./feature-config.service";
import { FEATURE_REGISTRY } from "./feature-registry";
import { effectivePlanFlags, findPlanDefinition } from "./plan-catalog.constants";
import {
  billedKeySet,
  courtesyFor,
  heldAddonKeys,
  loadActiveAddonRows,
  resolveOneKey,
  skuGrantsFlags,
  toEffectiveFeature,
  ResolveContext,
} from "./feature-resolver.service";
import type {
  FeaturePreviewRequest,
  FeaturePreviewResponse,
  PreviewOmission,
} from "@routeflow/types";

/** A plan move changes customer limits and the monthly price; this preview shows neither (R5). */
/**
 * The HTTP request plus one server-side field (SA-1099 A-7, kept out of the shared type: no client sends it). `versionId`
 * judges `planKey` as that PUBLISHED catalog version instead of the tenant's pinned one, so a caller that charges from
 * the published version (`subscribe`) and the preview read the same plan. Any other id is ignored.
 */
export type FeaturePreviewInput = FeaturePreviewRequest & { versionId?: string };

const PLAN_MOVE_OMISSIONS: readonly PreviewOmission[] = ["limits", "price"];

/**
 * Design 2026-09-17 §2 "Preview": before/after per key for a hypothetical plan/override change,
 * writing nothing (oracle 6: "preview == post-apply trace, 0 writes"). Reuses
 * `resolveOneKey` — the SAME pure function the real resolver calls — against a hypothetical
 * `ResolveContext` built from the tenant's real current state plus the requested changes, so a
 * preview is provably what `apply` would compute, never a separately-maintained approximation.
 *
 * Courtesy is read PER SIDE (FG-1 WP2): "before" takes the tenant's plan, "after" the target plan, each with its own
 * flags and overrides, so a move to an always-enforced plan loses what the courtesy was serving.
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

  async preview(tenantId: string, request: FeaturePreviewInput): Promise<FeaturePreviewResponse> {
    const [ent, activeAddonRows, currentOverrides, currentDetail, publishedCatalog] =
      await Promise.all([
        this.entitlements.resolve(tenantId),
        loadActiveAddonRows(this.prisma, tenantId),
        this.featureOverrides.allActive(tenantId),
        this.featureOverrides.activeDetail(tenantId),
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

    // The billing fact is the same on both sides (a plan move leaves the rows alone); SKU grants read like
    // `compute` does: the tenant's pinned version, the published catalog for a code it lacks.
    const billed = billedKeySet(
      activeAddonRows,
      skuGrantsFlags([...publishedCatalog.addonSkus, ...version.addonSkus]),
    );

    const beforeCtx: ResolveContext = {
      overrides: currentOverrides,
      overrideDetail: currentDetail,
      activeAddonSet,
      planFeatureFlags: new Set(currentPlanFlags),
      entFlags: ent.flags,
      activeSkuSet,
      courtesy: courtesyFor({
        planKey: ent.planKey,
        planFlags: ent.flags,
        overrides: currentOverrides,
        held: heldAddonKeys(activeAddonSet, ent.flags, currentOverrides),
      }),
      billed,
    };

    const afterOverrides = new Map<string, FeatureOverrideEffect>(currentOverrides);
    // SA-963 A-1: each requested key REPLACES the stored detail with the request's own, so a preview of a DENY over a
    // stored dated GRANT never shows the old grant's date.
    const afterDetail = new Map<string, FeatureOverrideDetail>(currentDetail);
    for (const o of request.overrides ?? []) {
      afterOverrides.set(o.featureKey, o.effect);
      const ends = o.expiresAt ? new Date(o.expiresAt) : null;
      afterDetail.set(o.featureKey, {
        kind: o.kind ?? "COMP",
        reason: o.reason,
        expiresAt: ends && !Number.isNaN(ends.getTime()) ? ends.toISOString() : null,
      });
    }
    const afterPlanKey = request.planKey ?? ent.planKey;
    const isSwap = afterPlanKey !== ent.planKey;
    // SA-1099 A-7: a same-plan call that names the published version (`subscribe` charges from it) reads that version too.
    const onPublished = isSwap || request.versionId === publishedCatalog.id;
    const afterDef = onPublished
      ? findPlanDefinition(publishedCatalog.definitions, afterPlanKey)
      : currentDef;
    const afterCatalogVersionId = onPublished ? publishedCatalog.id : version.id;
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
    const afterPlanFlags = onPublished
      ? afterDef
        ? effectivePlanFlags(afterDef, afterCatalogVersionId, publishedCatalog)
        : []
      : currentPlanFlags;
    const afterEntFlags = [...new Set([...afterPlanFlags, ...addonGrantedFlags])];

    const afterCtx: ResolveContext = {
      overrides: afterOverrides,
      overrideDetail: afterDetail,
      activeAddonSet,
      planFeatureFlags: new Set(afterPlanFlags),
      entFlags: afterEntFlags,
      activeSkuSet,
      courtesy: courtesyFor({
        planKey: afterPlanKey,
        planFlags: afterEntFlags,
        overrides: afterOverrides,
        held: heldAddonKeys(activeAddonSet, afterEntFlags, afterOverrides),
      }),
      billed,
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

    // `changed`: the served answer or the strict answer moves (a GRANT over a courtesy row moves only the second).
    const changed = FEATURE_REGISTRY.filter(
      (_f, i) => before[i].serving !== after[i].serving || before[i].resolver !== after[i].resolver,
    ).map((f) => f.key);
    // `laterLost`: still served after the change, by courtesy, though the strict answer was yes and is now no.
    const laterLost = FEATURE_REGISTRY.filter(
      (_f, i) => before[i].resolver && !after[i].resolver && after[i].serving,
    ).map((f) => f.key);

    return { before, after, changed, laterLost, omitted: isSwap ? [...PLAN_MOVE_OMISSIONS] : [] };
  }
}
