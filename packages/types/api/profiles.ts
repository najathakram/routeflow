import type { FeaturePreviewResponse } from "./features";

// ─── Business profiles — the shared contract ────────────────────────────────────────────────
//
// A profile is a named starting bundle a PLATFORM ADMIN applies to one tenant: grants/denies on
// the existing fleet modules (recurring_routes, order_delivery, driver_payments — no new plan
// flags) plus config modes (`fulfilment_model`, and `counter_sales` for the in-store profiles).
// The registry data lives in apps/api/src/billing/business-profiles.ts. Applying one goes through
// the existing add-on comp (SA-769: a grant of an add-on module is a COMP row), feature-override
// and feature-config write paths (each audited), after a dry-run preview. A tenant nobody applied a profile to is untouched: its `capabilities.fulfilment`
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
    /**
     * create = new override; replace = revoke the opposite active one, then create; skip = already so;
     * revoke (SA-769) = revoke the opposite active override only - the grant itself is a comp row (see `comps`)
     * or the tenant already holds the module through an add-on row.
     */
    action: "create" | "replace" | "revoke" | "skip";
  }[];
  /**
   * SA-769 (D-S2): the add-on modules the profile grants the tenant does NOT already hold, as COMP rows
   * (`TenantAddon.isComp`, SA-693): never billed, never booked, never blocking a checkout, no expiry. In module
   * order (fleet keys first, `driver_payments` last). A module the tenant already holds - a paid row, an existing
   * comp, a GRANT override - is never listed: applying a profile never re-prices what exists. `[]` for fleet-off
   * profiles. The preview says "Included free with this profile" for each.
   */
  comps: { featureKey: string }[];
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
    /**
     * SA-769: true = the row being switched off is a COMP (nothing is billed, so there is no billing to stop and no
     * manual invoice to fix). It still runs here, in the same reverse dependency order, through the same add-on disable.
     */
    comp?: boolean;
  }[];
}

/** `POST /platform-admin/tenants/:id/business-profile/preview` body (the confirm body adds the fingerprint). */
export interface ApplyBusinessProfileRequest {
  profile: BusinessProfileKey;
  /** Confirm only; the audit rows default to "Business profile: <label>". */
  reason?: string;
}

/** `POST /platform-admin/tenants/:id/business-profile` (confirm): the preview's `planFingerprint` is
 *  required, so the server applies only the plan the admin was shown (else 409 PROFILE_PLAN_CHANGED). */
export interface ConfirmBusinessProfileRequest extends ApplyBusinessProfileRequest {
  planFingerprint: string;
}

export interface BusinessProfilePreviewResponse extends FeaturePreviewResponse {
  profile: BusinessProfileKey;
  plan: BusinessProfilePlan;
  /** The plan in plain English, one line per change; `[]` = the tenant already matches. */
  summary: string[];
  /** `summary` without the billing and comp lines (those are `plan.billing` / `plan.comps`): what else changes, in order. */
  changes: string[];
  /** A stable hash of `plan`. Confirm sends it back; a different plan at confirm time is a 409
   *  `PROFILE_PLAN_CHANGED` (the admin re-previews), never an unseen change applied. */
  planFingerprint: string;
}

/** `POST /platform-admin/tenants/:id/business-profile` (confirm). Re-applying is idempotent. */
export interface BusinessProfileApplyResponse {
  profile: BusinessProfileKey;
  plan: BusinessProfilePlan;
  /** Feature keys whose resolver verdict changed. */
  changed: string[];
  summary: string[];
}
