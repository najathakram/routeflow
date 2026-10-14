// Selling-restrictions tenant settings contract (Lane R step 6a): GET/PATCH /settings/restrictions.
// Row 510: the on/off switch (`enabled`) and the readiness sweep route are gone; staff sales are always judged.
import type { RestrictionAddressPrecedence } from "./enums";

export interface RestrictionsSettingsDto {
  /** Which of the customer's DEFAULT addresses governs a STATE rule first. */
  governingAddress: RestrictionAddressPrecedence;
}

/** The actionable line shown when `businessStateMissing` (one string for the API contract and the settings banner). */
export const RESTRICTIONS_BUSINESS_STATE_MISSING_LINE =
  "Add your business address in Settings \u203a Business so counter sales can check state rules.";

export interface UpdateRestrictionsSettingsRequest {
  governingAddress?: RestrictionAddressPrecedence;
}
