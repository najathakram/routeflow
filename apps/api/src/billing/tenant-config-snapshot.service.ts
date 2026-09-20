import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { planRank } from "./plan-catalog.constants";
import {
  buildSnapshotPayload,
  parseSnapshotPayload,
  planRestore,
  summarizeRestore,
  type RestorePlan,
  type RestoreReport,
} from "./tenant-config-snapshot";

/** As-was includes "no settings": a JSON null column needs DbNull — `undefined` would mean "leave it". */
const toJson = (v: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull =>
  v === null || v === undefined
    ? Prisma.DbNull
    : // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- tsc needs it: `unknown` is not assignable
      (v as Prisma.InputJsonValue);

export interface SnapshotActor {
  id?: string | null;
  name?: string | null;
}

export interface RestoreResult {
  snapshotId: string;
  takenAt: Date;
  planKey: string;
  report: RestoreReport;
}

/** One row of the admin "Configuration snapshots" list. */
export interface SnapshotListItem {
  id: string;
  takenAt: Date;
  planKey: string;
  reason: "DOWNGRADE" | "MANUAL";
  restoredAt: Date | null;
  /** The plan it was restored to, or "SUPERSEDED" when a newer snapshot replaced it. */
  restoredToPlanKey: string | null;
  createdByName: string | null;
  /** Entry counts, or null when the payload is not a readable version-1 document. */
  entries: { configs: number; overrides: number } | null;
}

export interface SnapshotPreview {
  snapshotId: string;
  takenAt: Date;
  planKey: string;
  restoredAt: Date | null;
  /** What a restore WOULD do right now; null when the payload is unreadable. Never written. */
  plan: RestorePlan | null;
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
      return r >= 0 && r <= newRank;
    });
    if (!snapshot) return null;

    return this.applySnapshot(tx, tenantId, snapshot, newPlanKey, now, planAllows);
  }

  /**
   * Admin surface (A2 step c): the tenant's snapshots, newest first. Read-only — no side effects.
   */
  async list(tx: Prisma.TransactionClient, tenantId: string): Promise<SnapshotListItem[]> {
    const rows = await tx.tenantFeatureConfigSnapshot.findMany({
      where: { tenantId },
      orderBy: { takenAt: "desc" },
    });
    return rows.map((r) => {
      const payload = parseSnapshotPayload(r.payload);
      return {
        id: r.id,
        takenAt: r.takenAt,
        planKey: r.planKey,
        reason: r.reason,
        restoredAt: r.restoredAt,
        restoredToPlanKey: r.restoredToPlanKey,
        createdByName: r.createdByName,
        entries: payload
          ? { configs: payload.configs.length, overrides: payload.overrides.length }
          : null,
      };
    });
  }

  /**
   * What "Restore now" WOULD do for one snapshot right now — the same `planRestore` a real restore
   * runs, so the dialog's preview equals the apply by construction. Never writes. null = no such
   * snapshot for this tenant.
   */
  async previewRestore(
    tx: Prisma.TransactionClient,
    tenantId: string,
    snapshotId: string,
    now: Date = new Date(),
    planAllows?: (featureKey: string) => boolean,
  ): Promise<SnapshotPreview | null> {
    const snapshot = await tx.tenantFeatureConfigSnapshot.findFirst({
      where: { id: snapshotId, tenantId },
    });
    if (!snapshot) return null;
    const payload = parseSnapshotPayload(snapshot.payload);
    const [configs, overrides] = await Promise.all([
      tx.tenantFeatureConfig.findMany({ where: { tenantId } }),
      tx.tenantFeatureOverride.findMany({ where: { tenantId } }),
    ]);
    return {
      snapshotId: snapshot.id,
      takenAt: snapshot.takenAt,
      planKey: snapshot.planKey,
      restoredAt: snapshot.restoredAt,
      plan: payload
        ? planRestore(payload, { configs, overrides }, snapshot.takenAt, now, planAllows)
        : null,
    };
  }

  /**
   * "Restore now" for ONE chosen snapshot, applied to the tenant's CURRENT plan (`currentPlanKey`
   * is only stamped and fed to `planAllows`; unlike `restoreLatest` there is no rank check — the
   * admin chose it and saw the preview, entries the plan does not allow are skipped and
   * reported). Returns null when the snapshot does not exist, is already restored/superseded, or
   * its payload is unreadable.
   */
  async restoreSnapshot(
    tx: Prisma.TransactionClient,
    tenantId: string,
    snapshotId: string,
    currentPlanKey: string,
    now: Date = new Date(),
    planAllows?: (featureKey: string) => boolean,
  ): Promise<RestoreResult | null> {
    const snapshot = await tx.tenantFeatureConfigSnapshot.findFirst({
      where: { id: snapshotId, tenantId, restoredAt: null },
    });
    if (!snapshot) return null;
    return this.applySnapshot(tx, tenantId, snapshot, currentPlanKey, now, planAllows);
  }

  /** The shared apply step: restore one snapshot's payload as-was, stamp it, supersede older ones. */
  private async applySnapshot(
    tx: Prisma.TransactionClient,
    tenantId: string,
    snapshot: { id: string; planKey: string; takenAt: Date; payload: Prisma.JsonValue },
    stampPlanKey: string,
    now: Date,
    planAllows?: (featureKey: string) => boolean,
  ): Promise<RestoreResult | null> {
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
      data: { restoredAt: now, restoredToPlanKey: stampPlanKey },
    });
    await tx.tenantFeatureConfigSnapshot.updateMany({
      where: { tenantId, restoredAt: null, takenAt: { lt: snapshot.takenAt } },
      data: { restoredAt: now, restoredToPlanKey: "SUPERSEDED" },
    });

    return {
      snapshotId: snapshot.id,
      takenAt: snapshot.takenAt,
      planKey: snapshot.planKey,
      report: summarizeRestore(plan),
    };
  }
}
