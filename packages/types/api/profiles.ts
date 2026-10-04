import type { FeaturePreviewResponse } from "./features";

// ─── Business profiles (1A) — the shared contract ──────────────────────────────────────────
//
// A profile is a named starting bundle: grants/denies on the fleet feature keys plus one config
// mode (`fulfilment_model`). The registry data lives in apps/api/src/billing/business-profiles.ts;
// the apply path is platform-admin only. `unset` fulfilment = today's behavior for every tenant.

export const BUSINESS_PROFILE_KEYS = [
  "delivery_distributor",
  "shipping_wholesaler",
  "pickup_counter",
] as const;
export type BusinessProfileKey = (typeof BUSINESS_PROFILE_KEYS)[number];

/** The profiles a tenant can be created with (pickup is reserved, never applicable yet). */
export const CREATABLE_BUSINESS_PROFILE_KEYS = [
  "delivery_distributor",
  "shipping_wholesaler",
] as const;

export const FULFILMENT_MODE_VALUES = ["unset", "delivery", "ship", "both", "pickup"] as const;
export type FulfilmentMode = (typeof FULFILMENT_MODE_VALUES)[number];

/** `GET /platform-admin/business-profiles` row. */
export interface BusinessProfileSummary {
  key: BusinessProfileKey;
  label: string;
  description: string;
  /** false = shown disabled, never sent (`pickup_counter` today). */
  available: boolean;
  /** Config modes the profile sets, by registry key, e.g. `{ fulfilment_model: "ship" }`. */
  modes: Record<string, string>;
  /** Feature keys the profile grants / denies. */
  grants: string[];
  denies: string[];
}

export interface BusinessProfileListResponse {
  profiles: BusinessProfileSummary[];
}

/** What applying a profile would do to ONE tenant, key by key. */
export interface BusinessProfilePlan {
  overrides: {
    featureKey: string;
    effect: "GRANT" | "DENY";
    /** create = new override; replace = revoke the opposite active one, then create; skip = already so. */
    action: "create" | "replace" | "skip";
  }[];
  modes: { key: string; from: string; to: string }[];
}

/** `POST /platform-admin/tenants/:id/business-profile/preview` body AND confirm body. */
export interface ApplyBusinessProfileRequest {
  profile: BusinessProfileKey;
  /** Confirm only; defaults to "Business profile applied". */
  reason?: string;
}

export interface BusinessProfilePreviewResponse extends FeaturePreviewResponse {
  profile: BusinessProfileKey;
  plan: BusinessProfilePlan;
}

export interface BusinessProfileApplyResponse {
  profile: BusinessProfileKey;
  plan: BusinessProfilePlan;
  /** Feature keys whose resolver verdict changed. */
  changed: string[];
}

/**
 * The server-computed capability answer. `fleet` = recurring_routes || order_delivery effective
 * (the modules are the ONLY truth; the mode never turns fleet on or off). `fulfilment` is the
 * effective mode, or `null` when UNSET. `consistent` is false when the mode is delivery|both and
 * `fleet` is false (e.g. a module was denied after the mode was set).
 */
export interface TenantCapability {
  fleet: boolean;
  fulfilment: FulfilmentMode | null;
  consistent: boolean;
  inconsistentModes: string[];
}
