import {
  CONFIG_SNAPSHOT_RESTORED_ACTION,
  CONFIG_SNAPSHOT_RESTORE_HELD_ACTION,
  heldAuditMeta,
} from "./config-snapshot-audit.constants";
import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { EntitlementAuthority } from "./entitlement-authority.service";
import { FeatureConfigStore } from "./feature-config.store";
import { FeatureOverrideService } from "./feature-override.service";
import { normalizePlanKey, planKeyFromEnum } from "./plan-catalog.constants";
import { PlanTransitionConfigService } from "./plan-transition-config.service";
import type { RestorePlan, SkippedEntry } from "./tenant-config-snapshot";
import {
  TenantConfigSnapshotService,
  AUTO_RESTORE_MAX_AGE_DAYS,
  type RestoreResult,
  type SnapshotListItem,
} from "./tenant-config-snapshot.service";

/** The restore report for one snapshot's LIST row — read back from its own audit row, never
 *  re-derived. `restored`/`skipped`/`keptNewer`/`unchanged` mirror `RestoreResult["report"]`. */
export interface RestoreReportView {
  automatic: boolean;
  restored: number;
  skipped: number;
  keptNewer: number;
  unchanged: number;
}

/** `SnapshotListItem` plus the restore report, for a restored row — null when the row was never
 *  restored (no report exists yet) or its audit row is missing/unreadable. */
export interface ConfigSnapshotListItemView extends SnapshotListItem {
  restoreReport: RestoreReportView | null;
}

/** What the admin "Restore now" dialog shows: the same plan a real restore runs, flattened. */
export interface SnapshotPreviewView {
  snapshotId: string;
  takenAt: Date;
  planKey: string;
  restoredAt: Date | null;
  ageDays: number;
  /** Older than the automatic-restore horizon (90 days): this restore is a deliberate override. */
  beyondAutoRestoreHorizon: boolean;
  /** The horizon itself (days), so the UI never hardcodes the number the flag copy quotes. */
  autoRestoreMaxAgeDays: number;
  /** The plan the tenant is on NOW — the plan restore is judged against. */
  currentPlanKey: string;
  willRestore: { kind: "config" | "override"; featureKey: string }[];
  /** Kept as-is: the tenant/an admin changed it after the snapshot (newer wins). */
  keptNewer: string[];
  /** Skipped with a reason (unknown feature, mode no longer offered, expired, plan not allowed — and,
   *  for the delivery method, CARRIER_IN_TRANSIT / FULFILMENT_MODE_NEEDS_FLEET: held, the snapshot stays restorable). */
  skipped: (SkippedEntry & { kind: "config" | "override" })[];
  unchangedCount: number;
}

export interface RestoreNowResult extends RestoreResult {
  restoredToPlanKey: string;
}

/**
 * The explicit "Restore now" is deliberately UNBOUNDED (no row cap, no time budget — unlike the
 * automatic path), so its transaction must not inherit Prisma's 5 s default: a large snapshot is
 * one round trip per config row and would fail with P2028 half-way. 30 s is generous but finite.
 */
export const ADMIN_RESTORE_TX_OPTIONS = { timeout: 30_000, maxWait: 5_000 } as const;

/** A restore-report count is a whole number of rows: anything else makes the report unreadable. */
const isCount = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;

/**
 * Admin surface for the tenant "Configuration snapshots" tab (Lane B A2 step c): list, preview and
 * "Restore now". A thin orchestration over `TenantConfigSnapshotService` — it only adds what the
 * pure/DB layers deliberately do not know: which plan the tenant is on now, the plan-aware
 * allow-list, the 404/409/422 mapping, and dropping the affected caches after a write.
 */
@Injectable()
export class TenantConfigSnapshotAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly snapshots: TenantConfigSnapshotService,
    private readonly transitions: PlanTransitionConfigService,
    private readonly authority: EntitlementAuthority,
    private readonly overrides: FeatureOverrideService,
    private readonly configStore: FeatureConfigStore,
  ) {}

  /**
   * The restore report lives in the existing audit trail (no migration — see
   * `config-snapshot-audit.constants.ts`), written by both restore paths inside the SAME
   * transaction as the restore itself. One extra query, scoped to this tenant and entity (hits
   * AuditLog_entityType_entityId_idx); matched to each restored row by `meta.snapshotId`. A restored row
   * whose audit row is missing or unreadable (should not happen; the write is transactional)
   * reports `restoreReport: null` rather than guessing — never a fabricated report.
   */
  async list(tenantId: string): Promise<ConfigSnapshotListItemView[]> {
    const items = await this.snapshots.list(this.prisma, tenantId);
    const restoredIds = items.filter((i) => i.restoredAt).map((i) => i.id);
    if (restoredIds.length === 0) {
      return items.map((i) => ({ ...i, restoreReport: null }));
    }
    const auditRows = await this.prisma.auditLog.findMany({
      // Both writers always set entityType "tenant" + entityId tenantId, so this hits
      // AuditLog_entityType_entityId_idx instead of scanning every audit row the tenant has, and
      // one row per restored snapshot is all the list can use.
      where: {
        tenantId,
        action: CONFIG_SNAPSHOT_RESTORED_ACTION,
        entityType: "tenant",
        entityId: tenantId,
      },
      select: { meta: true },
      orderBy: { createdAt: "desc" },
      take: restoredIds.length,
    });
    const reportBySnapshotId = new Map<string, RestoreReportView>();
    const seen = new Set<string>();
    for (const row of auditRows) {
      const meta = row.meta as Record<string, unknown> | null;
      const snapshotId = typeof meta?.snapshotId === "string" ? meta.snapshotId : null;
      // Newest-first order + set-once: an id can appear twice only via a bug (idempotency guards
      // both restore paths against a duplicate), so the first (newest) row wins if it ever did.
      if (!snapshotId || seen.has(snapshotId)) continue;
      // Mark seen BEFORE validating: a malformed newest row must yield null, not fall through to
      // an older duplicate's stale report.
      seen.add(snapshotId);
      // Only a report whose four counts are all non-negative integers is shown; anything else ({},
      // "abc", a missing count) is unreadable and reports null, never a made-up 0 or NaN.
      const report = meta?.report as Record<string, unknown> | undefined;
      const restored = report?.restored;
      const skipped = report?.skipped;
      const keptNewer = report?.keptNewer;
      const unchanged = report?.unchanged;
      if (![restored, skipped, keptNewer, unchanged].every(isCount)) continue;
      reportBySnapshotId.set(snapshotId, {
        automatic: meta?.automatic === true,
        restored: restored as number,
        skipped: skipped as number,
        keptNewer: keptNewer as number,
        unchanged: unchanged as number,
      });
    }
    return items.map((i) => ({ ...i, restoreReport: reportBySnapshotId.get(i.id) ?? null }));
  }

  async preview(tenantId: string, snapshotId: string): Promise<SnapshotPreviewView> {
    const { planKey, planAllows } = await this.currentPlan(tenantId);
    const pre = await this.snapshots.previewRestore(
      this.prisma,
      tenantId,
      snapshotId,
      new Date(),
      planAllows,
    );
    if (!pre) throw new NotFoundException("Snapshot not found");
    if (!pre.plan) throw new UnprocessableEntityException("This snapshot's payload is unreadable");
    return {
      snapshotId: pre.snapshotId,
      takenAt: pre.takenAt,
      planKey: pre.planKey,
      restoredAt: pre.restoredAt,
      ageDays: pre.ageDays,
      beyondAutoRestoreHorizon: pre.beyondAutoRestoreHorizon,
      autoRestoreMaxAgeDays: AUTO_RESTORE_MAX_AGE_DAYS,
      currentPlanKey: planKey,
      ...flatten(pre.plan),
    };
  }

  /**
   * `actorId` is the acting super-admin: the audit row that carries the restore report is written
   * INSIDE the restore transaction, so a restore and its record commit or roll back together (the
   * tab's "what was restored" reads it) — never a restore that happened with no trail.
   */
  async restoreNow(
    tenantId: string,
    snapshotId: string,
    actorId: string | null = null,
    now: Date = new Date(),
  ): Promise<RestoreNowResult> {
    const { planKey, planAllows } = await this.currentPlan(tenantId);
    const touchedConfigKeys: string[] = [];
    const result = await this.prisma.$transaction(async (tx) => {
      const pre = await this.snapshots.previewRestore(tx, tenantId, snapshotId, now, planAllows);
      if (!pre) throw new NotFoundException("Snapshot not found");
      if (pre.restoredAt) throw new ConflictException("This snapshot was already restored");
      if (!pre.plan)
        throw new UnprocessableEntityException("This snapshot's payload is unreadable");
      touchedConfigKeys.push(
        ...pre.plan.configs.create.map((e) => e.featureKey),
        ...pre.plan.configs.update.map((u) => u.entry.featureKey),
      );
      const res = await this.snapshots.restoreSnapshot(
        tx,
        tenantId,
        snapshotId,
        planKey,
        now,
        planAllows,
      );
      // Lost a race with another restore between the preview read and the write.
      if (!res) throw new ConflictException("This snapshot was already restored");
      await tx.auditLog.create({
        data: {
          tenantId,
          userId: actorId,
          // BO-13: a held row = a partial restore (the snapshot stays claimable) -> its own action, so the
          // list keeps exactly one RESTORED row per restored snapshot (#2226).
          action: res.held.length
            ? CONFIG_SNAPSHOT_RESTORE_HELD_ACTION
            : CONFIG_SNAPSHOT_RESTORED_ACTION,
          entityType: "tenant",
          entityId: tenantId,
          meta: {
            platformAdmin: true,
            automatic: false,
            snapshotId: res.snapshotId,
            snapshotTakenAt: res.takenAt,
            snapshotPlanKey: res.planKey,
            restoredToPlanKey: planKey,
            report: { ...res.report },
            supersededSnapshots: res.supersededSnapshots,
            ...heldAuditMeta(res.held),
          },
        },
      });
      return res;
    }, ADMIN_RESTORE_TX_OPTIONS);

    // After commit: the resolver, the override cache and each touched config key.
    this.authority.invalidate(tenantId);
    this.overrides.invalidate(tenantId);
    for (const key of touchedConfigKeys) this.configStore.invalidate(tenantId, key);
    return { ...result, restoredToPlanKey: planKey };
  }

  /** The plan the tenant is on now (subscription key, else the legacy enum) + its allow-list. */
  private async currentPlan(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        plan: true,
        planVersionId: true,
        subscription: { select: { planKey: true } },
      },
    });
    if (!tenant) throw new NotFoundException("Tenant not found");
    const planKey = normalizePlanKey(tenant.subscription?.planKey) ?? planKeyFromEnum(tenant.plan);
    const planAllows = await this.transitions.planAllowsFor(planKey, tenant.planVersionId ?? null);
    return { planKey, planAllows };
  }
}

function flatten(plan: RestorePlan) {
  return {
    willRestore: [
      ...plan.configs.create.map((e) => ({ kind: "config" as const, featureKey: e.featureKey })),
      ...plan.configs.update.map((u) => ({
        kind: "config" as const,
        featureKey: u.entry.featureKey,
      })),
      ...plan.overrides.create.map((e) => ({
        kind: "override" as const,
        featureKey: e.featureKey,
      })),
    ],
    keptNewer: [...plan.configs.keptNewer, ...plan.overrides.keptNewer],
    skipped: [
      ...plan.configs.skipped.map((s) => ({ ...s, kind: "config" as const })),
      ...plan.overrides.skipped.map((s) => ({ ...s, kind: "override" as const })),
    ],
    unchangedCount: plan.configs.unchanged.length + plan.overrides.unchanged.length,
  };
}
