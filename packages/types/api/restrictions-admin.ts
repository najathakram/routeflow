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
  /** Row 509: what the rule covers now (active targets). Absent only from a pre-509 server. */
  targetSummary?: RuleTargetSummary;
  /** Row 509 (PR3): the rule's current revision; edits send it back as `expectedRevision`. */
  revision?: number;
}

/** Exactly one of categoryId / productId. STATE needs a non-empty `states`; FEDERAL must not carry any. */
export interface CreateSellingRestrictionRequest {
  /** Legacy single target (pre-509 clients). Send exactly one of these OR `targets`. */
  categoryId?: string;
  productId?: string;
  /** Row 509: the products and/or labels the rule covers (owner Q2: they may mix); 1..RULE_TARGETS_MAX_PER_REQUEST. */
  targets?: RuleTargetsInput;
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
  /** Row 509 (owner Q6): the ONE rule the products were put in (also `createdIds[0]`); absent when none was created. */
  ruleId?: string;
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
  /** Row 509: true when the product (not its parent / label) is itself a target, so "Remove from rule" applies. */
  directTarget?: boolean;
  /** Row 509: how many products and labels the rule covers (the chip says "· 12 products"). */
  targetSummary?: RuleTargetSummary;
}

export interface ProductLimitsResponse {
  items: ProductLimitDto[];
  /** Pass back as `cursor` for the next page; null on the last page. */
  nextCursor: string | null;
}

// ─── Row 509: rules that cover many products and labels (SA option A + owner rulings 2026-10-14) ──
//
// Roles: OPERATOR and TENANT_ADMIN, EXCEPT an all-customer rule (jurisdiction FEDERAL, owner L5): creating one,
// adding to / removing from one, editing one or editing a rule INTO one is TENANT_ADMIN-only (403).
//
// POST /selling-restrictions                       body CreateSellingRestrictionRequest (targets)  → 201 SellingRestrictionListItemDto
// GET  /selling-restrictions/:id?cursor=           → 200 RuleDetailDto (targets keyset-paged, RULE_TARGETS_PAGE_SIZE)
// POST /selling-restrictions/:id/targets           body AddRuleTargetsRequest    → 200 AddRuleTargetsResponse
// POST /selling-restrictions/:id/targets/remove    body RemoveRuleTargetsRequest → 200 RemoveRuleTargetsResponse
// POST /selling-restrictions/holding               body RulesHoldingRequest      → 200 RulesHoldingResponse (catalog "Remove from a rule…")
// GET  /products/ids?<the products list filters>   → 200 ProductIdsForFilterResponse (catalog "Select all N matching")
// POST /selling-restrictions/bulk                  (owner Q6) now creates ONE rule with all the products; `ruleId` names it.
// POST /selling-restrictions/:id/edit-preview      body RuleEditRequest       → 200 RuleEditPreviewResponse          (PR3)
// PUT  /selling-restrictions/:id                   body RuleEditCommitRequest → 200 SellingRestrictionListItemDto    (PR3)
//
// Coded errors (body.code, API_ERROR_CODES):
//   RULE_NOT_EDITABLE      409  the rule is lifted or expired.
//   RULE_TARGETS_NOT_FOUND 409  an id is unknown in this tenant (body.notFoundIds); nothing written.
//   RULE_NEEDS_A_TARGET    409  the call would remove the rule's last active target; lift the rule instead.
//   RULE_TARGET_LIMIT      400  over RULE_TARGETS_MAX_PER_REQUEST ids (body.field "request") or over
//                               RULE_TARGETS_MAX_PER_RULE active targets (body.field "rule", body.max).
//   RULE_STALE             409  `expectedRevision` is not the rule's current revision (PR3).
//   RULE_IMPACT_CHANGED    409  the impact behind `confirmImpactHash` changed since the preview (PR3); preview again.
//                               The hash covers the affected documents AND the proposed settings, so confirming a
//                               different edit than the one previewed is this error too.
//   RULE_END_USE_LIFT      400  an edit set `effectiveTo` to now or earlier; "To end this rule now, lift it." (PR3)
//   RULE_IMPACT_TOO_LARGE  409  a tightening edit reaches more open orders and drafts than the preview counts
//                               (body.max); narrow the change or add a new rule instead (PR3). Nothing is written.
// Already-present targets (add) and ids not in the rule (remove) are skipped and reported, never errors.

/** Ids per add / remove / create call, in ONE atomic transaction (owner Q5: select-all-matching up to 1,000). */
export const RULE_TARGETS_MAX_PER_REQUEST = 1000;
/** Active targets one rule may hold (SA condition 6: keeps the buyer hide seed bounded). */
export const RULE_TARGETS_MAX_PER_RULE = 5000;
/** Targets per page on the rule detail. */
export const RULE_TARGETS_PAGE_SIZE = 100;

export interface RuleTargetsInput {
  productIds?: string[];
  categoryIds?: string[];
}

export const RULE_TARGET_KIND_VALUES = ["PRODUCT", "CATEGORY"] as const;
export type RuleTargetKind = (typeof RULE_TARGET_KIND_VALUES)[number];

/** One active target on the rule detail. */
export interface RuleTargetDto {
  /** The target row id. */
  id: string;
  kind: RuleTargetKind;
  productId: string | null;
  categoryId: string | null;
  /** Display name: "<Family> - <Variant>" for a variant, the label name for a CATEGORY. */
  name: string;
  sku: string | null;
  /** A FAMILY target covers every current and future variant (owner Q1). */
  isFamily: boolean;
  /** How many variants a FAMILY / parent target covers today; null otherwise. */
  variantCount: number | null;
  /** ISO 8601. */
  addedAt: string;
  addedByName: string | null;
}

/** The list card / product chip summary of a rule's active targets. */
export interface RuleTargetSummary {
  products: number;
  categories: number;
  /** The first three targets by name, for "Vapes, Sample Pod, +10 more". */
  preview: Array<{ kind: RuleTargetKind; id: string; name: string }>;
}

/** One revision of a rule's settings (PR3; revision 1 = as created). Append-only. */
export interface RuleRevisionDto {
  revision: number;
  jurisdiction: RestrictionJurisdictionValue;
  states: string[];
  surface: RestrictionSurfaceValue;
  /** ISO 8601. */
  effectiveFrom: string;
  /** ISO 8601; null = open-ended. */
  effectiveTo: string | null;
  reason: string;
  editedByName: string | null;
  /** ISO 8601. */
  editedAt: string;
  note: string | null;
}

/** One target add / remove event, for the rule's history feed. */
export interface RuleTargetEventDto {
  kind: "ADDED" | "REMOVED";
  count: number;
  byName: string | null;
  /** ISO 8601. */
  at: string;
  reason: string | null;
}

export interface RuleDetailDto extends SellingRestrictionListItemDto {
  targets: RuleTargetDto[];
  /** Pass back as `cursor` for the next page of targets; null on the last page. */
  nextCursor: string | null;
  /** Newest first. Empty from a server without PR3. */
  revisions: RuleRevisionDto[];
  /** Newest first, at most 50. */
  targetEvents: RuleTargetEventDto[];
}

export type AddRuleTargetsRequest = RuleTargetsInput;

export interface AddRuleTargetsResponse {
  added: number;
  /** Ids already in the rule (skipped). */
  skippedIds: string[];
  /** The new target row ids (the web's Undo sends their product / category ids to remove). */
  addedTargetIds: string[];
  /** Active targets after the call. */
  activeTargets: number;
}

export interface RemoveRuleTargetsRequest extends RuleTargetsInput {
  /** Server default "Removed from rule"; trimmed, at most 500. */
  reason?: string;
}

export interface RemoveRuleTargetsResponse {
  removed: number;
  /** Ids that were not active targets of the rule (skipped). */
  notInRule: string[];
  activeTargets: number;
}

export interface RulesHoldingRequest {
  /** 1..RULE_TARGETS_MAX_PER_REQUEST product ids. */
  productIds: string[];
}

/** The ACTIVE / SCHEDULED rules that hold at least one of the products as a DIRECT target. */
export interface RulesHoldingResponse {
  items: Array<{ rule: SellingRestrictionListItemDto; holds: number }>;
}

export interface ProductIdsForFilterResponse {
  ids: string[];
  /** Every match, even past the cap. */
  total: number;
  /** True when total > RULE_TARGETS_MAX_PER_REQUEST and only the first ids came back. */
  capped: boolean;
}

// ─── Row 509 PR3: edit in place, with history (owner Q4; SA re-rule 2026-10-14) ──────────────────

/** The full new settings; validation is exactly create's. */
export interface RuleEditRequest {
  jurisdiction: RestrictionJurisdictionValue;
  states?: string[];
  surface: RestrictionSurfaceValue;
  /** ISO 8601. */
  effectiveFrom?: string;
  /** ISO 8601; null = open-ended. */
  effectiveTo?: string | null;
  reason: string;
  /** Optional note on the revision; at most 500. */
  note?: string;
}

export const RULE_CHANGE_DIRECTION_VALUES = ["TIGHTENS", "LOOSENS", "NEUTRAL"] as const;
export type RuleChangeDirection = (typeof RULE_CHANGE_DIRECTION_VALUES)[number];

export const RULE_CHANGE_FIELD_VALUES = [
  "states",
  "jurisdiction",
  "surface",
  "window",
  "reason",
] as const;
export type RuleChangeField = (typeof RULE_CHANGE_FIELD_VALUES)[number];

export interface RuleEditPreviewResponse {
  changes: Array<{ field: RuleChangeField; direction: RuleChangeDirection }>;
  /** OPEN orders and drafts on the affected channels whose lines newly fall under the rule. */
  impact: { openOrders: number; drafts: number };
  /** Send back as `confirmImpactHash`; a different impact at commit is 409 RULE_IMPACT_CHANGED. */
  impactHash: string;
  /** The revision this preview was computed against. */
  revision: number;
}

export interface RuleEditCommitRequest extends RuleEditRequest {
  expectedRevision: number;
  confirmImpactHash: string;
}

/** The ONE copy for the edit impact line (row 510 changes this text in one place). */
export function ruleEditImpactCopy(count: number): string {
  const n = `${count} open order${count === 1 ? "" : "s"}`;
  return `${n} ${count === 1 ? "has" : "have"} products this change now restricts. They'll be checked when they're next edited, promoted or invoiced.`;
}
