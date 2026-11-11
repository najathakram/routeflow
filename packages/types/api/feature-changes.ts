// WP11 (SA-1106 C2): one reviewed set of feature changes, saved in one request.
// `POST /platform-admin/tenants/:id/features/changes` (dryRun previews, otherwise saves) and
// `POST .../features/changes/:auditId/undo`. Mirrors apps/api/src/platform-admin/feature-change.service.ts.

export const FEATURE_CHANGE_ACTION_VALUES = ["GRANT", "DENY", "CLEAR"] as const;
export type FeatureChangeAction = (typeof FEATURE_CHANGE_ACTION_VALUES)[number];

/** One staged change. Only an override today; `type` leaves room for another kind (a comp add-on). */
export interface FeatureChangeInput {
  type?: "override";
  key: string;
  action: FeatureChangeAction;
  kind?: string;
  /** ISO date the override stops applying; omit for a standing one. */
  expiresAt?: string;
}

export interface ApplyFeatureChangesRequest {
  /** The `inputsHash` the page read. A different current hash refuses the whole save (409). */
  expected: string;
  reason: string;
  changes: FeatureChangeInput[];
  dryRun?: boolean;
}

/** An override as the sheet and History describe it. */
export interface FeatureChangeState {
  effect: "GRANT" | "DENY";
  kind: string;
  expiresAt: string | null;
}

export interface FeatureChangePreviewRow {
  key: string;
  before: FeatureChangeState | null;
  after: FeatureChangeState | null;
  /** True when the row is already set that way (a save skips it). */
  unchanged: boolean;
}

export interface FeatureChangesPreviewResponse {
  inputsHash: string;
  /** True when the `expected` that was sent no longer matches. */
  stale: boolean;
  changes: FeatureChangePreviewRow[];
}

/** What a save recorded for one key: the audit row keeps it so History can say it and undo can reverse it. */
export interface FeatureChangeRecord {
  type: "override";
  key: string;
  before: (FeatureChangeState & { id: string }) | null;
  after: FeatureChangeState | null;
  createdIds: string[];
  revokedIds: string[];
}

export interface FeatureChangesApplyResponse {
  /** The audit row id: pass it to undo. */
  changeSetId: string;
  hashAfter: string;
  changes: FeatureChangeRecord[];
}
