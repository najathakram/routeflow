// ─── Feature grants v2 (design 2026-09-17 §2) — the shared contract ────────────────────────
//
// Brief A owns this file; briefs B/C/D import it verbatim, never redeclare a shape here by
// hand. `FEATURE_SOURCE_VALUES` mirrors the Prisma enum `FeatureSource`
// (apps/api/prisma/schema/platform.prisma), pinned set-equal to `@prisma/client` by
// enum-parity.spec.ts via this package's public export surface — see enums.ts's header for
// the convention this follows. `EntitlementsMode` is NOT a Prisma enum: it's the value of the
// system-config key `entitlements.mode` (audited admin PUT), not a DB column.

export const FEATURE_SOURCE_VALUES = [
  "OVERRIDE_DENY",
  "OVERRIDE_GRANT",
  "ADDON_SKU",
  "PRESET",
  "NONE",
  "UNKNOWN",
] as const;
export type FeatureSource = (typeof FEATURE_SOURCE_VALUES)[number];

export const ENTITLEMENTS_MODE_VALUES = ["shadow", "live"] as const;
export type EntitlementsMode = (typeof ENTITLEMENTS_MODE_VALUES)[number];

export type FeatureLifecycle = "proposed" | "beta" | "ga" | "deprecated" | "sunset";

export interface FeatureModeOption {
  key: string;
  label: string;
  lifecycle: FeatureLifecycle;
  requires?: string[];
}

export interface FeatureRegistryRow {
  key: string;
  kind: "boolean" | "limit" | "metered";
  area: string;
  label: string;
  description: string;
  lifecycle: FeatureLifecycle;
  internal: boolean;
  gate: {
    via: "RequireAddon" | "RequirePlanFlag" | "guard" | "service" | "none";
    state: "dark" | "enforced" | "none";
  };
  billing: { skus: string[] };
  config?: { fallbackMode: string; modes: FeatureModeOption[] };
}

export interface FeatureModeState {
  value: string;
  effective: string;
  source: "TENANT" | "REGISTRY_DEFAULT";
  allowed: string[];
  blocked: string[];
}

export interface EffectiveFeature {
  key: string;
  area: string;
  serving: boolean;
  resolver: boolean;
  source: FeatureSource;
  detail: {
    overrideId?: string;
    reason?: string;
    kind?: string;
    expiresAt?: string | null;
    sku?: string;
    planKey: string;
    catalogVersionId: string;
    term?: "flag" | "includedSku" | "default";
    enforced: boolean;
  };
  billing: { charged: boolean; sku?: string };
  mode?: FeatureModeState;
}

export interface TenantFeaturesResponse {
  /** The old enforcement path's verdict, per key that path actually covers — byte-identical
   *  to `getSubscription().flags` (same gateVia filter, PREPIN, dark courtesy, and LITE). */
  served: string[];
  /** The shadow resolver's own verdict for every FEATURE_REGISTRY key — informational only;
   *  `served` is what's actually enforced while entitlements.mode is "shadow". */
  resolver: Record<string, boolean>;
  modes: Record<string, string>;
  catalogVersionId: string;
  computedAt: string;
}

export interface FeatureDiffRow {
  id: string;
  tenantId: string;
  featureKey: string;
  before: boolean;
  after: boolean;
  source: FeatureSource;
  firstSeenAt: string;
  lastSeenAt: string;
  count: number;
  explainedAt?: string | null;
  explanation?: string | null;
}

export interface FeaturePreviewRequest {
  planKey?: string;
  overrides?: {
    featureKey: string;
    effect: "GRANT" | "DENY";
    kind?: string;
    reason: string;
    expiresAt?: string | null;
  }[];
  modes?: Record<string, string>;
}

export interface FeaturePreviewResponse {
  before: EffectiveFeature[];
  after: EffectiveFeature[];
  changed: string[];
}
