// Selling restrictions (2026-09-19). See
// local-assets/handoff/2026-09-18/PLAN-categories-jurisdiction-bans.md §1-3 and
// MASTER-EXECUTION-PLAN.md §6 contracts 7-8.

/**
 * Ordered precedence over which customer address governs a STATE restriction
 * check (owner ruling R1 — tenant-configurable, not a hardcoded assumption).
 */
export type GoverningAddressSource = "DELIVERY" | "BILLING" | "DEFAULT" | "LICENSED_PREMISES";

export interface RestrictionsPolicy {
  enabled: boolean;
  governingAddress: GoverningAddressSource[];
}

/** Why a line was blocked — mirrors the engine's three-state result (plan §2.6). */
export type RestrictionReason =
  "FEDERAL_BAN" | "STATE_BAN" | "BUYER_PORTAL_ONLY" | "INDETERMINATE_ADDRESS";

export interface BlockedLine {
  productId: string;
  productName: string;
  categoryName?: string;
  ruleId: string;
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
