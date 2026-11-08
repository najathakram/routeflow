import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { EntitlementsService } from "./entitlements.service";
import {
  FeatureOverrideService,
  FeatureOverrideEffect,
  FeatureOverrideDetail,
} from "./feature-override.service";
import { PlanCatalogService } from "./plan-catalog.service";
import { FEATURE_REGISTRY, FeatureDef, isDefaultGrantedAddon } from "./feature-registry";
import { addonSkuCode, effectivePlanFlags, findPlanDefinition } from "./plan-catalog.constants";
import { isCourtesyServed } from "./plan-flag-policy";
import type { EffectiveFeature, FeatureSource } from "@routeflow/types";

/** One key's fully-resolved verdict — the pieces `EntitlementAuthority`/the explain-trace/preview need. */
export interface ResolvedKey {
  key: string;
  /** What the guards SERVE: the strict answer, or the dark-gate courtesy on top of it (FG-1 WP2). */
  effective: boolean;
  /**
   * The owner's rule with no courtesy: plan preset + purchased add-ons + grants - denies. Equal to `effective`
   * except where the courtesy serves a key the plan does not hold (then false), and under a DENY (false).
   */
  strict: boolean;
  source: FeatureSource;
  term?: "flag" | "includedSku" | "default" | "courtesy";
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
    const [ent, activeAddonRows, overrides, overrideDetail] = await Promise.all([
      this.entitlements.resolve(tenantId),
      loadActiveAddonRows(this.prisma, tenantId),
      this.featureOverrides.allActive(tenantId),
      this.featureOverrides.activeDetail(tenantId),
    ]);
    const activeAddonKeys = activeAddonRows.map((a) => a.addonKey);
    const version = await this.catalog.getVersionForTenant(ent.planVersionId);
    const def = findPlanDefinition(version.definitions, ent.planKey);
    // #2700 (SA-559d): the plan's flags gain forward exactly as EntitlementsService.compute's do,
    // so a flag the PUBLISHED plan added is PRESET (included), never mistaken for an addon grant
    // (ADDON_SKU, charged). One published read, only when the pinned version isn't itself published.
    const published =
      version.status !== "PUBLISHED" ? await this.catalog.getPublishedVersion() : null;
    const planFeatureFlags = new Set(def ? effectivePlanFlags(def, version.id, published) : []);
    const activeAddonSet = new Set(activeAddonKeys);
    const activeSkuSet = new Set(ent.addons);
    // The courtesy and the billing fact, each from its ONE helper (the preview calls the same two).
    const courtesy = courtesyFor({
      planKey: ent.planKey,
      planFlags: ent.flags,
      overrides,
      held: heldAddonKeys(activeAddonSet, ent.flags, overrides),
    });
    const billed = billedKeySet(
      activeAddonRows,
      skuGrantsFlags([...(published?.addonSkus ?? []), ...version.addonSkus]),
    );

    const byKey = new Map<string, ResolvedKey>();
    for (const feature of FEATURE_REGISTRY) {
      byKey.set(
        feature.key,
        resolveOneKey(feature, {
          overrides,
          overrideDetail,
          activeAddonSet,
          planFeatureFlags,
          entFlags: ent.flags,
          activeSkuSet,
          courtesy,
          billed,
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
  /** SA-963 A-1: display data beside `overrides` (never read for a verdict); spread onto the two override returns only. */
  overrideDetail?: Map<string, FeatureOverrideDetail>;
  activeAddonSet: Set<string>;
  planFeatureFlags: Set<string>;
  entFlags: string[];
  activeSkuSet: Set<string>;
  /**
   * FG-1 WP2: true when the dark-gate courtesy serves this key. Built by `courtesyFor` (the one predicate,
   * `isCourtesyServed`); required so a caller that forgets it fails to compile instead of losing the courtesy.
   */
  courtesy: (feature: FeatureDef) => boolean;
  /** Registry keys that have an active, non-comp, billed row (`billedKeySet`). */
  billed: ReadonlySet<string>;
}

/** The columns of an active add-on row that the courtesy and the billing fact need. */
export const ADDON_BILLING_SELECT = {
  addonKey: true,
  sku: true,
  active: true,
  isComp: true,
  priceSnapshot: true,
  stripeItemId: true,
} as const;

export interface AddonBillingRow {
  addonKey: string;
  sku?: string | null;
  active?: boolean;
  isComp?: boolean | null;
  priceSnapshot?: unknown;
  stripeItemId?: string | null;
}

/** The ONE read of a tenant's active add-on rows, shared by `compute` and the preview so they cannot differ. */
export function loadActiveAddonRows(
  prisma: Pick<PrismaService, "tenantAddon">,
  tenantId: string,
): Promise<AddonBillingRow[]> {
  return prisma.tenantAddon.findMany({
    where: { tenantId, active: true },
    select: ADDON_BILLING_SELECT,
  });
}

/**
 * R6 / invariant I3: a row is billed when it is active, not a platform comp, and carries a price above zero
 * or a Stripe item. Applies under any override: a DENY or GRANT does not stop the charge.
 */
export const isBilledAddonRow = (row: AddonBillingRow): boolean =>
  row.active !== false &&
  !row.isComp &&
  (Number(row.priceSnapshot ?? 0) > 0 || Boolean(row.stripeItemId));

/** SKU code -> the flag keys it grants, from catalog SKU rows (the later entries win). */
export function skuGrantsFlags(
  skus: ReadonlyArray<{ sku: string; grantsFlags: readonly string[] }>,
): ReadonlyMap<string, readonly string[]> {
  return new Map(skus.map((s) => [s.sku, s.grantsFlags]));
}

/**
 * The ONE grants map for "which flags does this SKU grant": the PINNED catalog's entry wins over the published one
 * (a business keeps the SKU as it was sold to it), the published catalog fills in a code the pin lacks. I5 and the
 * preview both build their map here.
 */
export function pinnedOverPublishedGrants(
  published: ReadonlyArray<{ sku: string; grantsFlags: readonly string[] }>,
  pinned: ReadonlyArray<{ sku: string; grantsFlags: readonly string[] }>,
): ReadonlyMap<string, readonly string[]> {
  return skuGrantsFlags([...published, ...pinned]);
}

/**
 * The registry keys that have a billed row: the row's own `addonKey`, and the flags its SKU grants (a flag
 * bridged by a purchased SKU is charged through that row).
 */
export function billedKeySet(
  rows: readonly AddonBillingRow[],
  grants: ReadonlyMap<string, readonly string[]>,
): Set<string> {
  const keys = new Set<string>();
  for (const row of rows) {
    if (!isBilledAddonRow(row)) continue;
    keys.add(row.addonKey);
    for (const flag of (row.sku ? grants.get(row.sku) : undefined) ?? []) keys.add(flag);
  }
  return keys;
}

/**
 * FG-1 WP4: the ONE answer to "which registry keys does this row bill?" for the "still billed" reports (invariant I5 and
 * the preview warning). Same predicate as `billedKeySet` ({@link isBilledAddonRow}), but the SKU is read through
 * `addonSkuCode` so a legacy sku-null row (mapped by its add-on key) grants the same flags it is billed for.
 * `billedKeySet` itself is unchanged for its other callers.
 */
export function billedKeysOfRow(
  row: AddonBillingRow,
  grants: ReadonlyMap<string, readonly string[]>,
): string[] {
  if (!isBilledAddonRow(row)) return [];
  const code = addonSkuCode({ sku: row.sku, addonKey: row.addonKey });
  return [row.addonKey, ...((code ? grants.get(code) : undefined) ?? [])];
}

/** Add-on keys held through a row or a default grant (the set `AddonService.getActiveAddons` returns). */
export function heldAddonKeys(
  activeAddonSet: ReadonlySet<string>,
  entFlags: readonly string[],
  overrides: ReadonlyMap<string, FeatureOverrideEffect>,
): Set<string> {
  const held = new Set(activeAddonSet);
  for (const feature of FEATURE_REGISTRY) {
    if (isDefaultGrantedAddon(feature, activeAddonSet, entFlags, overrides)) held.add(feature.key);
  }
  return held;
}

/**
 * The context-bound courtesy predicate `ResolveContext.courtesy` takes: `isCourtesyServed` (plan-flag-policy.ts,
 * the one home of the rule) over one key, for one side of a comparison.
 */
export function courtesyFor(facts: {
  planKey: string;
  planFlags: readonly string[];
  overrides: ReadonlyMap<string, FeatureOverrideEffect>;
  held: ReadonlySet<string>;
}): (feature: FeatureDef) => boolean {
  return (feature) => isCourtesyServed({ keys: [feature.key], ...facts });
}

/**
 * Standalone, side-effect-free — the SAME resolution rule `FeatureResolverService.compute()`
 * and `FeaturePreviewService` both call, so "preview == post-apply trace" (oracle 6) holds by
 * construction: preview computes this with a hypothetical `ctx`, apply computes it with the
 * real post-write one, and nothing else differs.
 */
export function resolveOneKey(feature: FeatureDef, ctx: ResolveContext): ResolvedKey {
  const strict = resolveStrict(feature, ctx);
  const charged = ctx.billed.has(feature.key);
  if (strict.effective) return { ...strict, strict: true, charged };
  if (!ctx.courtesy(feature)) return { ...strict, strict: false, charged };
  // Served by courtesy: the guard lets it through, the owner's rule does not hold it. A DENY keeps its source
  // and detail (the credit check ignores overrides while the switch is off, so the DENY is still the news).
  return strict.source === "OVERRIDE_DENY"
    ? { ...strict, effective: true, strict: false, term: "courtesy", charged }
    : { ...strict, effective: true, strict: false, source: "PRESET", term: "courtesy", charged };
}

type StrictKey = Omit<ResolvedKey, "strict" | "charged">;

/** The owner's rule with no courtesy: preset + purchased add-ons + grants - denies. */
function resolveStrict(feature: FeatureDef, ctx: ResolveContext): StrictKey {
  const override = ctx.overrides.get(feature.key);
  const detail = ctx.overrideDetail?.get(feature.key);
  if (override === "GRANT") {
    return {
      key: feature.key,
      effective: true,
      source: "OVERRIDE_GRANT",
      ...detail,
    };
  }
  if (override === "DENY") {
    return {
      key: feature.key,
      effective: false,
      source: "OVERRIDE_DENY",
      ...detail,
    };
  }

  // Addon-keyed gates (RequireAddon and the one hand-written "guard" row, driver_payments):
  // mirrors AddonGuard's own `active.includes(k)` check exactly.
  const isAddonKeyed = feature.gate.via === "RequireAddon" || feature.gate.via === "guard";
  if (isAddonKeyed) {
    const active = ctx.activeAddonSet.has(feature.key);
    if (!active) {
      // Owner ruling 2026-09-28: a default-granted add-on is held with no row when its
      // `requires` are met — the SAME rule AddonService applies at runtime.
      if (isDefaultGrantedAddon(feature, ctx.activeAddonSet, ctx.entFlags, ctx.overrides)) {
        return {
          key: feature.key,
          effective: true,
          source: "PRESET",
          term: "default",
        };
      }
      return { key: feature.key, effective: false, source: "NONE" };
    }
    const grantingSku = feature.billing.skus.find((s) => ctx.activeSkuSet.has(s));
    if (grantingSku) {
      return {
        key: feature.key,
        effective: true,
        source: "ADDON_SKU",
        sku: grantingSku,
      };
    }
    return {
      key: feature.key,
      effective: true,
      source: "PRESET",
      term: "includedSku",
    };
  }

  // Everything else uses the dotted flag-key convention (RequirePlanFlag/service/none):
  // mirrors PlanFlagGuard/EntitlementsService.hasFlag's `ent.flags.includes(key)` exactly —
  // ent.flags is ALREADY plan.featureFlags ∪ activeAddon.grantsFlags, so this alone
  // reproduces "preset ∪ purchasedAddons" for the flag-keyed half of the registry.
  if (ctx.entFlags.includes(feature.key)) {
    if (ctx.planFeatureFlags.has(feature.key)) {
      return { key: feature.key, effective: true, source: "PRESET", term: "flag" };
    }
    // In ent.flags but not the plan's own featureFlags → granted by an active addon's
    // grantsFlags bridge (e.g. addon.buyer_portal via the BUYER_PORTAL SKU).
    return { key: feature.key, effective: true, source: "ADDON_SKU" };
  }

  if (feature.defaultGranted) {
    return { key: feature.key, effective: true, source: "PRESET", term: "default" };
  }

  return { key: feature.key, effective: false, source: "NONE" };
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
    resolver: resolved.strict,
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
