import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { planRank } from "./plan-catalog.constants";
import {
  buildSnapshotPayload,
  parseSnapshotPayload,
  planRestore,
  summarizeRestore,
  type RestoreReport,
} from "./tenant-config-snapshot";

/** As-was includes "no settings": a JSON null column needs DbNull — `undefined` would mean "leave it". */
const toJson = (v: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull =>
  v === null || v === undefined
    ? Prisma.DbNull
    : // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- tsc needs it: `unknown` is not assignable
      (v as Prisma.InputJsonValue);

/**
 * Automatic restore (a re-upgrade) only considers snapshots taken within this many days (lead
 * ruling 2026-09-20): a config archived long ago is more likely stale than wanted, so it is never
 * re-applied unattended. It stays listed, and a SUPER_ADMIN can still restore it explicitly
 * after seeing its age. Inclusive: a snapshot exactly 90 days old restores.
 */
export const AUTO_RESTORE_MAX_AGE_DAYS = 90;
const DAY_MS = 86_400_000;

/** Whole days since the snapshot was taken (floor; never negative). */
export const snapshotAgeDays = (takenAt: Date, now: Date): number =>
  Math.max(0, Math.floor((now.getTime() - takenAt.getTime()) / DAY_MS));

/** True when automatic restore would refuse this snapshot as too old. */
export const beyondAutoRestoreHorizon = (takenAt: Date, now: Date): boolean =>
  now.getTime() - takenAt.getTime() > AUTO_RESTORE_MAX_AGE_DAYS * DAY_MS;

export interface SnapshotActor {
  id?: string | null;
  name?: string | null;
}

export interface RestoreResult {
  snapshotId: string;
  takenAt: Date;
  planKey: string;
  report: RestoreReport;
  /** Older un-restored snapshots this restore superseded. */
  supersededSnapshots: number;
}

/**
 * Thin DB shell over the pure rules in `tenant-config-snapshot.ts` (Lane B A2, spec
 * SPEC-entitlement-snapshot-restore.md). Both methods take the CALLER'S transaction client — the
 * whole point is that a snapshot and the plan change it protects commit or roll back together, so
 * a snapshot-write failure aborts the downgrade (fail closed).
 *
 * DARK: nothing calls this yet. The plan-change wiring lands in its own flagged PR.
 */
@Injectable()
export class TenantConfigSnapshotService {
  /**
   * Archive the tenant's full effective config against the plan being LEFT. Never deletes or
   * alters a config/override row — the downgrade makes them inert, the resolver stops honouring
   * them, they stay.
   */
  async snapshot(
    tx: Prisma.TransactionClient,
    tenantId: string,
    planKey: string,
    reason: "DOWNGRADE" | "MANUAL",
    actor?: SnapshotActor,
    now: Date = new Date(),
  ): Promise<{ id: string; takenAt: Date }> {
    const [configs, overrides] = await Promise.all([
      tx.tenantFeatureConfig.findMany({ where: { tenantId } }),
      tx.tenantFeatureOverride.findMany({ where: { tenantId } }),
    ]);
    const payload = buildSnapshotPayload(configs, overrides, now);
    return tx.tenantFeatureConfigSnapshot.create({
      data: {
        tenantId,
        planKey,
        takenAt: now,
        reason,
        payload: payload as unknown as Prisma.InputJsonValue,
        createdById: actor?.id ?? null,
        createdByName: actor?.name ?? null,
      },
      select: { id: true, takenAt: true },
    });
  }

  /**
   * On an upgrade to `newPlanKey`: rehydrate the newest un-restored snapshot whose plan rank is
   * <= the new plan's rank. Returns null when there is nothing to restore (the common case) — a
   * LOWER plan than the snapshot's never restores. Idempotent: the snapshot is stamped
   * `restoredAt`, and a re-run of the plan itself changes nothing. Older un-restored snapshots are
   * SUPERSEDED (stamped `restoredToPlanKey: "SUPERSEDED"`): the newer snapshot's payload already
   * carries every row the older one did (a downgrade never deletes config), so a later upgrade
   * must not re-apply the stale one over state this restore established.
   * A snapshot older than `AUTO_RESTORE_MAX_AGE_DAYS` is never restored here (left un-stamped).
   * `planAllows` — does the plan being restored TO allow this feature? — is supplied by the
   * plan-change wiring; the default (allow) is only for callers with no plan context.
   */
  async restoreLatest(
    tx: Prisma.TransactionClient,
    tenantId: string,
    newPlanKey: string,
    now: Date = new Date(),
    planAllows?: (featureKey: string) => boolean,
  ): Promise<RestoreResult | null> {
    const newRank = planRank(newPlanKey);
    if (newRank < 0) return null;

    const candidates = await tx.tenantFeatureConfigSnapshot.findMany({
      where: { tenantId, restoredAt: null },
      orderBy: { takenAt: "desc" },
    });
    const snapshot = candidates.find((s) => {
      const r = planRank(s.planKey);
      return r >= 0 && r <= newRank && !beyondAutoRestoreHorizon(s.takenAt, now);
    });
    if (!snapshot) return null;

    const [configs, overrides] = await Promise.all([
      tx.tenantFeatureConfig.findMany({ where: { tenantId } }),
      tx.tenantFeatureOverride.findMany({ where: { tenantId } }),
    ]);
    // A malformed / future-version payload must never throw inside the caller's plan-change
    // transaction (that would block the upgrade). Leave it un-stamped — it stays visible for a
    // manual look — and restore nothing.
    const payload = parseSnapshotPayload(snapshot.payload);
    if (!payload) return null;
    const plan = planRestore(payload, { configs, overrides }, snapshot.takenAt, now, planAllows);

    for (const entry of plan.configs.create) {
      // upsert on the (tenantId, featureKey) unique key: a concurrent writer that created the row
      // between our read and this write must not turn the restore into a P2002 that aborts the
      // caller's whole plan change.
      await tx.tenantFeatureConfig.upsert({
        where: { tenantId_featureKey: { tenantId, featureKey: entry.featureKey } },
        create: {
          tenantId,
          featureKey: entry.featureKey,
          mode: entry.mode,
          settings: toJson(entry.settings),
          reason: entry.reason,
          updatedById: entry.updatedById,
        },
        update: {},
      });
    }
    for (const { id, entry } of plan.configs.update) {
      // updateMany so tenantId scopes the write (the house pattern — see FeatureOverrideService).
      await tx.tenantFeatureConfig.updateMany({
        where: { id, tenantId },
        data: {
          mode: entry.mode,
          settings: toJson(entry.settings),
          reason: entry.reason,
          updatedById: entry.updatedById,
        },
      });
    }
    for (const entry of plan.overrides.create) {
      await tx.tenantFeatureOverride.create({
        data: {
          tenantId,
          featureKey: entry.featureKey,
          effect: entry.effect,
          kind: entry.kind as Prisma.TenantFeatureOverrideCreateInput["kind"],
          reason: entry.reason,
          expiresAt: entry.expiresAt ? new Date(entry.expiresAt) : null,
          createdById: entry.createdById,
        },
      });
    }

    await tx.tenantFeatureConfigSnapshot.update({
      where: { id: snapshot.id },
      data: { restoredAt: now, restoredToPlanKey: newPlanKey },
    });
    const superseded = await tx.tenantFeatureConfigSnapshot.updateMany({
      where: { tenantId, restoredAt: null, takenAt: { lt: snapshot.takenAt } },
      data: { restoredAt: now, restoredToPlanKey: "SUPERSEDED" },
    });

    return {
      snapshotId: snapshot.id,
      takenAt: snapshot.takenAt,
      planKey: snapshot.planKey,
      report: summarizeRestore(plan),
      supersededSnapshots: superseded.count,
    };
  }
}
