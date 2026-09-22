/**
 * The audit action for an entitlement-config restore, written by BOTH paths so the admin UI reads
 * one shape: the automatic restore on a re-upgrade (inside the plan-change transaction, by
 * `PlanTransitionConfigService`) and the super-admin "Restore now" (by the platform-admin
 * controller, where it is `AdminAuditAction.CONFIG_SNAPSHOT_RESTORED` — pinned equal by spec).
 * `meta` carries `snapshotId`, `restoredToPlanKey` and `report` {restored, skipped, keptNewer,
 * unchanged} — no migration: the report lives in the existing audit trail.
 */
export const CONFIG_SNAPSHOT_RESTORED_ACTION = "CONFIG_SNAPSHOT_RESTORED";

/**
 * The audit row for the live on/off switch of automatic snapshot/restore, written by
 * `ConfigSnapshotFlagService.setEnabledAudited` INSIDE the same transaction as the flag write (pinned equal to
 * `AdminAuditAction.CONFIG_SNAPSHOT_FLAG_CHANGED` and `ADMIN_AUDIT_ENTITY` by spec, so the admin audit-log
 * filter and label keep working). The flag turns on unattended writes to tenant config, so a flip with no audit
 * row must be impossible, not merely unlikely.
 */
export const CONFIG_SNAPSHOT_FLAG_CHANGED_ACTION = "CONFIG_SNAPSHOT_FLAG_CHANGED";
export const CONFIG_SNAPSHOT_FLAG_AUDIT_ENTITY = "tenant";
