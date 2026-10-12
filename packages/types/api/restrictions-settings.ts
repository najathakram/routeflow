// Selling-restrictions tenant settings contract (Lane R step 6a): GET/PATCH /settings/restrictions,
// GET /settings/restrictions/readiness (TENANT_ADMIN, throttled per tenant).
import type { RestrictionAddressPrecedence } from "./enums";

export interface RestrictionsSettingsDto {
  /** Absent/OFF is the default; nothing is enforced until a TENANT_ADMIN switches it on. */
  enabled: boolean;
  /** Which of the customer's DEFAULT addresses governs a STATE rule first. */
  governingAddress: RestrictionAddressPrecedence;
}

/** What switching the feature ON would meet in this tenant's customer data (engine's own probe). */
export interface RestrictionsEnableReadiness {
  ready: boolean;
  truncated: boolean;
  customerCount: number;
  customersWithoutAddress: number;
  customersAmbiguousNoDefault: number;
  addressesMissingStateCode: number;
  addressesNeedingReview: number;
  indeterminateCustomerCount: number;
  /**
   * The tenant has no usable business-address state (Settings > Business). A counter sale to the walk-in is judged by
   * it, so without one the tenant is NOT ready (`RESTRICTIONS_BUSINESS_STATE_MISSING_LINE` says what to do).
   */
  businessStateMissing: boolean;
}

/** The actionable line shown when `businessStateMissing` (one string for the API contract and the settings banner). */
export const RESTRICTIONS_BUSINESS_STATE_MISSING_LINE =
  "Add your business address in Settings \u203a Business so counter sales can check state rules.";

export interface UpdateRestrictionsSettingsRequest {
  /** Turning ON is refused with 409 `SELLING_RESTRICTIONS_NOT_READY` (+ readiness) until the data is ready. */
  enabled?: boolean;
  governingAddress?: RestrictionAddressPrecedence;
}
