/**
 * "Customers without a state on file" (state-restrictions UX spec, Addendum D): the wire shapes, the exact copy and the
 * pure helpers of the in-place fixer. Readiness is advice now (owner ruling 3), so nothing here ever blocks.
 */

export type BucketKey = "noAddress" | "unusableState" | "needsReview";
export const BUCKET_KEYS: readonly BucketKey[] = ["noAddress", "unusableState", "needsReview"];

export interface UnknownStateRow {
  customerId: string;
  name: string;
  addressId: string | null;
  addressText: string | null;
  suggestedState: string | null;
}
export interface UnknownStateBucket {
  total: number;
  rows: UnknownStateRow[];
  nextCursor: string | null;
}
export type UnknownStateBuckets = Record<BucketKey, UnknownStateBucket>;

export interface StateWriteResult {
  customerId: string;
  addressId: string;
  state: string;
}
export interface BulkStateResult {
  changed: number;
  changedAddressIds: string[];
}

export const PAGE = 20;
export const BULK_MAX = 200;
export const SAVED_MS = 1200;
export const BULK_UNDO_MS = 10_000;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function headerLine(total: number): string {
  if (total === 0) return "Every customer has a state on file.";
  return `${plural(total, "customer needs", "customers need")} a state. They can still order — state limits just can't reach them until it's set.`;
}

export function bucketLine(key: BucketKey, n: number): string {
  if (key === "noAddress") return `${n} ${n === 1 ? "has" : "have"} no address`;
  if (key === "unusableState")
    return `${plural(n, "address has", "addresses have")} no usable state`;
  return `${plural(n, "address needs", "addresses need")} a state check`;
}

export const bucketAction = (key: BucketKey): "Fix" | "Review" =>
  key === "needsReview" ? "Review" : "Fix";

export const weReadLine = (state: string, text: string | null) =>
  text ? `We read ${state} from "${text}"` : `We read ${state}`;

export const SAVE_FAILED = "Couldn't save. Try again.";

export function bulkConfirmLine(count: number, stateName: string): string {
  return `Set ${stateName} for ${plural(count, "customer", "customers")}?`;
}

export function bulkDoneTitle(changed: number, stateName: string): string {
  return `${stateName} set for ${plural(changed, "customer", "customers")}`;
}

/** How many of a bucket are still to fix: the server total minus rows saved here this visit. */
export const remaining = (total: number, removed: number) => Math.max(0, total - removed);

/** The visible rows of a bucket: loaded rows (first page + "Show more") minus the ones already saved. */
export function visibleRows(
  rows: UnknownStateRow[],
  removed: ReadonlySet<string>,
): UnknownStateRow[] {
  return rows.filter((r) => !removed.has(r.customerId));
}

/** The advisory count the "Limit in portal" dialog shows before it submits (sum of the three bucket totals). */
export const totalWithoutState = (b: UnknownStateBuckets | undefined): number =>
  (b?.noAddress?.total ?? 0) + (b?.unusableState?.total ?? 0) + (b?.needsReview?.total ?? 0);
