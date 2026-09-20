/**
 * Audit-row identity shared by the override review job (writer) and `FeatureOverrideService.
 * revokeExpired` (reader — the sweep only takes rows the review job has flagged, B589). One
 * definition on both sides: a mismatch between them would leave a row permanently un-sweepable.
 */

/** Audit action code for a flagged-for-review row (system-detected, not an admin action). */
export const FEATURE_OVERRIDE_EXPIRED_REVIEW_ACTION = "FEATURE_OVERRIDE_EXPIRED_REVIEW";

/** `entityType` of every override-scoped audit row: the override row itself, not "tenant". */
export const FEATURE_OVERRIDE_AUDIT_ENTITY_TYPE = "tenantFeatureOverride";
