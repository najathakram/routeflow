import type { API_ERROR_CODES } from "./error-codes";
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
  "delivery_pos",
  // BO-04: the two combinations the original five could not name (Delivery + Shipping, and all three).
  "delivery_shipping",
  "delivery_shipping_pos",
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
  /** The capability ticks this preset pre-ticks (BO-03): the same tuple `matchedPreset` compares against.
   *  Optional so older clients and fixtures keep compiling (additive); the server always sends it. */
  ticks?: BusinessCapabilityTicks;
}

/**
 * The tuple a preset is matched on (BO-03): what a tenant "does". `doorPayments` is the `driver_payments`
 * module; `opensAs` is where new staff orders open.
 */
export interface BusinessCapabilityTicks {
  delivery: boolean;
  doorPayments: boolean;
  shipping: boolean;
  counter: boolean;
  opensAs: "order" | "counter";
}

/**
 * `GET /platform-admin/tenants/:id/business-capabilities` (BO-03): the checkboxes, read back from the server.
 * `configured: false` (a legacy `unset` tenant) means every tick is false: nothing is shown ticked until confirmed.
 */
export interface BusinessCapabilities extends BusinessCapabilityTicks {
  configured: boolean;
  /** Shipping + Counter without Delivery is the only combination where staff may pick Order or Counter. */
  opensAsChoosable: boolean;
  /** The counter capability: always (in-store mode), optional (`counter_sales` on), or off. */
  counterCapability: "always" | "optional" | "off";
  /** Either fleet module (routes, order delivery) is held. */
  fleetHeld: boolean;
  /** The preset whose ticks match exactly, else null (also null when not configured). */
  matchedPreset: BusinessProfileKey | null;
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

/**
 * One add-on's outcome in a `BUSINESS_PROFILE_BILLING_FAILED` (503) body: every add-on the apply reached (the ones
 * already switched off, plus the one whose switch-off failed). Web and API share this one shape (ROW c).
 */
export interface BusinessProfileBillingFailedAddon {
  /** The add-on module key. Clients map it to a label and never print it raw. */
  key: string;
  /** true = the row is a COMP: nothing is billed, so there is no billing to stop. */
  wasComp: boolean;
  /** true = a PAID row whose billing was stopped. Always false for a comp and for a row that is still on. */
  billingStopped: boolean;
  /** true = the add-on is now off. false = the switch-off failed and it is still on. */
  switchedOff: boolean;
}

/**
 * The 503 body. `addons` is failed-first, then the switched-off ones in the billing disable order. The other fields
 * are the older contract (kept so an older web build still renders).
 */
export interface BusinessProfileBillingFailedBody {
  statusCode: 503;
  code: typeof API_ERROR_CODES.BUSINESS_PROFILE_BILLING_FAILED;
  featureKey: string;
  alreadyDisabled: string[];
  failedStep: { step: "billing" | "grant" | "mode" | "deny" | "audit"; key: string };
  addons: BusinessProfileBillingFailedAddon[];
  message: string;
}

// ─── Capability ticks → preview / apply (BO-04) ─────────────────────────────────────────────
//
// A platform admin ticks what a business does (Delivery, Shipping, Counter) and the server maps the ticks to the ONE
// planner the five presets already use (`ticksToProfileDef` in apps/api/src/billing/business-capabilities.ts). The
// preset endpoints (`business-profile`, `business-profile/preview`) stay as thin aliases onto the same path.

/** The ticks an admin sends. Every field is optional: nothing ticked is a 400 `BUSINESS_CAPABILITIES_EMPTY`. */
export interface BusinessCapabilitiesRequest {
  delivery?: boolean;
  /** Collect payment at the door. Default true with Delivery; ignored (false) without it. */
  doorPayments?: boolean;
  shipping?: boolean;
  counter?: boolean;
  /** Where new staff orders open. Honoured only for Shipping + Counter without Delivery (D6 default: "counter"). */
  opensAs?: "order" | "counter";
  /** Confirm only; the audit rows default to "Business profile: <label>". */
  reason?: string;
}

/** `POST /platform-admin/tenants/:id/business-capabilities` (confirm): the preview's `planFingerprint` is required. */
export interface ConfirmBusinessCapabilitiesRequest extends BusinessCapabilitiesRequest {
  planFingerprint: string;
}

/**
 * Why a plan cannot be confirmed right now (the preview still returns the plan; Confirm is disabled):
 * - `FULFILMENT_CARRIER_IN_TRANSIT`: carrier orders are shipped and not delivered, and the change moves the billing moment.
 * - `FEATURE_REQUIRES_UNMET`: a module the plan would comp is refused by the comp path's own `requires` check
 *   (the same refusal `AddonService.enableAddon` gives), so applying would stop in the middle.
 */
export interface BusinessPlanBlockedInTransit {
  code: typeof API_ERROR_CODES.FULFILMENT_CARRIER_IN_TRANSIT;
  count: number;
}
export interface BusinessPlanBlockedRequires {
  code: typeof API_ERROR_CODES.FEATURE_REQUIRES_UNMET;
  /** The module whose comp would be refused. */
  key: string;
  /** What it needs, in words (registry labels), e.g. "Recurring routes or Ad hoc order delivery". */
  missing: string;
}
export type BusinessPlanBlocked = BusinessPlanBlockedInTransit | BusinessPlanBlockedRequires;

/** `POST /platform-admin/tenants/:id/business-capabilities/preview`. Writes nothing. */
export interface BusinessCapabilitiesPreviewResponse extends FeaturePreviewResponse {
  /** The normalised ticks the server planned (what the audit row will record). */
  capabilities: BusinessCapabilityTicks;
  /** The preset whose ticks equal `capabilities`, else null (a "custom" combination). */
  preset: BusinessProfileKey | null;
  plan: BusinessProfilePlan;
  summary: string[];
  changes: string[];
  planFingerprint: string;
  /** Non-null = Confirm must be disabled; confirming would be refused with this code before any write. */
  blocked: BusinessPlanBlocked | null;
}

/** `POST /platform-admin/tenants/:id/business-capabilities` (confirm). Re-applying is idempotent. */
export interface BusinessCapabilitiesApplyResponse {
  capabilities: BusinessCapabilityTicks;
  preset: BusinessProfileKey | null;
  plan: BusinessProfilePlan;
  changed: string[];
  summary: string[];
}
