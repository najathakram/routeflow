// Selling restrictions (2026-09-19). See
// local-assets/handoff/2026-09-18/PLAN-categories-jurisdiction-bans.md §1-3 and
// MASTER-EXECUTION-PLAN.md §6 contracts 7-8.

import type { RestrictionAddressPrecedence } from "./enums";
import type { API_ERROR_CODES } from "./error-codes";

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

/** BUYER_PORTAL = the self-serve buyer (principal `type: "BUYER"` or the CUSTOMER role, and any caller not positively staff); STAFF = a staff principal or an explicit system caller. */
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
  | "FEDERAL_BAN"
  | "STATE_BAN"
  | "BUYER_PORTAL_ONLY"
  | "INDETERMINATE_ADDRESS"
  | "UNKNOWN_PRODUCT"
  | "HIDDEN_FROM_PORTAL";

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

/** Thrown as a 409 by `assertLinesSellable` — mirrors `REGULATED_AUTH_REQUIRED`'s shape. */
export interface SellingRestrictedError {
  code: typeof API_ERROR_CODES.SELLING_RESTRICTED;
  /** One human sentence (a client with no blocked-lines panel toasts it); the detail is `blockedLines`. */
  message: string;
  blockedLines: BlockedLine[];
}

/**
 * What a BUYER-channel caller gets in `blockedLines` (B612): the product only — no rule id, reason,
 * state, category or rule text. Staff still get the full {@link BlockedLine}.
 */
export type BuyerBlockedLine = Pick<BlockedLine, "productId" | "productName"> & {
  /** Present ONLY for a product the tenant hid from the buyer portal (SA-606 WS6); never a ban/state reason. */
  reason?: "HIDDEN_FROM_PORTAL";
};

/** The 409 body for a BUYER-channel caller: the same code, a generic sentence, names only. */
export interface BuyerSellingRestrictedError {
  code: typeof API_ERROR_CODES.SELLING_RESTRICTED;
  message: string;
  blockedLines: BuyerBlockedLine[];
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

// ─── Row 510: staff restriction warnings with override ──────────────────────────────────────────
// A staff write that would sell a restricted product gets a 409 RESTRICTION_WARNING (not a hard
// SELLING_RESTRICTED) when the principal may override (`staffMay(role, "OVERRIDE_SELLING_RESTRICTION")`).
// The client shows `lines`, collects ONE reason, and resubmits the SAME payload plus a RestrictionAck.
// The server is the only computer of `warningHash`; clients echo it opaquely (L-303: no shared runtime logic).
// The API keeps literal mirrors of the constants below in selling-restrictions/override-constants.ts.

/** One rule behind a warned line. `legal` = the rule binds every channel (surface ALL). */
export interface RestrictionWarningRule {
  id: string;
  states: string[];
  legal: boolean;
  /** Fixed server copy ("This product is banned in CA by law."); display only, never hashed. */
  reasonText: string;
}

/** One warned line. `lineKey` = "n:<index>" | "l:<lineId>" | "cr:<changeRequestId>" (stable for the same payload). */
export interface RestrictionWarningLine {
  lineKey: string;
  productId: string;
  displayName: string;
  outcome: "BLOCK" | "INDETERMINATE";
  rules: RestrictionWarningRule[];
}

/** The 409 body a staff write gets when an override is possible. */
export interface RestrictionWarningError {
  code: typeof API_ERROR_CODES.RESTRICTION_WARNING;
  message: string;
  lines: RestrictionWarningLine[];
  warningHash: string;
}

/** One acknowledged line: the same reason is sent for every warned lineKey. */
export interface RestrictionOverrideInput {
  lineKey: string;
  reason: string;
}

/** The top-level fields a staff write body may carry on resubmit after a RESTRICTION_WARNING. */
export interface RestrictionAck {
  restrictionOverrides?: RestrictionOverrideInput[];
  warningHash?: string;
}

/** The stamp a STAFF read of an order / invoice line carries (never on a buyer read, a PDF or a receipt). */
export interface OverrideStampView {
  restrictionOverrideReason: string | null;
  /** The overriding User id (staff reads resolve the name). */
  restrictionOverrideBy: string | null;
  restrictionOverrideAt: string | null;
  restrictionOverrideRuleIds: string[];
  /** The overriding user's name, resolved on a STAFF read (null when the user is gone); never on a buyer read. */
  restrictionOverrideByName?: string | null;
}

/** API-internal: one breached product as the engine judged it for a staff write (mirrored for the contract). */
export interface StaffBreach {
  productId: string;
  outcome: "BLOCK" | "INDETERMINATE";
  ruleIds: string[];
}

/** Reason length bounds, applied after trim (400 RESTRICTION_OVERRIDE_REASON_INVALID outside them). */
export const RESTRICTION_OVERRIDE_REASON_MIN = 3;
export const RESTRICTION_OVERRIDE_REASON_MAX = 200;

/** The `message` of the 409 SELLING_RESTRICTED a DRIVER (who may not override) gets on a staff write. */
export const DRIVER_RESTRICTION_BLOCK_MESSAGE = "Ask the office to approve this sale";

/** The staff-only line note label. */
export const RESTRICTION_OVERRIDE_LABEL = "Sold despite restriction";

/**
 * Ruling #2093 (2026-10-13): a historical invoice import is exempt, never refused. Its breached lines are stamped with
 * this fixed reason, the importing user and the rules matched at import, plus an audit row (no new column).
 */
export const RESTRICTION_OVERRIDE_IMPORTED_REASON = "Imported (historical)";
