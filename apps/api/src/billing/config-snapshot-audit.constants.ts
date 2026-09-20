/**
 * The audit action for an entitlement-config restore, written by BOTH paths so the admin UI reads
 * one shape: the automatic restore on a re-upgrade (inside the plan-change transaction, by
 * `PlanTransitionConfigService`) and the super-admin "Restore now" (by the platform-admin
 * controller, where it is `AdminAuditAction.CONFIG_SNAPSHOT_RESTORED` — pinned equal by spec).
 * `meta` carries `snapshotId`, `restoredToPlanKey` and `report` {restored, skipped, keptNewer,
 * unchanged} — no migration: the report lives in the existing audit trail.
 */
export const CONFIG_SNAPSHOT_RESTORED_ACTION = "CONFIG_SNAPSHOT_RESTORED";
