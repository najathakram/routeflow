// Selling restrictions (2026-09-19). See
// local-assets/handoff/2026-09-18/PLAN-categories-jurisdiction-bans.md §1-3 and
// MASTER-EXECUTION-PLAN.md §6 contracts 7-8.

import type { RestrictionAddressPrecedence } from "./enums";

/**
 * Tenant policy. `addressPrecedence` = which customer address TYPE governs a STATE rule first
 * (owner ruling D4: the customer's DEFAULT address; see `RESTRICTION_ADDRESS_PRECEDENCE_VALUES`).
 * A licensed-premises address source (`CustomerAuthorization.premisesState`) is deliberately
 * deferred — owner: "no licensed-premises field now"; reintroduce it as a third source when ruled in.
 */
export interface RestrictionsPolicy {
  enabled: boolean;
  addressPrecedence: RestrictionAddressPrecedence;
}

/** OFF = feature disabled · ALLOW = enabled, nothing blocks · BLOCK · INDETERMINATE = enabled but the state can't be resolved (fail closed). */
export type RestrictionOutcome = "OFF" | "ALLOW" | "BLOCK" | "INDETERMINATE";

/** BUYER_PORTAL = self-serve; STAFF = every other path (staff UI, cron, system). */
export type RestrictionChannel = "BUYER_PORTAL" | "STAFF";

export interface RestrictionsEvaluation {
  outcome: RestrictionOutcome;
  /**
   * One entry per blocked / indeterminate PRODUCT (duplicate lines of one product collapse to a
   * single entry); empty for OFF and ALLOW.
   */
  reasons: BlockedLine[];
}

/** Why a line was blocked — mirrors the engine's three-state result (plan §2.6). */
export type RestrictionReason =
  "FEDERAL_BAN" | "STATE_BAN" | "BUYER_PORTAL_ONLY" | "INDETERMINATE_ADDRESS" | "UNKNOWN_PRODUCT";

export interface BlockedLine {
  productId: string;
  productName: string;
  categoryName?: string;
  /** Null only for UNKNOWN_PRODUCT (no rule was matched — the product couldn't be resolved). */
  ruleId: string | null;
  reason: RestrictionReason;
  state?: string;
  message: string;
}

/** Thrown as a 409 by `assertSellable` — mirrors `REGULATED_AUTH_REQUIRED`'s shape. */
export interface SellingRestrictedError {
  code: "SELLING_RESTRICTED";
  blockedLines: BlockedLine[];
}

export type RestrictionJurisdiction = "FEDERAL" | "STATE";
export type RestrictionSurface = "ALL" | "BUYER_PORTAL";

export interface SellingRestrictionDto {
  id: string;
  tenantId: string;
  categoryId: string | null;
  productId: string | null;
  jurisdiction: RestrictionJurisdiction;
  states: string[];
  surface: RestrictionSurface;
  effectiveFrom: string;
  effectiveTo: string | null;
  reason: string;
  createdById: string | null;
  createdByName: string | null;
  createdAt: string;
  liftedById: string | null;
  liftedByName: string | null;
  liftedAt: string | null;
  liftReason: string | null;
}

/** Product-list "Restricted (TX, FL)" / "Restricted (federal)" chip. */
export type RestrictedProductChip =
  { kind: "federal" } | { kind: "state"; states: string[] } | null;
