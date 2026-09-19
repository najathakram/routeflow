# Spec — entitlement config survives downgrade → re-upgrade (Lane B step 5) — lead, 2026-09-19

Owner ruling 2026-09-18: archive on downgrade, restore AS-WAS on re-upgrade. Industry shape:
event-sourcing snapshot (persist at the state-changing event, never hard-delete, rehydrate).

## Data
`TenantFeatureConfigSnapshot` (platform.prisma, additive migration, Squawk-clean):
`id uuid PK · tenantId String (indexed, FK Tenant) · planKey String (the plan being LEFT) ·
takenAt DateTime default now() · reason SnapshotReason enum {DOWNGRADE, MANUAL} · payload Json ·
restoredAt DateTime? · restoredToPlanKey String? · createdById String? · createdByName String?`.
`payload` = the tenant's full effective config the resolver would rebuild from: every
`TenantFeatureConfig` row + every active `TenantFeatureOverride` (key, effect, kind, expiresAt,
reason) + the per-feature settings objects, serialised by ONE pure function
`serializeTenantFeatureConfig(tenantId)` that is also the only reader on restore.

## Behaviour
1. **On downgrade** (any plan change where `rank(new) < rank(old)`, rank = the plan catalog's
   order): inside the same transaction as the plan change, write one snapshot with the OLD
   planKey, then apply the downgrade as today. Snapshot-write failure aborts the downgrade
   (fail closed — losing config silently is the bug we are fixing). Never delete config rows
   that the downgrade makes inert; they stay, the resolver simply no longer honours them.
2. **On upgrade / re-upgrade** to a plan with `rank(new) >= rank(snapshot.planKey)`: find the
   newest un-restored snapshot for the tenant whose planKey rank ≤ new rank; restore every
   entry the new plan still allows (feature exists in the preset or is grantable), skip and
   report entries it does not; mark `restoredAt` + `restoredToPlanKey`. Restore is idempotent
   (re-running changes nothing) and never overwrites a value the tenant changed AFTER the
   downgrade (compare the row's `updatedAt` to `takenAt`; newer wins, and is listed in the
   report).
3. **Never automatic beyond that**: no expiry sweep deletes snapshots; a snapshot is data.
4. **Admin surface** (platform-admin tenant page): a "Configuration snapshots" list (takenAt,
   planKey, reason, restored?) with a "Restore now" action (SUPER_ADMIN, confirm dialog that
   previews what will and will not be restored — reuse `FeaturePreviewService` shape) and,
   after an automatic restore, a note "Restored from the <date> snapshot (N entries, M skipped)".
5. **Tier-change preview (A1)** shows "will be archived: N settings" on downgrade and "will be
   restored from <date>" on upgrade when a matching snapshot exists.

## Proof
Unit: downgrade writes exactly one snapshot with the old planKey; failure aborts; re-upgrade
restores as-was; newer manual change survives; idempotent; a plan lower than the snapshot's
does not restore. db-spec: round trip on the `test` tenant. F Playwright: admin list + restore
dialog at 1440/768/390. Migration: owner applies to prod before merge (backup first).
