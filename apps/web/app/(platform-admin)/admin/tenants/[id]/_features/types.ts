// Feature grants v2 (PR-2) — re-exports brief A's landed contract (`@routeflow/types`,
// `packages/types/api/features.ts`) plus a couple of D-local, UI-only derived types that are
// NOT part of that contract (FeatureBadge, and the brief-C mode-write request/response shape,
// which is mocked until brief C lands — see lib/platform-admin/features.ts's TODO(C)).
export { FEATURE_SOURCE_VALUES, ENTITLEMENTS_MODE_VALUES } from "@routeflow/types";
export type {
  FeatureSource,
  EntitlementsMode,
  FeatureLifecycle,
  FeatureModeOption,
  FeatureRegistryRow,
  FeatureModeState,
  EffectiveFeature,
  TenantEffectiveFeaturesResponse,
  TenantFeaturesResponse,
  FeatureDiffRow,
  FeaturePreviewRequest,
  FeaturePreviewResponse,
} from "@routeflow/types";

// ─── D-local additions (not part of A's contract — UI-only derived types) ─────────────────────

/** Badge shown per feature row, derived from `EffectiveFeature.source` (+ `detail.kind`). */
export type FeatureBadge =
  "inherited" | "added" | "removed" | "grandfathered" | "purchased" | "off" | "unknown";

// Brief C's real request/response shape for `PUT /platform-admin/tenants/:id/feature-config/:key`
// (#837, landed) — verified against the live endpoint: `reason` is required (400 without it),
// and the response is `FeatureModeState` directly, not a `{key, mode}` wrapper.
export interface FeatureConfigWriteRequest {
  mode: string;
  reason: string;
}
export type FeatureConfigWriteResponse = import("@routeflow/types").FeatureModeState;
