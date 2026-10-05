import type { FeaturePreviewResponse } from "./features";

// ─── Business profiles — the shared contract ────────────────────────────────────────────────
//
// A profile is a named starting bundle a PLATFORM ADMIN applies to one tenant: grants/denies on
// the existing fleet modules (recurring_routes, order_delivery, driver_payments — no new plan
// flags) plus config modes (`fulfilment_model`, and `counter_sales` for the in-store profiles).
// The registry data lives in apps/api/src/billing/business-profiles.ts. Applying one goes through
// the existing feature-override + feature-config write paths (each audited), after a dry-run
// preview. A tenant nobody applied a profile to is untouched: its `capabilities.fulfilment`
// (packages/types/api/fulfilment.ts) stays the one answer every client reads.

export const BUSINESS_PROFILE_KEYS = [
  "delivery_distributor",
  "shipping_wholesaler",
  "in_store_retailer",
  "in_store_shipping_retailer",
] as const;
export type BusinessProfileKey = (typeof BUSINESS_PROFILE_KEYS)[number];

/** `GET /platform-admin/business-profiles` element (registry order). */
export interface BusinessProfileSummary {
  key: BusinessProfileKey;
  label: string;
  description: string;
  /** false = shown disabled and never sent. Every profile is available today. */
  available: boolean;
  /** Config modes the profile sets, by registry key, e.g. `{ fulfilment_model: "ship" }`. */
  modes: Record<string, string>;
  /** Module keys the profile turns on / off. */
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
  /** Only the modes that change (`from` is the tenant's stored value). */
  modes: { key: string; from: string; to: string }[];
  /**
   * Owner ruling (money): a module the profile switches OFF that the tenant currently PAYS for
   * (an add-on row with a Stripe item or a price) is switched off by disabling the add-on through
   * the existing disable, which stops its billing. Runs FIRST at confirm, in reverse dependency
   * order (driver_payments → order_delivery → recurring_routes), before any mode/config write;
   * `[]` for comps.
   */
  billing: {
    featureKey: string;
    action: "disable";
    /**
     * true = the tenant pays MANUALLY (a price, no Stripe item): the disable switches the module
     * off and removes it from RouteFlow's ledger, but their manual invoice must be updated by hand.
     */
    manual: boolean;
  }[];
}

/** `POST /platform-admin/tenants/:id/business-profile/preview` body AND the confirm body. */
export interface ApplyBusinessProfileRequest {
  profile: BusinessProfileKey;
  /** Confirm only; the audit rows default to "Business profile: <label>". */
  reason?: string;
}

export interface BusinessProfilePreviewResponse extends FeaturePreviewResponse {
  profile: BusinessProfileKey;
  plan: BusinessProfilePlan;
  /** The plan in plain English, one line per change; `[]` = the tenant already matches. */
  summary: string[];
}

/** `POST /platform-admin/tenants/:id/business-profile` (confirm). Re-applying is idempotent. */
export interface BusinessProfileApplyResponse {
  profile: BusinessProfileKey;
  plan: BusinessProfilePlan;
  /** Feature keys whose resolver verdict changed. */
  changed: string[];
  summary: string[];
}
