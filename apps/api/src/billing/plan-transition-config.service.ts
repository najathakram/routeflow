import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { FEATURE_REGISTRY } from "./feature-registry";
import { CONFIG_SNAPSHOT_RESTORED_ACTION } from "./config-snapshot-audit.constants";
import { ConfigSnapshotFlagService } from "./config-snapshot-flag.service";
import { PlanCatalogService } from "./plan-catalog.service";
import { findPlanDefinition, planRank } from "./plan-catalog.constants";
import {
  TenantConfigSnapshotService,
  type RestoreResult,
  type SnapshotActor,
} from "./tenant-config-snapshot.service";

export interface PlanTransition {
  tenantId: string;
  /** The plan being LEFT; null/unknown (a tenant with no plan yet) is never a downgrade. */
  fromPlanKey: string | null | undefined;
  toPlanKey: string;
  /**
   * The catalog version the tenant is pinned to AFTER this write — pass `tenant.planVersionId`
   * when the site does not re-pin. Required (no default): null means "the published version",
   * which is the wrong allow-list for a grandfathered tenant on an older pin.
   */
  toPlanVersionId: string | null;
  actor?: SnapshotActor;
}

/**
 * Everything `onPlanChange` needs that must be read OUTSIDE the caller's transaction (the catalog
 * read uses the shared connection pool: doing it while an interactive transaction already holds a
 * connection can starve the pool under load). Produced by `prepare()`.
 */
export interface PreparedPlanTransition {
  /** The live flag as read BEFORE the transaction: `onPlanChange` never reads it (pool, and one
   *  consistent answer for the whole plan change). */
  enabled: boolean;
  /** null = restore is skipped for this change (flag off, not an upgrade, or the catalog read failed). */
  planAllows: ((featureKey: string) => boolean) | null;
}

export type PlanTransitionOutcome =
  | { action: "none" }
  | { action: "snapshot"; snapshotId: string }
  | { action: "restore"; restore: RestoreResult | null };

/**
 * THE one place a plan change reaches the entitlement-config snapshot/restore rules (Lane B A2
 * step b; spec SPEC-entitlement-snapshot-restore.md). Every site that writes a tenant's plan calls
 * `onPlanChange` INSIDE the same transaction as that write:
 *  - rank(to) < rank(from) → snapshot the config against the plan being left. A failed snapshot
 *    throws, which aborts the plan change (fail closed — silently losing config is the bug);
 *  - rank(to) > rank(from) → restore the newest un-restored snapshot the new plan covers, as-was;
 *  - same rank, an unknown/absent `from`, or the flag off → nothing.
 *
 * FLAG: the `entitlements.configSnapshot` PlatformConfig row (`ConfigSnapshotFlagService`; default
 * OFF, fail-closed, flippable by a super-admin without a redeploy). While off this service never
 * reads the catalog or touches a table, so wiring it into a site changes nothing until it is flipped.
 */
@Injectable()
export class PlanTransitionConfigService implements OnModuleInit {
  private readonly logger = new Logger(PlanTransitionConfigService.name);

  constructor(
    private readonly flag: ConfigSnapshotFlagService,
    private readonly snapshots: TenantConfigSnapshotService,
    private readonly catalog: PlanCatalogService,
  ) {}

  onModuleInit(): void {
    // Make the resolved state visible once at boot — fire-and-forget: Nest awaits an async
    // onModuleInit before listening, and one log line must never be able to stall boot on a slow DB.
    void this.flag
      .isEnabled()
      .then((on) =>
        this.logger.log(
          `Entitlement config snapshot/restore is ${on ? "ON" : "OFF"} (PlatformConfig entitlements.configSnapshot)`,
        ),
      )
      .catch(() => undefined);
  }

  /**
   * Call BEFORE opening the plan-change transaction. Reads the catalog only when the flag is on
   * and the change is an upgrade; a catalog failure never blocks the change — the restore is
   * skipped and logged (a missed restore is recoverable from the admin "Restore now" action; a
   * failed, already-paid upgrade is not).
   */
  async prepare(t: PlanTransition): Promise<PreparedPlanTransition> {
    const enabled = await this.flag.isEnabled();
    if (!enabled || this.direction(t) !== "upgrade") return { enabled, planAllows: null };
    try {
      return { enabled, planAllows: await this.planAllowsFor(t.toPlanKey, t.toPlanVersionId) };
    } catch (err) {
      this.logger.error(
        `Config restore skipped for tenant ${t.tenantId} (${t.fromPlanKey} -> ${t.toPlanKey}): ` +
          `plan catalog unavailable — ${(err as Error).message}`,
      );
      return { enabled, planAllows: null };
    }
  }

  /**
   * Call INSIDE the plan-change transaction, with the `prepare()` result read before it. A DB
   * error here aborts the surrounding transaction (Postgres poisons it) — for a downgrade that is
   * the intended fail-closed; nothing here is swallowed except the catalog read in `prepare()`.
   */
  async onPlanChange(
    tx: Prisma.TransactionClient,
    t: PlanTransition,
    prepared: PreparedPlanTransition,
    now: Date = new Date(),
  ): Promise<PlanTransitionOutcome> {
    if (!prepared.enabled) return { action: "none" };
    const direction = this.direction(t);
    if (direction === "none") return { action: "none" };

    if (direction === "downgrade") {
      const snap = await this.snapshots.snapshot(
        tx,
        t.tenantId,
        t.fromPlanKey as string,
        "DOWNGRADE",
        t.actor,
        now,
      );
      this.logger.log(
        `Archived tenant ${t.tenantId} feature config (snapshot ${snap.id}) on ${t.fromPlanKey} -> ${t.toPlanKey}`,
      );
      return { action: "snapshot", snapshotId: snap.id };
    }

    if (!prepared.planAllows) return { action: "restore", restore: null };
    const restore = await this.snapshots.restoreLatest(
      tx,
      t.tenantId,
      t.toPlanKey,
      now,
      prepared.planAllows,
    );
    if (restore) {
      // The report goes into the existing audit trail (no migration), in the SAME transaction as
      // the restore: it exists iff the restore does. The admin list reads the counts from here.
      await tx.auditLog.create({
        data: {
          tenantId: t.tenantId,
          userId: t.actor?.id ?? null,
          action: CONFIG_SNAPSHOT_RESTORED_ACTION,
          entityType: "tenant",
          entityId: t.tenantId,
          meta: {
            automatic: true,
            snapshotId: restore.snapshotId,
            snapshotTakenAt: restore.takenAt,
            snapshotPlanKey: restore.planKey,
            fromPlanKey: t.fromPlanKey ?? null,
            restoredToPlanKey: t.toPlanKey,
            report: { ...restore.report },
            supersededSnapshots: restore.supersededSnapshots,
          },
        },
      });
      this.logger.log(
        `Restored tenant ${t.tenantId} feature config from snapshot ${restore.snapshotId} on ` +
          `${t.fromPlanKey} -> ${t.toPlanKey}: ${JSON.stringify(restore.report)}`,
      );
    }
    return { action: "restore", restore };
  }

  /** Rank only — never entitlement loss: a cancel/suspend leaves `planKey` (and so this) untouched. */
  private direction(t: PlanTransition): "downgrade" | "upgrade" | "none" {
    const fromRank = t.fromPlanKey ? planRank(t.fromPlanKey) : -1;
    const toRank = planRank(t.toPlanKey);
    if (fromRank < 0 || toRank < 0 || fromRank === toRank) return "none";
    return toRank < fromRank ? "downgrade" : "upgrade";
  }

  /**
   * "Does the plan being restored TO allow this feature?" — the same reference semantics as
   * `resolveOneKey`: the plan's own `featureFlags` ∪ the flags any of the version's add-on SKUs
   * grant (`grantsFlags` — a tenant on any plan can hold those) ∪ a feature's `billing.catalogFlag`
   * bridge ∪ default-granted ∪ addon-keyed gates. A plan-bundled flag the new plan lacks and no SKU
   * grants is skipped and reported by `planRestore`.
   */
  async planAllowsFor(
    planKey: string,
    planVersionId: string | null,
  ): Promise<(featureKey: string) => boolean> {
    const version = await this.catalog.getVersionForTenant(planVersionId);
    const flags = new Set(findPlanDefinition(version.definitions, planKey)?.featureFlags ?? []);
    for (const sku of version.addonSkus) for (const g of sku.grantsFlags ?? []) flags.add(g);
    const allowed = new Set<string>();
    for (const f of FEATURE_REGISTRY) {
      const addonKeyed = f.gate.via === "RequireAddon" || f.gate.via === "guard";
      if (
        flags.has(f.key) ||
        (f.billing.catalogFlag !== undefined && flags.has(f.billing.catalogFlag)) ||
        f.defaultGranted ||
        addonKeyed
      ) {
        allowed.add(f.key);
      }
    }
    return (featureKey) => allowed.has(featureKey);
  }
}
