// Business profiles — platform-admin API client (SuperAdmin only). Plain async functions over `superAdminClient`,
// like ./features.ts. The contract is packages/types/api/profiles.ts; nothing here redeclares a shape from it.
import { superAdminClient } from "@/lib/admin-api";
import type {
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
