import { BadRequestException } from "@nestjs/common";
import type {
  BulkStateBucketName,
  BULK_STATE_MAX_CUSTOMERS as SharedBulkMax,
  BULK_STATE_UNDO_WINDOW_MINUTES as SharedUndoWindow,
  RestrictionAddressPrecedence,
  UNKNOWN_STATE_PAGE_DEFAULT as SharedPageDefault,
  UNKNOWN_STATE_PAGE_MAX as SharedPageMax,
  UnknownStateBucketName,
  UnknownStateCustomerRow,
} from "@routeflow/types";
import { resolveStateText } from "../common/us-state-resolver";
import { normalizeUsState } from "../common/us-states";
import { suggestStateFromZip } from "../common/zip-state";
import {
  governingAddresses,
  resolveGoverningState,
  type CustomerAddressFacts,
} from "../selling-restrictions/selling-restrictions.core";

// API-side copies of the shared constants (the API never value-imports `@routeflow/types`). Each is
// typed as the shared constant's literal type, so a change there fails to compile here until the
// copy follows; `unknown-state-customers.spec.ts` also pins them equal at runtime.
export const UNKNOWN_STATE_BUCKETS = [
  "noAddress",
  "unusableState",
  "needsReview",
  "needsDefault",
] as const satisfies readonly UnknownStateBucketName[];
/** The buckets bulk-state accepts (the shared BULK_STATE_BUCKET_VALUES): needsDefault is never one. */
export const BULK_STATE_BUCKETS = [
  "noAddress",
  "unusableState",
  "needsReview",
] as const satisfies readonly BulkStateBucketName[];
export const UNKNOWN_STATE_PAGE_DEFAULT_API: typeof SharedPageDefault = 20;
export const UNKNOWN_STATE_PAGE_MAX_API: typeof SharedPageMax = 50;
export const BULK_STATE_MAX: typeof SharedBulkMax = 200;
export const BULK_STATE_UNDO_WINDOW_MIN: typeof SharedUndoWindow = 10;

/** The address columns the buckets read: the engine's own facts plus what a row displays. */
export const UNKNOWN_STATE_ADDRESS_SELECT = {
  id: true,
  tenantId: true,
  isDefault: true,
  addressType: true,
  stateCode: true,
  stateNeedsReview: true,
  line1: true,
  line2: true,
  city: true,
  state: true,
  zip: true,
  createdAt: true,
} as const;

export interface UnknownStateAddress extends CustomerAddressFacts {
  id: string;
  tenantId: string | null;
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  zip: string;
  createdAt: Date;
}

export interface UnknownStateCustomer {
  id: string;
  businessName: string;
  addresses: UnknownStateAddress[];
}

/** Where one customer sits: each bucket it is in, with the address the problem sits on (null for noAddress and needsDefault). */
export type UnknownStatePlacement = Partial<
  Record<
    UnknownStateBucketName,
    { address: UnknownStateAddress | null; others: UnknownStateAddress[] }
  >
>;

/**
 * The state the system can READ for an address that is not usable as-is: its stored code when one is
 * stored but flagged for review, else what the write-boundary resolver reads from the free-text
 * `state` (a clean code never stored, a city-name text such as "Washington", or a text its ZIP
 * contradicts). Null when nothing can be read.
 */
export function readableState(a: UnknownStateAddress): string | null {
  return normalizeUsState(a.stateCode) ?? resolveStateText(a.state)?.code ?? null;
}

/**
 * The bucket(s) of one customer, or `{}` when the engine resolves their governing state.
 *
 * The unknown-state set is exactly the customers `resolveGoverningState` (the engine's own) leaves
 * UNRESOLVED under the tenant's address precedence. Within it:
 *  - noAddress:     no address at all.
 *  - for the others, only the addresses the engine actually reads (`governingAddresses`) count; one of
 *    them is a PROBLEM when its `stateCode` is not a usable code or it is flagged `stateNeedsReview`:
 *    - needsReview:   a problem address whose state the system CAN read (`readableState`): a stored
 *                     code flagged for review, or a code read from the free text but never confirmed
 *                     into `stateCode` (never backfilled, a city-name text, a text its ZIP contradicts).
 *                     "Confirmed" = `stateCode` set and `stateNeedsReview` false.
 *    - unusableState: a problem address whose state nothing can read (blank, "Unknown", a misspelling).
 * A customer can sit in both of the last two (two default addresses).
 *  - needsDefault:  unresolved with NO problem address the engine reads: several addresses and no
 *                   default, defaults that name different usable states, or an UNKNOWN-typed default
 *                   among several. Setting a state cannot fix them, choosing a default can. Exclusive:
 *                   a problem address wins, so a customer is never in needsDefault and another bucket.
 *                   `others` = every address (the choices), oldest first.
 */
export function placeUnknownState(
  customer: UnknownStateCustomer,
  precedence: RestrictionAddressPrecedence,
): UnknownStatePlacement {
  const { addresses } = customer;
  if (resolveGoverningState(addresses, precedence).resolved) return {};
  if (addresses.length === 0) return { noAddress: { address: null, others: [] } };
  const group = byAge(governingAddresses(addresses, precedence));
  const problems = group.filter(
    (a) => a.stateNeedsReview || normalizeUsState(a.stateCode) === null,
  );
  const review = problems.filter((a) => readableState(a) !== null);
  const unusable = problems.filter((a) => readableState(a) === null);
  const out: UnknownStatePlacement = {};
  if (unusable.length > 0) out.unusableState = { address: unusable[0], others: unusable.slice(1) };
  if (review.length > 0) out.needsReview = { address: review[0], others: review.slice(1) };
  if (problems.length === 0) out.needsDefault = { address: null, others: byAge(addresses) };
  return out;
}

/** Oldest first, id as the tie-break: the order rows and choices are shown in. */
function byAge(addresses: readonly UnknownStateAddress[]): UnknownStateAddress[] {
  return [...addresses].sort(
    (x, y) => x.createdAt.getTime() - y.createdAt.getTime() || (x.id < y.id ? -1 : 1),
  );
}

/** The raw address for display: the non-blank parts as stored, comma-joined. */
export function addressText(a: UnknownStateAddress): string {
  return [a.line1, a.line2, a.city, a.state, a.zip]
    .map((p) => (p ?? "").trim())
    .filter((p) => p !== "")
    .join(", ");
}

/** One wire row for a placed customer. `suggestedState`: what the address's own text reads, else its ZIP prefix. */
export function toRow(
  customer: Pick<UnknownStateCustomer, "id" | "businessName">,
  address: UnknownStateAddress | null,
  choices?: readonly UnknownStateAddress[],
): UnknownStateCustomerRow {
  if (!address) {
    return {
      customerId: customer.id,
      name: customer.businessName,
      addressId: null,
      addressText: null,
      suggestedState: null,
      ...(choices
        ? {
            choices: choices.map((a) => ({
              addressId: a.id,
              addressText: addressText(a),
              addressType: a.addressType ?? "",
              state: normalizeUsState(a.stateCode),
              isDefault: a.isDefault,
            })),
          }
        : {}),
    };
  }
  return {
    customerId: customer.id,
    name: customer.businessName,
    addressId: address.id,
    addressText: addressText(address),
    suggestedState: readableState(address) ?? suggestStateFromZip(address.zip),
  };
}

/** Keyset cursor of a bucket page: the last row's (name, id), base64url-wrapped. */
export interface UnknownStateCursor {
  name: string;
  id: string;
}

export function encodeUnknownStateCursor(c: UnknownStateCursor): string {
  return Buffer.from(JSON.stringify([c.name, c.id]), "utf8").toString("base64url");
}

export function decodeUnknownStateCursor(cursor: string): UnknownStateCursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === "string" &&
      parsed[0].length <= 500 &&
      typeof parsed[1] === "string" &&
      parsed[1].length > 0 &&
      parsed[1].length <= 64
    ) {
      return { name: parsed[0], id: parsed[1] };
    }
  } catch {
    /* fall through to the 400 */
  }
  throw new BadRequestException("That page cursor is not valid. Reload the list.");
}
