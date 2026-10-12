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

// ─── Portal limits admin contract (state-restrictions-ux spec §5, Branch B) ──────────────────────
//
// Frozen for the web branch. Roles: TENANT_ADMIN and OPERATOR may create and lift (owner 10-07:
// operators are near-admins; TENANT_ADMIN satisfies OPERATOR in RolesGuard); CUSTOMER and DRIVER
// get 403 on every route below.
//
// POST /selling-restrictions/bulk            (TENANT_ADMIN, OPERATOR)
//   body BulkRestrictionRequest → 201 BulkRestrictionResponse. One transaction, one createMany,
//   one audit row; a product with an identical active rule is skipped, not duplicated.
//   400 when productIds has more than BULK_RESTRICTION_MAX_PRODUCTS ids, when both or neither of
//   productIds / categoryId are sent, or when the state rules of POST /selling-restrictions fail.
//
// POST /selling-restrictions/lift-batch      (TENANT_ADMIN, OPERATOR)
//   body LiftBatchRequest → 200 LiftBatchResponse. One transaction, each lift guarded on
//   liftedAt IS NULL, one audit row. 400 when ids has more than BULK_RESTRICTION_MAX_PRODUCTS ids;
//   409 when a rule is already lifted (a second call for the same ids), nothing overwritten.
//
// GET /selling-restrictions?productId=<id>&cursor=<cursor>   (OPERATOR, TENANT_ADMIN)
//   → 200 ProductLimitsResponse: the rules binding that product (its own, its parent's, its
//   categories'), for the product-page chips. Without productId the route keeps returning
//   SellingRestrictionListItemDto[].
//
// Customers whose governing state can't be resolved, and fixing them in place, are a separate
// contract: see ./selling-restrictions.ts (UnknownStateCustomersResponse, BulkStateRequest, ...).

/** Cap on ids per bulk create and per lift-batch; the same cap as the web's BULK_PORTAL_MAX. */
export const BULK_RESTRICTION_MAX_PRODUCTS = 200;

/**
 * Exactly one of productIds (1..BULK_RESTRICTION_MAX_PRODUCTS) / categoryId. Validation matches
 * CreateSellingRestrictionRequest: STATE needs a non-empty `states`; FEDERAL must not carry any.
 */
export interface BulkRestrictionRequest {
  productIds?: string[];
  categoryId?: string;
  /** STATE for portal limits. */
  jurisdiction: RestrictionJurisdictionValue;
  /** 2-letter USPS codes; required (non-empty) when jurisdiction is STATE. */
  states: string[];
  /** Server default "BUYER_PORTAL"; the web's "Legal ban" checkbox sends "ALL". */
  surface?: RestrictionSurfaceValue;
  /** Server default "Portal limit". */
  reason?: string;
  /** ISO 8601; defaults to now. */
  effectiveFrom?: string;
  /** ISO 8601, must be after effectiveFrom; omitted = open-ended. */
  effectiveTo?: string;
}

export interface BulkRestrictionResponse {
  created: number;
  skipped: number;
  /** Ids of the rules created; the web's Undo sends them to lift-batch. */
  createdIds: string[];
  /** Products skipped because an identical active rule already binds them. */
  skippedProductIds?: string[];
  auditId?: string;
}

export interface LiftBatchRequest {
  /** Rule ids, 1..BULK_RESTRICTION_MAX_PRODUCTS. */
  ids: string[];
  /** Server default "Limit lifted"; the web's Undo sends "Undone right after creating". */
  reason?: string;
}

export interface LiftBatchResponse {
  lifted: number;
  ids: string[];
}

/** How a rule reaches a product: its own rule, its parent product's, or a category it is labelled with. */
export const PRODUCT_LIMIT_VIA_VALUES = ["PRODUCT", "PARENT", "CATEGORY"] as const;
export type ProductLimitVia = (typeof PRODUCT_LIMIT_VIA_VALUES)[number];

/** One product-page chip row ("Not offered in TX · via Vapes"). */
export interface ProductLimitDto {
  id: string;
  jurisdiction: RestrictionJurisdictionValue;
  states: string[];
  surface: RestrictionSurfaceValue;
  reason: string;
  /** ISO 8601. */
  effectiveFrom: string;
  /** ISO 8601; null = open-ended. */
  effectiveTo: string | null;
  via: ProductLimitVia;
  /** The parent product's or category's display name; null when via is PRODUCT. */
  viaLabel: string | null;
  /** ISO 8601; null while the rule is in force. */
  liftedAt: string | null;
}

export interface ProductLimitsResponse {
  items: ProductLimitDto[];
  /** Pass back as `cursor` for the next page; null on the last page. */
  nextCursor: string | null;
}
