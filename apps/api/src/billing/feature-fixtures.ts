/**
 * Shared fixture set for feature grants v2 (design 2026-09-17 §2), brief A's Done= line:
 * "Fixture set (all slices): {v10 pin, v11 pin, LITE, +GRANT, +DENY, usage-without-flag,
 * purchased addon}." Briefs B/C/D import these SAME fixtures rather than redeclaring plan/addon/
 * override test data — a resolver behavior change that isn't ALSO reflected here would silently
 * desync what every slice's tests exercise.
 *
 * Each fixture is a plain data shape (not a NestJS mock) so any test file can build whichever
 * provider mocks it needs from it; `mockCollaborators()` below builds the four
 * FeatureResolverService/EntitlementAuthority dependencies directly, for tests that just want a
 * working resolver/authority without hand-wiring each provider themselves.
 */

export interface PlanDefFixture {
  planKey: string;
  featureFlags: string[];
}

export interface FeatureFixture {
  name: string;
  planKey: string;
  planVersionId: string;
  /** The pinned catalog version's OWN plan definitions (what `findPlanDefinition` searches). */
  definitions: PlanDefFixture[];
  /** TenantAddon.addonKey values the tenant holds active (AddonService.getActiveAddons shape). */
  activeAddonKeys: string[];
  /** Canonical SKU codes the tenant's active addons resolve to (Entitlements.addons shape). */
  activeSkuCodes: string[];
  /** Active overrides for this tenant, by featureKey. */
  overrides: Array<{ featureKey: string; effect: "GRANT" | "DENY" }>;
  /** Registry keys `usage(key) > 0` per design's grandfather probe (PR-0b consumes this; kept
   *  here so every slice references the SAME usage set even before PR-0b reads it). */
  usageKeys: string[];
}

/** v10 pin: STARTER, pre-Lite-L2 catalog — none of the five WP2 flags exist in this plan's set. */
export const V10_PIN_FIXTURE: FeatureFixture = {
  name: "v10-pin",
  planKey: "STARTER",
  planVersionId: "fixture-v10",
  definitions: [
    { planKey: "STARTER", featureFlags: ["flag.msrp"] },
    { planKey: "GROWTH", featureFlags: ["flag.msrp", "flag.sales_agents"] },
    { planKey: "SCALE", featureFlags: ["flag.msrp", "flag.sales_agents", "flag.reports"] },
  ],
  activeAddonKeys: [],
  activeSkuCodes: [],
  overrides: [],
  usageKeys: [],
};

/** v11 pin: SCALE, current catalog, but missing #777's five WP2 flags — the P0 incident shape. */
export const V11_PIN_FIXTURE: FeatureFixture = {
  name: "v11-pin",
  planKey: "SCALE",
  planVersionId: "fixture-v11",
  definitions: [
    { planKey: "STARTER", featureFlags: ["flag.msrp"] },
    { planKey: "GROWTH", featureFlags: ["flag.msrp", "flag.sales_agents"] },
    {
      planKey: "SCALE",
      featureFlags: ["flag.msrp", "flag.sales_agents", "flag.reports", "flag.returns"],
    },
  ],
  activeAddonKeys: ["recurring_routes"],
  activeSkuCodes: [],
  overrides: [],
  usageKeys: [],
};

/** LITE: always-enforced (R3a.7) — no courtesy allow anywhere, dark or not. */
export const LITE_FIXTURE: FeatureFixture = {
  name: "lite",
  planKey: "LITE",
  planVersionId: "fixture-v11",
  definitions: [{ planKey: "LITE", featureFlags: [] }],
  activeAddonKeys: [],
  activeSkuCodes: [],
  overrides: [],
  usageKeys: [],
};

/** A SCALE tenant with an explicit GRANT override on a key its plan doesn't include. */
export const GRANT_OVERRIDE_FIXTURE: FeatureFixture = {
  ...V11_PIN_FIXTURE,
  name: "grant-override",
  overrides: [{ featureKey: "flag.estimates", effect: "GRANT" }],
};

/** A SCALE tenant with an explicit DENY override on a key its plan DOES include. */
export const DENY_OVERRIDE_FIXTURE: FeatureFixture = {
  ...V11_PIN_FIXTURE,
  name: "deny-override",
  overrides: [{ featureKey: "flag.reports", effect: "DENY" }],
};

/** GROWTH tenant that has been USING a key (grandfather-probe evidence) without holding its
 *  flag — PR-0b's own oracle set, defined here so it's the same tenant shape every slice sees. */
export const USAGE_WITHOUT_FLAG_FIXTURE: FeatureFixture = {
  name: "usage-without-flag",
  planKey: "GROWTH",
  planVersionId: "fixture-v11",
  definitions: [{ planKey: "GROWTH", featureFlags: ["flag.msrp"] }],
  activeAddonKeys: [],
  activeSkuCodes: [],
  overrides: [],
  usageKeys: ["flag.returns"],
};

/** SCALE tenant with a purchased, SKU-billed addon active (ADDON_SKU source, `charged: true`). */
export const PURCHASED_ADDON_FIXTURE: FeatureFixture = {
  name: "purchased-addon",
  planKey: "SCALE",
  planVersionId: "fixture-v11",
  definitions: [{ planKey: "SCALE", featureFlags: ["flag.msrp"] }],
  activeAddonKeys: ["tobacco_dealer"],
  activeSkuCodes: ["REGULATED_ITEMS"],
  overrides: [],
  usageKeys: [],
};

export const ALL_FIXTURES: readonly FeatureFixture[] = [
  V10_PIN_FIXTURE,
  V11_PIN_FIXTURE,
  LITE_FIXTURE,
  GRANT_OVERRIDE_FIXTURE,
  DENY_OVERRIDE_FIXTURE,
  USAGE_WITHOUT_FLAG_FIXTURE,
  PURCHASED_ADDON_FIXTURE,
];

/**
 * Builds jest.fn()-mocked EntitlementsService/AddonService/FeatureOverrideService/
 * PlanCatalogService from a fixture — the exact shapes FeatureResolverService/
 * EntitlementAuthority's constructors take. `flagsOverride` lets a caller layer
 * addon-grantsFlags-derived entries onto `ent.flags` without re-deriving the SKU→flags
 * bridge in every test (most fixtures need none; `purchased-addon`-style tests pass it).
 */
export function mockCollaborators(fixture: FeatureFixture, flagsOverride?: string[]) {
  const entFlags = flagsOverride ?? [
    ...(fixture.definitions.find((d) => d.planKey === fixture.planKey)?.featureFlags ?? []),
  ];

  const entitlements = {
    resolve: jest.fn().mockResolvedValue({
      tenantId: "t1",
      planKey: fixture.planKey,
      planName: fixture.planKey,
      planVersionId: fixture.planVersionId,
      flags: entFlags,
      addons: fixture.activeSkuCodes,
      caps: { seats: null, routes: null, scans: null, msgs: null, customers: null },
      trialEndsAt: null,
      readOnlyReason: null,
      status: "ACTIVE",
    }),
    hasFlag: jest
      .fn()
      .mockImplementation(async (_t: string, key: string) => entFlags.includes(key)),
    isAlwaysEnforcedTenant: jest.fn().mockResolvedValue(fixture.planKey === "LITE"),
  };

  // FeatureResolverService/EntitlementAuthority/FeaturePreviewService take PrismaService
  // directly for addon lookups (not AddonService — see their constructor comments), so the
  // mock only needs to answer `tenantAddon.findMany`/`findUnique` the same shape those real
  // queries return.
  const prisma = {
    tenantAddon: {
      findMany: jest.fn().mockResolvedValue(fixture.activeAddonKeys.map((k) => ({ addonKey: k }))),
      findUnique: jest.fn().mockImplementation(async ({ where }: any) => {
        const key = where.tenantId_addonKey?.addonKey;
        return fixture.activeAddonKeys.includes(key) ? { active: true } : null;
      }),
    },
  };

  const overrideMap = new Map(fixture.overrides.map((o) => [o.featureKey, o.effect]));
  const featureOverrides = {
    get: jest
      .fn()
      .mockImplementation(async (_t: string, key: string) => overrideMap.get(key) ?? null),
    getMany: jest.fn().mockImplementation(async (_t: string, keys: string[]) => {
      const m = new Map<string, "GRANT" | "DENY">();
      for (const k of keys) {
        const v = overrideMap.get(k);
        if (v) m.set(k, v);
      }
      return m;
    }),
    allActive: jest.fn().mockResolvedValue(overrideMap),
  };

  const catalog = {
    getVersionForTenant: jest.fn().mockResolvedValue({
      id: fixture.planVersionId,
      definitions: fixture.definitions,
      addonSkus: [],
    }),
  };

  return { entitlements, featureOverrides, catalog, prisma };
}
