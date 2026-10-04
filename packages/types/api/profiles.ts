import type { FeaturePreviewResponse } from "./features";

/**
 * Business profiles: a named bundle of feature grants/denies + modes a platform admin applies to a tenant
 * (and can choose at tenant creation). Contract owned by the API lane (U-units); the web consumes it.
 */
export type BusinessProfileKey = "delivery_distributor" | "shipping_wholesaler" | "pickup_counter";

export interface BusinessProfileSummary {
  key: BusinessProfileKey;
  label: string;
  description: string;
  /** false = shown disabled and NEVER sent (the API refuses it with BUSINESS_PROFILE_UNAVAILABLE). */
  available: boolean;
  /** e.g. { fulfilment_model: "ship" } */
  modes: Record<string, string>;
  /** Feature keys the profile turns on / off. */
  grants: string[];
  denies: string[];
}

export interface BusinessProfilePlan {
  overrides: {
    featureKey: string;
    effect: "GRANT" | "DENY";
    action: "create" | "replace" | "skip";
  }[];
  modes: { key: string; from: string; to: string }[];
}

export interface BusinessProfilePreviewResponse extends FeaturePreviewResponse {
  profile: BusinessProfileKey;
  plan: BusinessProfilePlan;
}

export interface BusinessProfileApplyResponse {
  profile: BusinessProfileKey;
  plan: BusinessProfilePlan;
  changed: string[];
}

/** What the tenant can actually do, from the MODULES (a fulfilment mode never turns fleet on). */
export interface TenantCapability {
  fleet: boolean;
  /** null = unset (today's behaviour) */
  fulfilment: string | null;
  /** false when the mode is delivery|both but no fleet module is effective. */
  consistent: boolean;
  /** e.g. ["fulfilment_model"] */
  inconsistentModes: string[];
}
