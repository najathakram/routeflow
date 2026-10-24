// Business profiles — platform-admin API client (SuperAdmin only). Plain async functions over `superAdminClient`,
// like ./features.ts. The contract is packages/types/api/profiles.ts; nothing here redeclares a shape from it.
import { superAdminClient } from "@/lib/admin-api";
import type {
  BusinessCapabilities,
  BusinessCapabilitiesApplyResponse,
  BusinessCapabilitiesPreviewResponse,
  BusinessCapabilitiesRequest,
  ConfirmBusinessCapabilitiesRequest,
  ConfirmBusinessProfileRequest,
  BusinessProfileApplyResponse,
  BusinessProfileKey,
  BusinessProfileListResponse,
  BusinessProfilePreviewResponse,
  BusinessProfileSummary,
  FeatureModeState,
} from "@routeflow/types";

/** `GET /platform-admin/business-profiles` — registry order; an unavailable profile has `available: false`. */
export async function fetchBusinessProfiles(): Promise<BusinessProfileSummary[]> {
  const res = await superAdminClient.get<BusinessProfileListResponse>(
    "/platform-admin/business-profiles",
  );
  return Array.isArray(res.data?.profiles) ? res.data.profiles : [];
}

/** `GET /platform-admin/tenants/:id/business-capabilities` — the ticks, read back from the server (BO-03). */
export async function fetchBusinessCapabilities(tenantId: string): Promise<BusinessCapabilities> {
  const res = await superAdminClient.get<BusinessCapabilities>(
    `/platform-admin/tenants/${tenantId}/business-capabilities`,
  );
  return res.data;
}

/** `POST /platform-admin/tenants/:id/business-profile/preview` — a dry run: writes nothing. */
export async function previewBusinessProfile(
  tenantId: string,
  profile: BusinessProfileKey,
): Promise<BusinessProfilePreviewResponse> {
  const res = await superAdminClient.post<BusinessProfilePreviewResponse>(
    `/platform-admin/tenants/${tenantId}/business-profile/preview`,
    { profile },
  );
  return res.data;
}

/**
 * `POST /platform-admin/tenants/:id/business-profile` — one audited action; re-applying is idempotent.
 * Sends the preview's `planFingerprint`: the server applies only the plan that was shown, else a 409
 * PROFILE_PLAN_CHANGED (the picker re-previews).
 */
export async function applyBusinessProfile(
  tenantId: string,
  profile: BusinessProfileKey,
  planFingerprint: string,
): Promise<BusinessProfileApplyResponse> {
  const body: ConfirmBusinessProfileRequest = { profile, planFingerprint };
  const res = await superAdminClient.post<BusinessProfileApplyResponse>(
    `/platform-admin/tenants/${tenantId}/business-profile`,
    body,
  );
  return res.data;
}

/**
 * `POST /platform-admin/tenants/:id/business-capabilities/preview` (BO-04) — a dry run for the ticks: writes
 * nothing. A blocked plan is still a 200; its `blocked` field says why Confirm must stay disabled.
 */
export async function previewBusinessCapabilities(
  tenantId: string,
  ticks: BusinessCapabilitiesRequest,
): Promise<BusinessCapabilitiesPreviewResponse> {
  const res = await superAdminClient.post<BusinessCapabilitiesPreviewResponse>(
    `/platform-admin/tenants/${tenantId}/business-capabilities/preview`,
    ticks,
  );
  return res.data;
}

/**
 * `POST /platform-admin/tenants/:id/business-capabilities` (BO-04) — one audited action; re-applying is
 * idempotent. Sends the preview's `planFingerprint` (else a 409 PROFILE_PLAN_CHANGED: re-preview).
 */
export async function applyBusinessCapabilities(
  tenantId: string,
  ticks: BusinessCapabilitiesRequest,
  planFingerprint: string,
  reason?: string,
): Promise<BusinessCapabilitiesApplyResponse> {
  const body: ConfirmBusinessCapabilitiesRequest = {
    ...ticks,
    planFingerprint,
    ...(reason ? { reason } : {}),
  };
  const res = await superAdminClient.post<BusinessCapabilitiesApplyResponse>(
    `/platform-admin/tenants/${tenantId}/business-capabilities`,
    body,
  );
  return res.data;
}

/**
 * `GET /platform-admin/tenants/:id/feature-config/:key` — the tenant's stored value for one config mode
 * (`fulfilment_model`, `counter_sales`). `"unset"` when the response carries no usable value.
 */
export async function fetchTenantConfigValue(tenantId: string, key: string): Promise<string> {
  const res = await superAdminClient.get<Partial<FeatureModeState>>(
    `/platform-admin/tenants/${tenantId}/feature-config/${key}`,
  );
  const value = res.data?.value;
  return typeof value === "string" && value ? value : "unset";
}
