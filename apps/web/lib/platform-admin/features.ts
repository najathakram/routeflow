// Feature-grants v2 (PR-2) — tenant Feature Console API client. Mirrors the existing
// platform-admin fetch pattern (plain async functions over `superAdminClient`, no TanStack
// Query — see lib/api/platform-pricing.ts). Endpoints come from brief A's contract
// (`local-assets/handoff/2026-09-17/fg-build/brief-A.md`); the `feature-config` write is brief
// C's endpoint and does not exist yet.
import { superAdminClient } from "@/lib/admin-api";
import type {
  EffectiveFeature,
  EntitlementsMode,
  FeatureConfigWriteRequest,
  FeatureConfigWriteResponse,
  FeatureDiffRow,
  FeaturePreviewRequest,
  FeaturePreviewResponse,
  FeatureRegistryRow,
  TenantEffectiveFeaturesResponse,
} from "@/app/(platform-admin)/admin/tenants/[id]/_features/types";

/** `GET /platform-admin/features/registry` — tenant-agnostic; areas/keys/modes come from here. */
export async function fetchFeatureRegistry(): Promise<FeatureRegistryRow[]> {
  const res = await superAdminClient.get("/platform-admin/features/registry");
  return res.data;
}

/** `GET /platform-admin/tenants/:id/features/effective` — the full per-key trace for one tenant.
 *  The response is a `{ effective: [...] }` wrapper, not a bare array — unwrap it here so every
 *  caller keeps working with a plain `EffectiveFeature[]`. */
export async function fetchTenantFeaturesEffective(tenantId: string): Promise<EffectiveFeature[]> {
  const res = await superAdminClient.get<TenantEffectiveFeaturesResponse>(
    `/platform-admin/tenants/${tenantId}/features/effective`,
  );
  return res.data.effective;
}

/** `GET /platform-admin/features/diffs?tenantId=` — this tenant's unexplained-diff count (item 4). */
export async function fetchTenantFeatureDiffs(tenantId: string): Promise<FeatureDiffRow[]> {
  const res = await superAdminClient.get("/platform-admin/features/diffs", {
    params: { tenantId },
  });
  return res.data;
}

/** `GET /platform-admin/entitlements/mode` — shadow/live, shown read-only in the tab header. */
export async function fetchEntitlementsMode(): Promise<{ mode: EntitlementsMode }> {
  const res = await superAdminClient.get("/platform-admin/entitlements/mode");
  return res.data;
}

/**
 * `POST /platform-admin/tenants/:id/features/preview` — writes nothing; every write path
 * (tier, override, mode) calls this first so preview == the diff the follow-up apply sends.
 */
export async function previewTenantFeatures(
  tenantId: string,
  request: FeaturePreviewRequest,
): Promise<FeaturePreviewResponse> {
  const res = await superAdminClient.post(
    `/platform-admin/tenants/${tenantId}/features/preview`,
    request,
  );
  return res.data;
}

/** `PUT /platform-admin/tenants/:id/feature-config/:key` (brief C, #837, landed). Response is
 *  `FeatureModeState` directly — no wrapper. */
export async function writeTenantFeatureConfig(
  tenantId: string,
  featureKey: string,
  request: FeatureConfigWriteRequest,
): Promise<FeatureConfigWriteResponse> {
  const res = await superAdminClient.put(
    `/platform-admin/tenants/${tenantId}/feature-config/${featureKey}`,
    request,
  );
  return res.data;
}
