// WP11 (SA-1106 C2): client for the reviewed feature change set. Plain async functions over `superAdminClient`
// (same pattern as ./features.ts). The save and the undo are one request each; the server writes the whole set
// in one transaction or nothing.
import type {
  ApplyFeatureChangesRequest,
  FeatureChangeInput,
  FeatureChangesApplyResponse,
  FeatureChangesPreviewResponse,
} from "@routeflow/types";
import { API_ERROR_CODES } from "@routeflow/types";
import { superAdminClient } from "@/lib/admin-api";

/** The hash of what the changes were made against: read when the first change is staged, sent back on save. */
export async function fetchFeatureInputsHash(tenantId: string): Promise<string> {
  const res = await superAdminClient.get<{ inputsHash?: string }>(
    `/platform-admin/tenants/${tenantId}/features/effective`,
  );
  if (!res.data.inputsHash) throw new Error("The server did not report a state to check against.");
  return res.data.inputsHash;
}

/** Checks the set and returns before/after per key; writes nothing. */
export async function previewFeatureChanges(
  tenantId: string,
  body: { expected: string; reason: string; changes: FeatureChangeInput[] },
): Promise<FeatureChangesPreviewResponse> {
  const request: ApplyFeatureChangesRequest = { ...body, dryRun: true };
  const res = await superAdminClient.post<FeatureChangesPreviewResponse>(
    `/platform-admin/tenants/${tenantId}/features/changes`,
    request,
  );
  return res.data;
}

/** Saves the whole set, or nothing. A 409 `FEATURE_INPUTS_CHANGED` means someone else changed the business. */
export async function applyFeatureChanges(
  tenantId: string,
  body: { expected: string; reason: string; changes: FeatureChangeInput[] },
): Promise<FeatureChangesApplyResponse> {
  const res = await superAdminClient.post<FeatureChangesApplyResponse>(
    `/platform-admin/tenants/${tenantId}/features/changes`,
    body,
  );
  return res.data;
}

/** Undoes one saved set, once, while nothing has changed since. */
export async function undoFeatureChanges(
  tenantId: string,
  changeSetId: string,
  reason: string,
): Promise<{ changeSetId: string; undoOf: string }> {
  const res = await superAdminClient.post(
    `/platform-admin/tenants/${tenantId}/features/changes/${changeSetId}/undo`,
    { reason },
  );
  return res.data;
}

/** The server's error code for a refused request, if it sent one. */
export function featureChangeErrorCode(e: unknown): string | undefined {
  const data = (e as { response?: { data?: { code?: string; message?: string } } })?.response?.data;
  return data?.code;
}

/** True when the business changed after the page read it (409, nothing was saved). */
export function isInputsChanged(e: unknown): boolean {
  return featureChangeErrorCode(e) === API_ERROR_CODES.FEATURE_INPUTS_CHANGED;
}

/** The server's own sentence for a refusal (it is written for a person), or the fallback. */
export function featureChangeMessage(e: unknown, fallback: string): string {
  const data = (e as { response?: { data?: { message?: string | string[] } } })?.response?.data;
  const m = Array.isArray(data?.message) ? data?.message.join(" ") : data?.message;
  return m && m.length < 300 ? m : fallback;
}
