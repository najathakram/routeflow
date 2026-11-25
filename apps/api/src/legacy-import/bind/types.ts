/** An RF customer row passed IN by the caller; this module never reads a database. */
export interface RfCustomerRow {
  id: string;
  name: string;
}

/** An existing binding passed IN. `sourceCustomerKey` is the full "Parent:Job" name. */
export interface CustomerBindingRow {
  sourceCustomerKey: string;
  customerId: string;
  /** True only once a person has confirmed it (the confirmation stamp). */
  confirmed: boolean;
}

export type CustomerMatchBasis = "EXACT" | "NEAR";

export interface CustomerCandidate {
  customerId: string;
  name: string;
  /** 0..1, higher is nearer. A candidate never binds anything. */
  score: number;
  basis: CustomerMatchBasis;
}

export const BIND_ROW_ERROR_CODES = ["BLANK_CUSTOMER"] as const;
export type BindRowErrorCode = (typeof BIND_ROW_ERROR_CODES)[number];

export interface BindRowError {
  code: BindRowErrorCode;
  message: string;
}

export interface ParsedCustomerName {
  /** The full trimmed source name, "Parent:Job" kept whole. Empty when blank. */
  sourceKey: string;
  parent: string;
  /** The job name after the first colon, kept as written; null when there is none. */
  job: string | null;
}

/**
 * HELD: blank customer, row error, nothing else is offered.
 * BOUND: an existing CONFIRMED binding on the full source key.
 * CANDIDATE_EXACT: one RF customer has exactly this (parent) name; a person still confirms.
 * SUGGESTED: near names only, to be confirmed one by one.
 * UNBOUND: nothing near. Never a default create.
 */
export type CustomerBindStatus = "HELD" | "BOUND" | "CANDIDATE_EXACT" | "SUGGESTED" | "UNBOUND";

export interface CustomerBindResult {
  status: CustomerBindStatus;
  sourceKey: string;
  parent: string;
  job: string | null;
  /** Set only when status is BOUND. */
  boundCustomerId: string | null;
  /** True only when status is BOUND: the one state a posting may use. */
  canPost: boolean;
  candidates: CustomerCandidate[];
  rowError: BindRowError | null;
}
