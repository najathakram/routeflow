// Tenant "Configuration snapshots" (Lane B A2 step c) — the platform-admin wire shapes for
// `GET/POST /platform-admin/tenants/:id/config-snapshots…`. Dates arrive as ISO strings. The API
// side is `TenantConfigSnapshotAdminService` (apps/api/src/billing) — keep these in step with it.
import type { SnapshotReasonValue } from "./enums";

/** `GET …/config-snapshots` — one row per snapshot, newest first. */
export interface ConfigSnapshotListItem {
  id: string;
  takenAt: string;
  /** The plan the tenant was LEAVING when this was taken. */
  planKey: string;
  reason: SnapshotReasonValue;
  restoredAt: string | null;
  /** The plan it was restored to, or "SUPERSEDED" when a newer snapshot replaced it. */
  restoredToPlanKey: string | null;
  createdByName: string | null;
  /** Whole days since it was taken. */
  ageDays: number;
  /** null = the stored payload is not a readable version-1 document. */
  entries: { configs: number; overrides: number } | null;
  /** Read back from the restore's own audit row (no migration) — null for a row that was never
   *  restored, or whose audit row is missing/unreadable (never fabricated). */
  restoreReport: (ConfigSnapshotRestoreReport & { automatic: boolean }) | null;
}

export type ConfigSnapshotEntryKind = "config" | "override";

export type ConfigSnapshotSkipReason =
  "UNKNOWN_FEATURE" | "MODE_NOT_OFFERED" | "EXPIRED" | "PLAN_NOT_ALLOWED";

/** `GET …/config-snapshots/:snapshotId/preview` — what "Restore now" would do right now. */
export interface ConfigSnapshotPreview {
  snapshotId: string;
  takenAt: string;
  planKey: string;
  restoredAt: string | null;
  /** Whole days, FLOORED. The horizon flag below is judged on exact time, so a snapshot 90 days
   * 12 h old reads `ageDays: 90` AND `beyondAutoRestoreHorizon: true` — copy must key off the flag. */
  ageDays: number;
  /** Older than the 90-day automatic-restore horizon: restoring it is a deliberate admin override. */
  beyondAutoRestoreHorizon: boolean;
  /** The horizon itself (days), so the UI never hardcodes the number the copy quotes. */
  autoRestoreMaxAgeDays: number;
  /** The plan the tenant is on NOW — the plan the restore is judged against. */
  currentPlanKey: string;
  willRestore: { kind: ConfigSnapshotEntryKind; featureKey: string }[];
  /** Kept as-is: changed after the snapshot (the newer value wins). */
  keptNewer: string[];
  skipped: {
    kind: ConfigSnapshotEntryKind;
    featureKey: string;
    reason: ConfigSnapshotSkipReason;
  }[];
  unchangedCount: number;
}

export interface ConfigSnapshotRestoreReport {
  restored: number;
  skipped: number;
  keptNewer: number;
  unchanged: number;
}

/** `POST …/config-snapshots/:snapshotId/restore` */
export interface ConfigSnapshotRestoreResult {
  snapshotId: string;
  takenAt: string;
  planKey: string;
  restoredToPlanKey: string;
  report: ConfigSnapshotRestoreReport;
  /** Older un-restored snapshots this restore superseded (the API returns it; the tab ignores it). */
  supersededSnapshots: number;
}
