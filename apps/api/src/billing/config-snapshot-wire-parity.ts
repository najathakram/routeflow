/**
 * Compile-time parity between the admin service's view types (Dates) and the shared wire types the
 * web imports (`@routeflow/types`, ISO strings). They are two hand-written halves of ONE shape
 * (lesson L-072, one level up from enums): a field added to only one side made the web read
 * `undefined` with no type error. `tsc` (`npm run check-types`) fails HERE if they drift, in either
 * direction. Type-only: it emits nothing at runtime. It is a plain `.ts` on purpose: specs are
 * excluded from `tsc --noEmit` (apps/api/tsconfig.json), so a spec would only be checked by
 * ts-jest, and only when that spec is run; this file is checked by every `check-types`.
 *
 * Limits, so nobody over-trusts it: an OPTIONAL field added to only one side passes in both
 * directions (`{a: 1}` is assignable to `{a: 1; b?: 2}` and back), and an `any` on either side
 * makes that key vacuous. It proves required-field and type parity, not "no drift of any kind".
 */
import type {
  ConfigSnapshotListItem,
  ConfigSnapshotPreview,
  ConfigSnapshotRestoreReport,
  ConfigSnapshotRestoreResult,
} from "@routeflow/types";
import type {
  ConfigSnapshotListItemView,
  RestoreNowResult,
  SnapshotPreviewView,
} from "./tenant-config-snapshot-admin.service";

/** A `Date` on the API side is its ISO string on the wire. */
type Wire<T> = {
  [K in keyof T]: T[K] extends Date ? string : T[K] extends Date | null ? string | null : T[K];
};
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;

export type ListItemParity = Assert<Same<Wire<ConfigSnapshotListItemView>, ConfigSnapshotListItem>>;
export type PreviewParity = Assert<Same<Wire<SnapshotPreviewView>, ConfigSnapshotPreview>>;
// The WHOLE restore envelope, not just its report (`supersededSnapshots` once slipped past a
// report-only check: the API returned it and the wire type did not know it).
export type RestoreResultParity = Assert<Same<Wire<RestoreNowResult>, ConfigSnapshotRestoreResult>>;
export type ReportParity = Assert<Same<RestoreNowResult["report"], ConfigSnapshotRestoreReport>>;
