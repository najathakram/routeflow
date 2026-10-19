// TEMPORARY: replace with packages/types/api/profiles.ts + business-profiles.ts when fix/mb-bo-api lands.
//
// BO-05 builds against the BO-03 / BO-04 contract before the MacBook lane's branch is on origin. Every type and
// client function below is a copy of that contract; when it lands, delete this file and point the imports at
// `@routeflow/types` and `@/lib/platform-admin/business-profiles` (one edit per importer).
import { superAdminClient } from "@/lib/admin-api";
import type {
  BusinessProfileApplyResponse,
  BusinessProfileKey,
  BusinessProfilePreviewResponse,
  BusinessProfileSummary,
} from "@routeflow/types";

/** Stored as `OpensAs` on the server: what a new staff order opens as when the counter shares the business. */
export type OpensAs = "order" | "counter";

/** The two presets BO-04 adds beside the five that exist today. */
export type CapabilityPresetKey =
  BusinessProfileKey | "delivery_shipping" | "delivery_shipping_pos";

/**
 * Per capability, why it cannot be ticked right now (e.g. "Not available yet"); `{}` today. There is NO plan-based
 * gating in the API: availability is registry-wide per mode and comps are free on every plan.
 */
export type CapabilityAvailability = Partial<Record<"delivery" | "shipping" | "counter", string>>;

/** The ticks a preset pre-fills (and the shape the request is built from). */
export interface CapabilityPresetTicks {
  delivery: boolean;
  doorPayments: boolean;
  shipping: boolean;
  counter: boolean;
  opensAs: OpensAs;
}

/** `GET /platform-admin/business-profiles` element once BO-03 adds `ticks`. */
export type CapabilityPresetSummary = Omit<BusinessProfileSummary, "key"> & {
  key: CapabilityPresetKey;
  ticks: CapabilityPresetTicks;
};

/** `GET /platform-admin/tenants/:id/business-capabilities` (BO-03): the ticks, read back from the server. */
export interface BusinessCapabilities {
  /** false = `fulfilment_model` is unset: nothing is ticked and the business works as before. */
  configured: boolean;
  delivery: boolean;
  doorPayments: boolean;
  shipping: boolean;
  counter: boolean;
  opensAs: OpensAs;
  /** Only Shipping + Counter without Delivery lets the admin pick. */
  opensAsChoosable: boolean;
  counterCapability: string;
  fleetHeld: boolean;
  /** The one preset whose tuple equals the saved setup, else null. The only source of "Current". */
  matchedPreset: CapabilityPresetKey | null;
  /** Capabilities that cannot be ticked, with the visible reason. Absent / `{}` = all available. */
  unavailable?: CapabilityAvailability;
}

/** Preview / confirm body (BO-04). The confirm adds `planFingerprint`. */
export interface BusinessCapabilitiesRequest {
  delivery?: boolean;
  doorPayments?: boolean;
  shipping?: boolean;
  counter?: boolean;
  opensAs?: OpensAs;
  reason?: string;
}

export interface ConfirmBusinessCapabilitiesRequest extends BusinessCapabilitiesRequest {
  planFingerprint: string;
}

/** Why Apply must stay off even though the plan itself is fine. */
export type CapabilitiesBlocked =
  | { code: "FULFILMENT_CARRIER_IN_TRANSIT"; count: number }
  | { code: "FEATURE_REQUIRES_UNMET"; key: string; missing: string[] };

/** The same plan sections as the business-profile preview, plus `blocked`. */
export type BusinessCapabilitiesPreviewResponse = Omit<
  BusinessProfilePreviewResponse,
  "profile"
> & {
  profile?: CapabilityPresetKey | null;
  blocked: CapabilitiesBlocked | null;
  /** The server's own answer for the ticks given. Optional: the shared `isOpensAsChoosable` gives the same rule. */
  opensAs?: OpensAs;
  opensAsChoosable?: boolean;
};

/** Confirm response. Only the alias (`business-profile`) call carries `profile`; this one carries `preset`. */
export type BusinessCapabilitiesApplyResponse = Omit<BusinessProfileApplyResponse, "profile"> & {
  capabilities?: CapabilityPresetTicks;
  /** The preset the applied ticks equal; null = custom. */
  preset?: CapabilityPresetKey | null;
};

/** New API error codes (BO-04); not in the shared enum until that branch lands. */
export const CAPABILITIES_ERROR_CODES = {
  BUSINESS_CAPABILITIES_EMPTY: "BUSINESS_CAPABILITIES_EMPTY",
} as const;

/** `GET /platform-admin/business-profiles` with the BO-03 `ticks` and the two new presets. */
export async function fetchCapabilityPresets(): Promise<CapabilityPresetSummary[]> {
  const res = await superAdminClient.get<{ profiles?: CapabilityPresetSummary[] }>(
    "/platform-admin/business-profiles",
  );
  return Array.isArray(res.data?.profiles) ? res.data.profiles : [];
}

/** `GET /platform-admin/business-profiles` as a catalog: the presets plus the tenant-less `availability` (create form). */
export async function fetchCapabilityCatalog(): Promise<{
  presets: CapabilityPresetSummary[];
  availability: CapabilityAvailability;
}> {
  const res = await superAdminClient.get<{
    profiles?: CapabilityPresetSummary[];
    availability?: CapabilityAvailability;
  }>("/platform-admin/business-profiles");
  return {
    presets: Array.isArray(res.data?.profiles) ? res.data.profiles : [],
    availability: res.data?.availability ?? {},
  };
}

/** `GET /platform-admin/tenants/:id/business-capabilities`. 503 FEATURES_UNAVAILABLE on a failed read. */
export async function fetchBusinessCapabilities(tenantId: string): Promise<BusinessCapabilities> {
  const res = await superAdminClient.get<BusinessCapabilities>(
    `/platform-admin/tenants/${tenantId}/business-capabilities`,
  );
  return res.data;
}

/** `POST .../business-capabilities/preview` — a dry run: writes nothing. `signal` aborts a superseded request. */
export async function previewBusinessCapabilities(
  tenantId: string,
  body: BusinessCapabilitiesRequest,
  signal?: AbortSignal,
): Promise<BusinessCapabilitiesPreviewResponse> {
  const res = await superAdminClient.post<BusinessCapabilitiesPreviewResponse>(
    `/platform-admin/tenants/${tenantId}/business-capabilities/preview`,
    body,
    signal ? { signal } : undefined,
  );
  return res.data;
}

/** `POST .../business-capabilities` — one audited action. A stale fingerprint is a 409 PROFILE_PLAN_CHANGED. */
export async function applyBusinessCapabilities(
  tenantId: string,
  body: BusinessCapabilitiesRequest,
  planFingerprint: string,
): Promise<BusinessCapabilitiesApplyResponse> {
  const request: ConfirmBusinessCapabilitiesRequest = { ...body, planFingerprint };
  const res = await superAdminClient.post<BusinessCapabilitiesApplyResponse>(
    `/platform-admin/tenants/${tenantId}/business-capabilities`,
    request,
  );
  return res.data;
}
