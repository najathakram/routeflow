// Fix customer data in place (state-restrictions-ux spec, Addendum D, Branch B). Wire shapes for
// the "Customers without a state on file" card on the Selling restrictions page. Frozen for the
// web branch: names and shapes below are the contract.
//
// Roles (every route): TENANT_ADMIN and OPERATOR may read and write (owner 10-07: operators are
// near-admins; TENANT_ADMIN satisfies OPERATOR in RolesGuard). CUSTOMER and DRIVER get 403. A
// read-only workspace refuses every write below with its shared read-only error. Every query and
// write is tenant-scoped: an id from another tenant is a 404, never a cross-tenant read or write.
// Every write is audited (one audit row per request, including the bulk and the undo).
//
// GET /settings/restrictions/unknown-state-customers?bucket=&cursor=&limit=
//   query UnknownStateCustomersQuery → 200 UnknownStateCustomersResponse. Customers whose governing
//   state cannot be resolved (walk-in excluded), split into four buckets, sorted by name.
//   Without `bucket` all four buckets come back, first page each. With `bucket` only that bucket
//   is paged from `cursor`; the others are returned as empty buckets with their real totals
//   (rows: [], nextCursor: null, total: <real count>). `limit` defaults to
//   UNKNOWN_STATE_PAGE_DEFAULT and is capped at UNKNOWN_STATE_PAGE_MAX. 400 on a bad bucket,
//   cursor or limit.
//
// POST /settings/restrictions/unknown-state-customers/bulk-state   (TENANT_ADMIN, OPERATOR)
//   body BulkStateRequest → 200 BulkStateResponse. Sets one state for many customers of one
//   bucket (never needsDefault: one state cannot choose a default; 400), in one transaction with one audit row. 400 when customerIds is empty or has more than
//   BULK_STATE_MAX_CUSTOMERS ids, or when `state` is not a US state / territory code. A customer
//   that is no longer in the named bucket is skipped, not changed. `changedAddressIds` is the
//   Undo handle: addresses updated, plus addresses created for no-address customers.
//
// POST /settings/restrictions/unknown-state-customers/bulk-state/undo   (TENANT_ADMIN, OPERATOR)
//   body BulkStateUndoRequest → 200 BulkStateUndoResponse. Restores the prior state of each
//   address and removes only the addresses that same bulk action created. 409 when the 10-minute
//   window (BULK_STATE_UNDO_WINDOW_MINUTES) has passed, 404 for ids it does not know, and
//   { restored: 0 } for an idempotent repeat.
//
// PATCH /customers/:id/addresses/:addressId/state   (TENANT_ADMIN, OPERATOR)
//   body AddressStateRequest → 200 AddressStateResponse. Sets the state on one existing address.
//   `confirmReview: true` marks a "needs a state check" address as reviewed. 400 on a bad state.
//
// POST /customers/:id/addresses/minimal   (TENANT_ADMIN, OPERATOR)
//   body MinimalAddressRequest → 201 AddressStateResponse. For a customer with no address: creates
//   the default billing address with only a state (and optional ZIP); street stays empty. 400 on a
//   bad state.
//
// `UnknownStateCustomerRow.suggestedState` is computed server-side from a ZIP-prefix -> state
// table in packages/types (no network call); null when nothing can be inferred.

/**
 * The four ways a customer can lack a usable state, in the order the card lists them. needsDefault:
 * 2+ addresses and no default (or defaults that disagree, or an untyped default among several), with
 * no problem address in what the engine reads; it is fixed by choosing a default, via the existing
 * `PATCH /customers/:id/addresses/:addrId { isDefault: true }` (which clears every other default).
 * A customer sits in needsDefault only, never also in unusableState/needsReview.
 */
export const UNKNOWN_STATE_BUCKET_VALUES = [
  "noAddress",
  "unusableState",
  "needsReview",
  "needsDefault",
] as const;
export type UnknownStateBucketName = (typeof UNKNOWN_STATE_BUCKET_VALUES)[number];

/** The buckets a bulk state write accepts: needsDefault is fixed by choosing a default, not a state. */
export const BULK_STATE_BUCKET_VALUES = ["noAddress", "unusableState", "needsReview"] as const;
export type BulkStateBucketName = (typeof BULK_STATE_BUCKET_VALUES)[number];

/** Rows per page when `limit` is omitted. */
export const UNKNOWN_STATE_PAGE_DEFAULT = 20;
/** Largest `limit` the server accepts. */
export const UNKNOWN_STATE_PAGE_MAX = 50;
/** Cap on customerIds per bulk-state request; the same cap as BULK_RESTRICTION_MAX_PRODUCTS. */
export const BULK_STATE_MAX_CUSTOMERS = 200;
/** How long after a bulk-state write its undo is honoured. */
export const BULK_STATE_UNDO_WINDOW_MINUTES = 10;

export interface UnknownStateCustomerRow {
  customerId: string;
  name: string;
  /** The address the problem sits on; null in the noAddress bucket. */
  addressId: string | null;
  /** The raw address as stored, for display; null in the noAddress bucket. */
  addressText: string | null;
  /** Best guess from the ZIP prefix (2-letter USPS code); null when none can be inferred. */
  suggestedState: string | null;
  /** needsDefault rows only: every address of the customer, oldest first, to choose the default from. */
  choices?: UnknownStateAddressChoice[];
}

export interface UnknownStateAddressChoice {
  addressId: string;
  /** The raw address as stored, for display. */
  addressText: string;
  /** BILLING / SHIPPING / DELIVERY as stored (free text; may be blank). */
  addressType: string;
  /** The address's usable 2-letter code, or null when it has none. */
  state: string | null;
  isDefault: boolean;
}

export interface UnknownStateBucket {
  /** All customers in the bucket, not just the rows returned. */
  total: number;
  rows: UnknownStateCustomerRow[];
  /** Pass back as `cursor` (with the same `bucket`) for the next page; null on the last page. */
  nextCursor: string | null;
}

export interface UnknownStateCustomersQuery {
  /** Omitted = all four buckets, first page each. */
  bucket?: UnknownStateBucketName;
  cursor?: string;
  /** Default UNKNOWN_STATE_PAGE_DEFAULT, max UNKNOWN_STATE_PAGE_MAX. */
  limit?: number;
}

export interface UnknownStateCustomersResponse {
  noAddress: UnknownStateBucket;
  unusableState: UnknownStateBucket;
  needsReview: UnknownStateBucket;
  needsDefault: UnknownStateBucket;
  /** Distinct customers across the four buckets (a customer in two buckets counts once): the card header. */
  customersTotal: number;
  /**
   * True only when an active ALL (legal-ban) STATE rule exists and the tenant has no business state on
   * file: the same predicate as the engine's `stateRuleInPlay`. The web shows the "set your business
   * state" nudge from it; false when no such rule is in force.
   */
  businessStateMissing: boolean;
}

export interface BulkStateRequest {
  bucket: BulkStateBucketName;
  /** 1..BULK_STATE_MAX_CUSTOMERS ids, all from `bucket`. */
  customerIds: string[];
  /** 2-letter USPS code (or full name; stored as the 2-letter code). */
  state: string;
}

export interface BulkStateResponse {
  /** Customers whose state was set. */
  changed: number;
  /** Addresses updated or created by this action; send them to bulk-state/undo. */
  changedAddressIds: string[];
}

export interface BulkStateUndoRequest {
  changedAddressIds: string[];
}

export interface BulkStateUndoResponse {
  /** Addresses restored or removed; 0 on an idempotent repeat (409 after the 10-minute window, 404 for unknown ids). */
  restored: number;
}

export interface AddressStateRequest {
  state: string;
  /** True = the staff member confirms the state the system read from the address text. */
  confirmReview?: boolean;
}

export interface MinimalAddressRequest {
  state: string;
  zip?: string;
}

/** Returned by both the PATCH state route and the POST minimal route. */
export interface AddressStateResponse {
  customerId: string;
  addressId: string;
  state: string;
}
