// Business profiles — platform-admin API client (SuperAdmin only). Plain async functions over `superAdminClient`,
// like ./features.ts. Contract: packages/types/api/profiles.ts.
import { superAdminClient } from "@/lib/admin-api";
import type {
  BusinessProfileApplyResponse,
  BusinessProfileKey,
  BusinessProfilePreviewResponse,
  BusinessProfileSummary,
  TenantCapability,
} from "@routeflow/types";

/** `GET /platform-admin/business-profiles` — ordered; an unavailable profile comes back with `available: false`. */
export async function fetchBusinessProfiles(): Promise<BusinessProfileSummary[]> {
  const res = await superAdminClient.get<{ profiles: BusinessProfileSummary[] }>(
    "/platform-admin/business-profiles",
  );
  return Array.isArray(res.data?.profiles) ? res.data.profiles : [];
}

/** `POST /platform-admin/tenants/:id/business-profile/preview` — a dry run: writes nothing. */
export async function previewBusinessProfile(
  tenantId: string,
  profile: BusinessProfileKey,
): Promise<BusinessProfilePreviewResponse> {
  const res = await superAdminClient.post(
    `/platform-admin/tenants/${tenantId}/business-profile/preview`,
    { profile },
  );
  return res.data;
}

/** `POST /platform-admin/tenants/:id/business-profile` — one audited action; re-applying is idempotent. */
export async function applyBusinessProfile(
  tenantId: string,
  profile: BusinessProfileKey,
  reason?: string,
): Promise<BusinessProfileApplyResponse> {
  const res = await superAdminClient.post(`/platform-admin/tenants/${tenantId}/business-profile`, {
    profile,
    ...(reason ? { reason } : {}),
  });
  return res.data;
}

/** `GET /platform-admin/tenants/:id/features/effective` — the `capability` block only (null when the API predates it). */
export async function fetchTenantCapability(tenantId: string): Promise<TenantCapability | null> {
  const res = await superAdminClient.get<{ capability?: TenantCapability }>(
    `/platform-admin/tenants/${tenantId}/features/effective`,
  );
  return res.data?.capability ?? null;
}
