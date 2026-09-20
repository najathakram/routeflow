import { CONFIG_SNAPSHOT_RESTORED_ACTION } from "./config-snapshot-audit.constants";
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
  type RestoreResult,
  type SnapshotListItem,
} from "./tenant-config-snapshot.service";

/** What the admin "Restore now" dialog shows: the same plan a real restore runs, flattened. */
export interface SnapshotPreviewView {
  snapshotId: string;
  takenAt: Date;
  planKey: string;
  restoredAt: Date | null;
  /** The plan the tenant is on NOW — the plan restore is judged against. */
  currentPlanKey: string;
  willRestore: { kind: "config" | "override"; featureKey: string }[];
  /** Kept as-is: the tenant/an admin changed it after the snapshot (newer wins). */
  keptNewer: string[];
  /** Skipped with a reason (unknown feature, mode no longer offered, expired, plan not allowed). */
  skipped: (SkippedEntry & { kind: "config" | "override" })[];
  unchangedCount: number;
}

export interface RestoreNowResult extends RestoreResult {
  restoredToPlanKey: string;
}

/**
 * Admin surface for the tenant "Configuration snapshots" tab (Lane B A2 step c): list, preview and
 * "Restore now". A thin orchestration over `TenantConfigSnapshotService` — it only adds what the
 * pure/DB layers deliberately do not know: which plan the tenant is on now, the plan-aware
 * allow-list, the 404/409/422 mapping, and dropping the affected caches after a write.
 */
/**
 * The explicit "Restore now" is deliberately UNBOUNDED (no row cap, no time budget — unlike the
 * automatic path), so its transaction must not inherit Prisma's 5 s default: a large snapshot is
 * one round trip per config row and would fail with P2028 half-way. 30 s is generous but finite.
 */
export const ADMIN_RESTORE_TX_OPTIONS = { timeout: 30_000, maxWait: 5_000 } as const;

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

  list(tenantId: string): Promise<SnapshotListItem[]> {
    return this.snapshots.list(this.prisma, tenantId);
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
          action: CONFIG_SNAPSHOT_RESTORED_ACTION,
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
