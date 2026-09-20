// Selling-restriction RULES admin contract (Lane R step 5a). Wire shapes for
// GET/POST /selling-restrictions and POST /selling-restrictions/:id/lift.
import type { RestrictionJurisdictionValue, RestrictionSurfaceValue } from "./enums";
import type { SellingRestrictionDto } from "./restrictions";

/** Where a rule is in its life, computed server-side at read time from the engine's own window rule. */
export const RESTRICTION_STATUS_VALUES = ["ACTIVE", "SCHEDULED", "EXPIRED", "LIFTED"] as const;
export type RestrictionStatus = (typeof RESTRICTION_STATUS_VALUES)[number];

export interface SellingRestrictionListItemDto extends SellingRestrictionDto {
  status: RestrictionStatus;
  /** Names of the targeted category / product, for display (the other is null). */
  categoryName: string | null;
  productName: string | null;
}

/** Exactly one of categoryId / productId. STATE needs a non-empty `states`; FEDERAL must not carry any. */
export interface CreateSellingRestrictionRequest {
  categoryId?: string;
  productId?: string;
  jurisdiction: RestrictionJurisdictionValue;
  /** USPS codes or full names; stored as 2-letter USPS codes, de-duplicated. */
  states?: string[];
  surface?: RestrictionSurfaceValue;
  /** ISO 8601; defaults to now. */
  effectiveFrom?: string;
  /** ISO 8601, must be after effectiveFrom; omitted = open-ended. */
  effectiveTo?: string;
  reason: string;
}

export interface LiftSellingRestrictionRequest {
  reason: string;
}
