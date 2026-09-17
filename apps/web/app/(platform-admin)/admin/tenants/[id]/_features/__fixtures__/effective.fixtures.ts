import type { EffectiveFeature, TenantFeaturesResponse } from "../types";

const PLAN_KEY = "PROFESSIONAL";
const CATALOG_VERSION_ID = "catalog-v11";

function base(
  key: string,
  area: string,
  overrides: Partial<EffectiveFeature> = {},
): EffectiveFeature {
  return {
    key,
    area,
    serving: false,
    resolver: false,
    source: "NONE",
    detail: { planKey: PLAN_KEY, catalogVersionId: CATALOG_VERSION_ID, enforced: true },
    billing: { charged: false },
    ...overrides,
  };
}

// One EffectiveFeature per REGISTRY_FIXTURE row, one per FeatureSource → badge mapping (test 1:
// "badges match `source` one-to-one"): removed / purchased / inherited(+mode) / grandfathered /
// added / off. `route_optimization`'s `mode` demonstrates BOTH a blocked option (`scheduled`,
// missing `route_scheduling_addon`) and the synthetic "mixed" effective value in one fixture.
export const EFFECTIVE_FIXTURE: EffectiveFeature[] = [
  base("tobacco_dealer", "compliance", {
    serving: false,
    resolver: true,
    source: "OVERRIDE_DENY",
    detail: {
      overrideId: "ov-1",
      reason: "Client requested removal during a compliance review.",
      kind: "SUPPORT",
      expiresAt: null,
      planKey: PLAN_KEY,
      catalogVersionId: CATALOG_VERSION_ID,
      enforced: true,
    },
    billing: { charged: false },
  }),
  base("msrp", "compliance", {
    serving: true,
    resolver: true,
    source: "OVERRIDE_GRANT",
    detail: {
      overrideId: "ov-2",
      reason: "Grandfathered from the legacy MSRP pilot cohort.",
      kind: "GRANDFATHER",
      expiresAt: null,
      planKey: PLAN_KEY,
      catalogVersionId: CATALOG_VERSION_ID,
      enforced: true,
    },
    billing: { charged: false },
  }),
  base("recurring_routes", "routes", {
    serving: true,
    resolver: true,
    source: "ADDON_SKU",
    detail: {
      sku: "recurring_routes",
      planKey: PLAN_KEY,
      catalogVersionId: CATALOG_VERSION_ID,
      enforced: true,
    },
    billing: { charged: true, sku: "recurring_routes" },
  }),
  base("route_optimization", "routes", {
    serving: true,
    resolver: true,
    source: "PRESET",
    detail: {
      term: "default",
      planKey: PLAN_KEY,
      catalogVersionId: CATALOG_VERSION_ID,
      enforced: false,
    },
    billing: { charged: false },
    mode: {
      value: "mixed",
      effective: "mixed",
      source: "TENANT",
      allowed: ["manual", "mixed"],
      blocked: ["scheduled"],
    },
  }),
  base("developer_mode", "platform", {
    serving: true,
    resolver: false,
    source: "OVERRIDE_GRANT",
    detail: {
      overrideId: "ov-3",
      reason: "Piloting the mobile driver-app preview.",
      kind: "PILOT",
      expiresAt: "2026-12-31T00:00:00.000Z",
      planKey: PLAN_KEY,
      catalogVersionId: CATALOG_VERSION_ID,
      enforced: false,
    },
    billing: { charged: false },
  }),
  base("boxes_pieces_mode", "platform", {
    serving: false,
    resolver: false,
    source: "NONE",
    detail: { planKey: PLAN_KEY, catalogVersionId: CATALOG_VERSION_ID, enforced: true },
    billing: { charged: false },
  }),
];

export const TENANT_FEATURES_RESPONSE_FIXTURE: TenantFeaturesResponse = {
  effective: EFFECTIVE_FIXTURE.filter((f) => f.serving).map((f) => f.key),
  modes: { route_optimization: "mixed" },
  catalogVersionId: CATALOG_VERSION_ID,
  computedAt: "2026-09-17T00:00:00.000Z",
};
