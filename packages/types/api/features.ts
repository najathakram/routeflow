// ─── Feature grants v2 (design 2026-09-17 §2) — the shared contract ────────────────────────
//
// Brief A owns this file; briefs B/C/D import it verbatim, never redeclare a shape here by
// hand. `FEATURE_SOURCE_VALUES` mirrors the Prisma enum `FeatureSource`
// (apps/api/prisma/schema/platform.prisma), pinned set-equal to `@prisma/client` by
// enum-parity.spec.ts via this package's public export surface — see enums.ts's header for
// the convention this follows. `EntitlementsMode` is NOT a Prisma enum: it's the value of the
// system-config key `entitlements.mode` (audited admin PUT), not a DB column.

import type { TenantCapabilities } from "./fulfilment";

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

// SA-1032: the `promotions` feature-config key. Anything but an explicit "off" (no row, "unset",
// "on", an unreadable config) keeps promotions on, so a business that never touched it sees no
// change.
export const PROMOTIONS_MODE_VALUES = ["unset", "on", "off"] as const;
export type PromotionsMode = (typeof PROMOTIONS_MODE_VALUES)[number];
export function promotionsOn(mode?: string | null): boolean {
  return mode !== "off";
}

export type FeatureLifecycle = "proposed" | "beta" | "ga" | "deprecated" | "sunset";

// ─── Back office for business nature (SA-950 piece A) ──────────────────────────────────────
// What KIND of choice a registry row is. Purpose answers one question and never encodes who
// pays (paid-ness stays derived from billing.skus, gate.via and the grant source):
//   business   - it changes how this business takes, hands over, prices or gets paid for orders
//   commercial - a tool, report, integration or allowance the business buys
//   release    - a version of our code (global, never a per-business choice)
// The union below makes the compiler enforce the purpose/category pairs. `allowance` is exactly
// the non-boolean rows (limit and metered); they live in Plan & billing, never in Features.
export const FEATURE_PURPOSE_VALUES = ["business", "commercial", "release"] as const;
export type FeaturePurpose = (typeof FEATURE_PURPOSE_VALUES)[number];

export const FEATURE_BUSINESS_CATEGORY_VALUES = [
  "hand_over",
  "what_it_sells",
  "how_it_gets_paid",
] as const;
export type FeatureBusinessCategory = (typeof FEATURE_BUSINESS_CATEGORY_VALUES)[number];

export const FEATURE_COMMERCIAL_CATEGORY_VALUES = ["office_tools", "allowance"] as const;
export type FeatureCommercialCategory = (typeof FEATURE_COMMERCIAL_CATEGORY_VALUES)[number];

export type FeatureCategory = FeatureBusinessCategory | FeatureCommercialCategory;

export const FEATURE_RELEASE_STAGE_VALUES = ["building", "per_tenant_legacy", "default"] as const;
export type FeatureReleaseStage = (typeof FEATURE_RELEASE_STAGE_VALUES)[number];

/**
 * A release row's life. `endDate` (flip date + 14 days) exists only once the row is `default`;
 * before that the row carries `reviewBy`, the same convention dark gates use. `per_tenant_legacy`
 * names what the three flag.units_* rows really are today; it is count-pinned and shrink-only.
 * `removalIssue` is the board id of the work that removes the row.
 */
export type FeatureRelease =
  | {
      stage: "building" | "per_tenant_legacy";
      introduced: string;
      removalIssue: string;
      reviewBy: string;
    }
  | { stage: "default"; introduced: string; removalIssue: string; endDate: string };

export type FeatureNature =
  | { purpose: "business"; category: FeatureBusinessCategory }
  | { purpose: "commercial"; category: FeatureCommercialCategory }
  | { purpose: "release"; release: FeatureRelease };

/** Present only on a row whose feature does not work end to end yet; `missing` says what is absent. */
export interface FeatureIncomplete {
  missing: string;
}

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
  /** SA-950 A3: what kind of choice this row is (see FEATURE_PURPOSE_VALUES). */
  purpose: FeaturePurpose;
  /** Absent on a `release` row. */
  category?: FeatureCategory;
  /** Lower-case search terms beyond the label and description ("till", "walk-in"). */
  keywords: string[];
  /** Present only when the feature does not work end to end yet. */
  incomplete?: FeatureIncomplete;
  /** Present only on a `release` row. */
  release?: { stage: FeatureReleaseStage };
  gate: {
    via: "RequireAddon" | "RequirePlanFlag" | "guard" | "service" | "none";
    state: "dark" | "enforced" | "none";
  };
  billing: { skus: string[] };
  config?: { fallbackMode: string; modes: FeatureModeOption[] };
  /** Other registry keys this one depends on (B519) — mirrors `FeatureDef.requires` in
   *  apps/api/src/billing/feature-registry.ts verbatim; not to be confused with
   *  `FeatureModeOption.requires` above, a different per-config-mode concept. */
  requires?: { allOf?: string[]; anyOf?: string[] };
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

/** `GET /platform-admin/tenants/:id/features/effective` response shape (brief A) — a wrapper
 *  object, not a bare array. */
export interface TenantEffectiveFeaturesResponse {
  effective: EffectiveFeature[];
}

export interface TenantFeaturesResponse {
  /** Business profiles 1A: the derived capability answers; clients read these, never raw modes. */
  capabilities: TenantCapabilities;
  /** The old enforcement path's verdict, per key that path actually covers — byte-identical
   *  to `getSubscription().flags` (same gateVia filter, PREPIN, dark courtesy, and LITE). */
  served: string[];
  /** The shadow resolver's own verdict for every FEATURE_REGISTRY key — informational only;
   *  `served` is what's actually enforced while entitlements.mode is "shadow". */
  resolver: Record<string, boolean>;
  /**
   * Feature modes plus (SA-138) the TENANT-scope effective value of every policy registry key
   * that allows TENANT scope. A policy value rides here as an `enum` value verbatim (`"amend"`)
   * or, for `money`/`set`, as its JSON text (`"null"`, `"250"`,
   * `'["originalPrice","discount","msrp"]'`). A missing key or an unparseable value means
   * "today's behaviour" (the registry default). Customer/category-scope values never ride here.
   */
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
