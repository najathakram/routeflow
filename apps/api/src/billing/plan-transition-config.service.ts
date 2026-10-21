import { EntitlementAuthority } from "./entitlement-authority.service";
import { FeatureOverrideService } from "./feature-override.service";
import { FeatureConfigStore } from "./feature-config.store";
import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { FEATURE_REGISTRY } from "./feature-registry";
import {
  CONFIG_SNAPSHOT_RESTORED_ACTION,
  CONFIG_SNAPSHOT_RESTORE_FAILED_ACTION,
  CONFIG_SNAPSHOT_RESTORE_HELD_ACTION,
  heldAuditMeta,
} from "./config-snapshot-audit.constants";
import { ConfigSnapshotFlagService } from "./config-snapshot-flag.service";
import { PlanCatalogService } from "./plan-catalog.service";
import { findPlanDefinition, planRank } from "./plan-catalog.constants";
import {
  RestoreBudgetExceededError,
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
  /**
   * BO-13: add-on keys the caller's transaction activates AFTER `onPlanChange` (a checkout's purchased
   * add-ons), so the restore's fleet check judges the transaction's END state. No self-service SKU is a
   * fleet module today (Routes and Order delivery are not sold through checkout), so this cannot change a
   * fleet answer yet: it keeps the check correct if one ever is. They are SKU codes compared with add-on
   * keys; a bridged pair (a SKU code that differs from its add-on key) would need mapping first. Only
   * `restoreLatest` reads them.
   */
  pendingAddonKeys?: readonly string[];
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

/**
 * A DOWNGRADE's snapshot could not be written. Sites fail closed (the plan change rolls back) — a
 * typed error so a loop over many tenants (the scheduled-downgrade sweep) can skip THIS tenant and
 * carry on instead of stranding every tenant after it.
 */
export class SnapshotFailedError extends Error {
  constructor(
    readonly tenantId: string,
    cause: unknown,
  ) {
    super(`Config snapshot failed for tenant ${tenantId}: ${(cause as Error)?.message ?? cause}`);
    this.name = "SnapshotFailedError";
  }
}

/** A hook-active plan-change transaction's budget: a restore is one round-trip per config/grant row. */
export const HOOK_TX_OPTIONS = { timeout: 20_000, maxWait: 10_000 } as const;

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
    private readonly authority: EntitlementAuthority,
    private readonly overrides: FeatureOverrideService,
    private readonly configStore: FeatureConfigStore,
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
   * The live flag. Sites use it to skip EVERY extra read the hook needs (a `Tenant.plan` join, a
   * pre-read of the plan being left) while it is off, so wiring a site adds nothing at all until
   * the flag is flipped.
   */
  isEnabled(): Promise<boolean> {
    return this.flag.isEnabled();
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
      let snap: { id: string };
      try {
        snap = await this.snapshots.snapshot(
          tx,
          t.tenantId,
          t.fromPlanKey as string,
          "DOWNGRADE",
          t.actor,
          now,
        );
      } catch (err) {
        throw new SnapshotFailedError(t.tenantId, err);
      }
      this.logger.log(
        `Archived tenant ${t.tenantId} feature config (snapshot ${snap.id}) on ${t.fromPlanKey} -> ${t.toPlanKey}`,
      );
      return { action: "snapshot", snapshotId: snap.id };
    }

    if (!prepared.planAllows) return { action: "restore", restore: null };
    return this.restoreWithoutBlocking(tx, t, prepared.planAllows, now);
  }

  /**
   * A restore is a convenience on an UPGRADE the tenant already paid for: whatever goes wrong in it
   * — a DB error in the restore, a failed audit write, a conflict — must NEVER block or roll back
   * the upgrade/checkout. Inside one Postgres transaction a caught error still poisons it ("current
   * transaction is aborted"), so the whole restore (and its audit row, which exists iff the restore
   * does) runs under a SAVEPOINT: on any failure we ROLL BACK TO it — undoing only the restore —
   * log, and let the plan change carry on. (A DOWNGRADE's snapshot is the opposite: fail closed.)
   */
  private async restoreWithoutBlocking(
    tx: Prisma.TransactionClient,
    t: PlanTransition,
    planAllows: (featureKey: string) => boolean,
    now: Date,
  ): Promise<PlanTransitionOutcome> {
    try {
      await tx.$executeRaw`SAVEPOINT config_snapshot_restore`;
    } catch (err) {
      // A statement error inside a Postgres transaction ABORTS it (a dead connection kills it too),
      // so the upgrade cannot succeed past this point whatever we do: "skip and carry on" would only
      // hide a failure the next write surfaces anyway. Fail loudly instead, so the caller's own
      // alarm fires (the checkout webhook records HOOK_FAILED and Stripe redelivers; an in-app
      // upgrade shows the error) — never a silently dropped paid upgrade.
      this.logger.error(
        `Config restore could not open a savepoint for tenant ${t.tenantId} ` +
          `(${t.fromPlanKey} -> ${t.toPlanKey}); the transaction is unusable: ${(err as Error).message}`,
      );
      throw err;
    }
    try {
      const restore = await this.snapshots.restoreLatest(
        tx,
        t.tenantId,
        t.toPlanKey,
        now,
        planAllows,
        undefined,
        t.pendingAddonKeys,
      );
      // BO-13: a HELD row (a delivery-method change under a shipment, or own delivery with no fleet) makes
      // the restore partial. The upgrade still proceeds; the snapshot stays claimable (not stamped), and
      // the partial run is its own audit action so the list keeps one RESTORED row per restored snapshot.
      const held = restore?.held ?? [];
      if (restore) {
        // The report goes into the existing audit trail (no migration), in the SAME savepoint as
        // the restore. The admin list reads the counts from here.
        await tx.auditLog.create({
          data: {
            tenantId: t.tenantId,
            userId: t.actor?.id ?? null,
            action: held.length
              ? CONFIG_SNAPSHOT_RESTORE_HELD_ACTION
              : CONFIG_SNAPSHOT_RESTORED_ACTION,
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
              ...heldAuditMeta(held),
            },
          },
        });
      }
      await tx.$executeRaw`RELEASE SAVEPOINT config_snapshot_restore`;
      if (restore && held.length === 0) {
        this.logger.log(
          `Restored tenant ${t.tenantId} feature config from snapshot ${restore.snapshotId} on ` +
            `${t.fromPlanKey} -> ${t.toPlanKey}: ${JSON.stringify(restore.report)}`,
        );
      } else if (restore) {
        this.logger.warn(
          `Config restore for tenant ${t.tenantId} (${t.fromPlanKey} -> ${t.toPlanKey}) HELD ` +
            `${held.map((h) => `${h.featureKey} ${h.from}->${h.to} (${h.reason})`).join(", ")}; ` +
            `snapshot ${restore.snapshotId} stays restorable — "Restore now" once cleared`,
        );
      }
      return { action: "restore", restore };
    } catch (err) {
      try {
        await tx.$executeRaw`ROLLBACK TO SAVEPOINT config_snapshot_restore`;
      } catch (rollbackErr) {
        this.logger.error(
          `ROLLBACK TO SAVEPOINT failed for tenant ${t.tenantId}: ${(rollbackErr as Error).message}`,
        );
      }
      this.logger.error(
        `Config restore FAILED for tenant ${t.tenantId} (${t.fromPlanKey} -> ${t.toPlanKey}); the ` +
          `plan change proceeds without it — restore manually from the admin list: ${(err as Error).message}`,
      );
      await this.recordRestoreFailure(tx, t, err);
      return { action: "restore", restore: null };
    }
  }

  /**
   * A restore that failed or was abandoned (over its row cap / time budget) leaves the snapshot
   * un-restored and the tenant on a plan whose config is NOT back — a log line alone is invisible,
   * so it also leaves an audit row (error NAME/code only, never a raw message) that the admin tab's
   * owner can find. It runs in its OWN savepoint: an audit failure here must never poison the
   * paid plan-change transaction.
   */
  private async recordRestoreFailure(
    tx: Prisma.TransactionClient,
    t: PlanTransition,
    err: unknown,
  ): Promise<void> {
    try {
      await tx.$executeRaw`SAVEPOINT config_snapshot_alarm`;
      await tx.auditLog.create({
        data: {
          tenantId: t.tenantId,
          userId: t.actor?.id ?? null,
          action: CONFIG_SNAPSHOT_RESTORE_FAILED_ACTION,
          entityType: "tenant",
          entityId: t.tenantId,
          meta: {
            automatic: true,
            fromPlanKey: t.fromPlanKey ?? null,
            toPlanKey: t.toPlanKey,
            budgetExceeded: err instanceof RestoreBudgetExceededError,
            errorName: (err as Error)?.name ?? null,
            code: (err as { code?: string } | null)?.code ?? null,
          },
        },
      });
      await tx.$executeRaw`RELEASE SAVEPOINT config_snapshot_alarm`;
    } catch (alarmErr) {
      this.logger.error(
        `Could not record the failed restore for tenant ${t.tenantId}: ${(alarmErr as Error).message}`,
      );
      try {
        await tx.$executeRaw`ROLLBACK TO SAVEPOINT config_snapshot_alarm`;
      } catch {
        // The savepoint never opened (or the connection is gone): nothing more to undo.
      }
    }
  }

  /**
   * The `$transaction` options for a plan change: the widened budget ONLY while the hook is active;
   * with the flag off this is `undefined`, so the site's transaction is exactly what it always was.
   */
  transactionOptions(
    prepared: PreparedPlanTransition | null | undefined,
  ): typeof HOOK_TX_OPTIONS | undefined {
    return prepared?.enabled ? HOOK_TX_OPTIONS : undefined;
  }

  /**
   * AFTER the site's transaction commits: an automatic restore rewrote `TenantFeatureConfig` /
   * `TenantFeatureOverride` rows, but the resolver, override and config-mode caches (30 s each)
   * still hold the downgrade-era answer — the restore would look like it did nothing. The manual
   * "Restore now" already drops all three; the automatic path must too. In-process only: another
   * replica keeps the old answer until its own TTL (≤ 30 s), same limit as the manual restore. Only while the flag is on
   * (`prepared.enabled`): flag off, no site touches these caches, exactly as before.
   */
  invalidateCaches(tenantId: string, prepared: PreparedPlanTransition | null | undefined): void {
    if (!prepared?.enabled) return;
    // Runs AFTER the plan change committed, inside callers whose catch may rethrow (the cron's
    // per-tenant loop would abort the whole sweep): it must never throw. Each cache is dropped on
    // its own so one failing does not leave the others stale.
    const drops: Array<[string, () => void]> = [
      ["resolver", () => this.authority.invalidate(tenantId)],
      ["override", () => this.overrides.invalidate(tenantId)],
      ["config-mode", () => this.configStore.invalidateTenant(tenantId)],
    ];
    for (const [name, drop] of drops) {
      try {
        drop();
      } catch (err) {
        this.logger.error(
          `Could not drop the ${name} cache for tenant ${tenantId} after a plan change (stale for ` +
            `at most its TTL): ${(err as Error).message}`,
        );
      }
    }
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
