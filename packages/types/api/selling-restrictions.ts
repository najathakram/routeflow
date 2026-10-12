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
//   state cannot be resolved (walk-in excluded), split into three buckets, sorted by name.
//   Without `bucket` all three buckets come back, first page each. With `bucket` only that bucket
//   is paged from `cursor`; the other two are returned as empty buckets with their real totals
//   (rows: [], nextCursor: null, total: <real count>). `limit` defaults to
//   UNKNOWN_STATE_PAGE_DEFAULT and is capped at UNKNOWN_STATE_PAGE_MAX. 400 on a bad bucket,
//   cursor or limit.
//
// POST /settings/restrictions/unknown-state-customers/bulk-state   (TENANT_ADMIN, OPERATOR)
//   body BulkStateRequest → 200 BulkStateResponse. Sets one state for many customers of one
//   bucket, in one transaction with one audit row. 400 when customerIds is empty or has more than
//   BULK_STATE_MAX_CUSTOMERS ids, or when `state` is not a US state / territory code. A customer
//   that is no longer in the named bucket is skipped, not changed. `changedAddressIds` is the
//   Undo handle: addresses updated, plus addresses created for no-address customers.
//
// POST /settings/restrictions/unknown-state-customers/bulk-state/undo   (TENANT_ADMIN, OPERATOR)
//   body BulkStateUndoRequest → 200 BulkStateUndoResponse. Restores the prior state of each
//   address and removes only the addresses that same bulk action created. Honoured within
//   BULK_STATE_UNDO_WINDOW_MINUTES of the bulk write; idempotent (a second call restores 0).
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

/** The three ways a customer can lack a usable state, in the order the card lists them. */
export const UNKNOWN_STATE_BUCKET_VALUES = ["noAddress", "unusableState", "needsReview"] as const;
export type UnknownStateBucketName = (typeof UNKNOWN_STATE_BUCKET_VALUES)[number];

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
}

export interface UnknownStateBucket {
  /** All customers in the bucket, not just the rows returned. */
  total: number;
  rows: UnknownStateCustomerRow[];
  /** Pass back as `cursor` (with the same `bucket`) for the next page; null on the last page. */
  nextCursor: string | null;
}

export interface UnknownStateCustomersQuery {
  /** Omitted = all three buckets, first page each. */
  bucket?: UnknownStateBucketName;
  cursor?: string;
  /** Default UNKNOWN_STATE_PAGE_DEFAULT, max UNKNOWN_STATE_PAGE_MAX. */
  limit?: number;
}

export interface UnknownStateCustomersResponse {
  noAddress: UnknownStateBucket;
  unusableState: UnknownStateBucket;
  needsReview: UnknownStateBucket;
}

export interface BulkStateRequest {
  bucket: UnknownStateBucketName;
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
  /** Addresses restored or removed; 0 on a repeat call or after the undo window. */
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
