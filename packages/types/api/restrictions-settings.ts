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
}

export interface UpdateRestrictionsSettingsRequest {
  /** Turning ON is refused with 409 `SELLING_RESTRICTIONS_NOT_READY` (+ readiness) until the data is ready. */
  enabled?: boolean;
  governingAddress?: RestrictionAddressPrecedence;
}
