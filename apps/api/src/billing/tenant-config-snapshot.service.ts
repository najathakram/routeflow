import { API_ERROR_CODES } from "../common/api-error-codes";
import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { carrierInTransitCount } from "../orders/carrier-in-transit-guard";
import { featureDefByKey } from "./feature-registry";
import { planRank } from "./plan-catalog.constants";
import {
  overrideRestoreVerdict,
  type AddonRowForVerdict,
  type RestorePlanAllows,
} from "./override-restore-verdict";
import {
  FULFILMENT_MODEL_KEY,
  buildSnapshotPayload,
  fleetHeldAfterRestore,
  holdConfigEntry,
  holdOverrideEntry,
  parseSnapshotPayload,
  planRestore,
  summarizeRestore,
  type ConfigRow,
  type HeldEntry,
  type OverrideRow,
  type RestorePlan,
  type RestoreReport,
  type SnapshotPayload,
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

/**
 * The AUTOMATIC restore runs inside a paid upgrade/checkout transaction, one round trip per config
 * row. It is therefore bounded: at most this many rows written, within this wall-clock budget. A
 * restore that would exceed either is abandoned (the caller's savepoint rolls it back, the plan
 * change proceeds, the snapshot stays un-restored and visible) and an admin restores it explicitly
 * with "Restore now", which is not bounded by these. A tenant has at most one config row per
 * registry feature plus its active overrides, so real snapshots sit far below the row cap; the cap
 * is the guard against a malformed or hostile payload holding the transaction open.
 */
export const AUTO_RESTORE_MAX_ROWS = 200;
// Sits inside the checkout hook's 6 s transaction (BillingService CHECKOUT_TX_OPTIONS) next to the
// Stripe/catalog work and the commit, so it is deliberately well under it.
export const AUTO_RESTORE_TIME_BUDGET_MS = 3_000;

export class RestoreBudgetExceededError extends Error {
  constructor(detail: string) {
    super(`automatic restore abandoned: ${detail}`);
    this.name = "RestoreBudgetExceededError";
  }
}

export interface RestoreBudget {
  maxRows: number;
  timeBudgetMs: number;
  /** Injectable clock (ms) so the time budget is testable without sleeping. */
  clock?: () => number;
}

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
  /**
   * BO-13: config rows the restore HELD back (a delivery-method change under a shipment, or own
   * delivery with no fleet). Each is also counted in `report.skipped`. Non-empty = the snapshot was
   * NOT stamped restored and nothing older was superseded: it stays claimable.
   */
  held: HeldEntry[];
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
  /** Whole days since it was taken (the admin list/confirm dialog shows this). */
  ageDays: number;
  /** Entry counts, or null when the payload is not a readable version-1 document. */
  entries: { configs: number; overrides: number } | null;
}

export interface SnapshotPreview {
  snapshotId: string;
  takenAt: Date;
  planKey: string;
  restoredAt: Date | null;
  ageDays: number;
  /** Older than the automatic-restore horizon: only an explicit admin restore applies it. */
  beyondAutoRestoreHorizon: boolean;
  /** What a restore WOULD do right now; null when the payload is unreadable. Never written. */
  plan: RestorePlan | null;
  /** Rows a restore would HOLD right now - the list apply returns for the same fixture. */
  held: HeldEntry[];
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
    planAllows?: RestorePlanAllows,
    budget: RestoreBudget = {
      maxRows: AUTO_RESTORE_MAX_ROWS,
      timeBudgetMs: AUTO_RESTORE_TIME_BUDGET_MS,
    },
    /** BO-13: add-on keys the caller's transaction activates AFTER this restore (a checkout's purchased add-ons). */
    pendingAddonKeys: readonly string[] = [],
  ): Promise<RestoreResult | null> {
    const clock = budget.clock ?? Date.now;
    const deadline = clock() + budget.timeBudgetMs;
    const withinBudget = (): void => {
      if (clock() > deadline) {
        throw new RestoreBudgetExceededError(`over the ${budget.timeBudgetMs} ms time budget`);
      }
    };
    const newRank = planRank(newPlanKey);
    if (newRank < 0) return null;

    const candidates = await tx.tenantFeatureConfigSnapshot.findMany({
      // Only DOWNGRADE archives are ever auto-consumed: a MANUAL snapshot is an admin's own
      // save-point and stays until an admin restores it (Restore now), never on a re-upgrade.
      where: { tenantId, restoredAt: null, reason: "DOWNGRADE" },
      orderBy: { takenAt: "desc" },
    });
    const snapshot = candidates.find((s) => {
      const r = planRank(s.planKey);
      return r >= 0 && r <= newRank && !beyondAutoRestoreHorizon(s.takenAt, now);
    });
    if (!snapshot) return null;

    // ONLY the automatic path is bounded (see AUTO_RESTORE_MAX_ROWS): the admin's explicit
    // "Restore now" (restoreSnapshot) passes no bounds.
    return this.applySnapshot(
      tx,
      tenantId,
      snapshot,
      newPlanKey,
      now,
      planAllows,
      { maxRows: budget.maxRows, withinBudget },
      pendingAddonKeys,
    );
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
        ageDays: snapshotAgeDays(r.takenAt, new Date()),
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
    planAllows?: RestorePlanAllows,
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
    // The SAME guarded plan `applySnapshot` builds (one helper), so the dialog equals the apply.
    const guarded = payload
      ? await this.planGuarded(
          tx,
          tenantId,
          payload,
          { configs, overrides },
          snapshot.takenAt,
          now,
          planAllows,
        )
      : null;
    const plan = guarded?.plan ?? null;
    return {
      snapshotId: snapshot.id,
      takenAt: snapshot.takenAt,
      planKey: snapshot.planKey,
      restoredAt: snapshot.restoredAt,
      ageDays: snapshotAgeDays(snapshot.takenAt, now),
      beyondAutoRestoreHorizon: beyondAutoRestoreHorizon(snapshot.takenAt, now),
      plan,
      held: guarded?.held ?? [],
    };
  }

  /**
   * `planRestore` + the BO-13 guard on the delivery method — the ONE place preview and apply plan, so
   * they cannot disagree. `planRestore` stays pure; the two DB questions it cannot ask are answered
   * here and applied with the pure `holdConfigEntry`:
   *  - CARRIER_IN_TRANSIT: the row would cross the shipping boundary (`carrierInTransitCount` makes no
   *    query when it does not) while carrier orders are in flight -> hold it;
   *  - FULFILMENT_MODE_NEEDS_FLEET: the row would write `delivery`/`both` and no fleet module is held
   *    AFTER this restore's own override plan (the rule `FeatureConfigService.set` enforces).
   * Only the delivery-method row is ever held; one row gets one reason (in transit first). No lock: the
   * count is a read, like the Settings writer's.
   */
  private async planGuarded(
    tx: Prisma.TransactionClient,
    tenantId: string,
    payload: SnapshotPayload,
    current: { configs: readonly ConfigRow[]; overrides: readonly OverrideRow[] },
    takenAt: Date,
    now: Date,
    planAllows?: RestorePlanAllows,
    pendingAddonKeys: readonly string[] = [],
  ): Promise<{ plan: RestorePlan; held: HeldEntry[] }> {
    let plan = planRestore(payload, current, takenAt, now, planAllows);

    // Row 640: judge every GRANT this restore would re-create, through the ONE verdict. Iterates so a
    // held grant stops satisfying another grant's `requires` (bounded: each pass holds at least one).
    let addonRows: Promise<readonly AddonRowForVerdict[]> | null = null;
    const loadAddonRows = () =>
      (addonRows ??= tx.tenantAddon.findMany({
        where: { tenantId, active: true },
        select: { addonKey: true, sku: true, active: true, isComp: true, priceSnapshot: true },
      }));
    const overrideHeld: HeldEntry[] = [];
    for (let again = true; again;) {
      again = false;
      const effects = [
        ...current.overrides
          .filter((o) => o.revokedAt === null && (o.expiresAt === null || o.expiresAt > now))
          .map((o): [string, "GRANT" | "DENY"] => [o.featureKey, o.effect]),
        ...plan.overrides.create.map((e): [string, "GRANT" | "DENY"] => [e.featureKey, e.effect]),
      ];
      for (const entry of plan.overrides.create) {
        const reason = await overrideRestoreVerdict(tx, tenantId, entry, {
          planAllows,
          pendingAddonKeys,
          effects,
          loadAddonRows,
        });
        if (!reason) continue;
        plan = holdOverrideEntry(plan, entry.featureKey, reason);
        overrideHeld.push({
          kind: "override",
          featureKey: entry.featureKey,
          overrideKind: entry.kind,
          reason,
        });
        again = true;
        break;
      }
    }

    const create = plan.configs.create.find((e) => e.featureKey === FULFILMENT_MODEL_KEY);
    const update = plan.configs.update.find((u) => u.entry.featureKey === FULFILMENT_MODEL_KEY);
    const entry = create ?? update?.entry;
    if (!entry) return { plan, held: overrideHeld };

    const stored = update ? current.configs.find((c) => c.id === update.id)?.mode : undefined;
    const from = stored ?? featureDefByKey(FULFILMENT_MODEL_KEY)?.config?.fallbackMode ?? "unset";
    const to = entry.mode;
    const base = { kind: "fulfilment" as const, featureKey: FULFILMENT_MODEL_KEY, from, to };

    const inTransit = await carrierInTransitCount(tx, tenantId, from, to);
    if (inTransit > 0) {
      plan = holdConfigEntry(plan, FULFILMENT_MODEL_KEY, "CARRIER_IN_TRANSIT");
      return {
        plan,
        held: [...overrideHeld, { ...base, reason: "CARRIER_IN_TRANSIT", count: inTransit }],
      };
    }
    if (to === "delivery" || to === "both") {
      const addons = await loadAddonRows();
      const fleet = fleetHeldAfterRestore(
        plan,
        {
          overrides: current.overrides,
          activeAddonKeys: addons.map((a) => a.addonKey),
          pendingAddonKeys,
        },
        now,
      );
      if (!fleet) {
        plan = holdConfigEntry(
          plan,
          FULFILMENT_MODEL_KEY,
          API_ERROR_CODES.FULFILMENT_MODE_NEEDS_FLEET,
        );
        return {
          plan,
          held: [...overrideHeld, { ...base, reason: API_ERROR_CODES.FULFILMENT_MODE_NEEDS_FLEET }],
        };
      }
    }
    return { plan, held: overrideHeld };
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
    planAllows?: RestorePlanAllows,
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
    planAllows?: RestorePlanAllows,
    /** Present only for the automatic restore; absent = unbounded (the admin path). */
    bounds?: { maxRows: number; withinBudget: () => void },
    pendingAddonKeys: readonly string[] = [],
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
    const { plan, held } = await this.planGuarded(
      tx,
      tenantId,
      payload,
      { configs, overrides },
      snapshot.takenAt,
      now,
      planAllows,
      pendingAddonKeys,
    );
    const rows =
      plan.configs.create.length + plan.configs.update.length + plan.overrides.create.length;
    if (bounds && rows > bounds.maxRows) {
      throw new RestoreBudgetExceededError(`${rows} rows to write, over the ${bounds.maxRows} cap`);
    }

    // CLAIM the snapshot before applying anything: a conditional stamp (`restoredAt IS NULL`).
    // Two concurrent restores — a Stripe webhook redelivery, an admin double-click, an upgrade
    // racing a manual restore — both read the snapshot as un-restored under READ COMMITTED; the
    // second UPDATE waits on the first's row lock, re-checks the predicate after it commits, matches
    // 0 rows, and returns null instead of restoring twice (and double-writing the audit row). If
    // the writes below throw, the caller's transaction rolls the claim back with them.
    //
    // BO-13: a restore that HELD a row is a partial one, and the snapshot stays CLAIMABLE: it is NOT
    // stamped and nothing older is superseded. The same conditional UPDATE still runs (a no-op write
    // of `restoredToPlanKey`, already NULL) so it keeps both properties of the claim — it returns 0
    // rows when another run already consumed the snapshot, and it takes the row lock until this
    // transaction ends. What a held snapshot does next, by construction:
    //  - Restore Now again / the next automatic re-upgrade re-reads current state and re-runs the plan:
    //    every row this run wrote now matches the snapshot (`unchanged`) or was changed by the tenant
    //    since (`keptNewer`), so nothing is written twice and nothing grows; only the held row is
    //    re-judged — still blocked it is held again (a fresh audit row, no state change), cleared it
    //    is written and THEN the snapshot is stamped and the older ones superseded;
    //  - a tenant edit of the row made after the downgrade turns it `keptNewer`, which completes the
    //    snapshot instead of holding it forever;
    //  - two concurrent runs over a held snapshot are not mutually exclusive after the lock is
    //    released (the loser planned before it waited), but both write the same as-was values
    //    (idempotent upsert / update / ON CONFLICT DO NOTHING), so a double apply is harmless.
    // An automatic restore only considers a DOWNGRADE snapshot inside the 90-day horizon, so a snapshot
    // held past it simply stops being picked up (it stays listed for an admin's Restore now).
    bounds?.withinBudget(); // a budget already spent must not even take the claim
    const claimed = await tx.tenantFeatureConfigSnapshot.updateMany({
      where: { id: snapshot.id, tenantId, restoredAt: null },
      data:
        held.length === 0
          ? { restoredAt: now, restoredToPlanKey: stampPlanKey }
          : { restoredToPlanKey: null },
    });
    if (claimed.count === 0) return null;

    // Config rows (fulfilment_model / counter_sales included) are restored inside the caller's own plan
    // transaction and deliberately OUTSIDE the per-tenant settings lock that set() / clear() and the tenant
    // Settings PATCH take: a restore may not wait on, or hold, that lock mid-plan-change. Against a
    // concurrent settings write the last writer wins.
    for (const entry of plan.configs.create) {
      bounds?.withinBudget();
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
      bounds?.withinBudget();
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
    let conflictedOverrides = 0;
    if (plan.overrides.create.length > 0) {
      // ONE createMany with skipDuplicates (INSERT … ON CONFLICT DO NOTHING), not a create per row:
      // a live override for the same feature can appear between our read and this write (an admin
      // grant, a concurrent restore) and would hit the partial unique index
      // (tenantId, featureKey) WHERE revokedAt IS NULL. A caught P2002 would leave the caller's
      // Postgres transaction poisoned ("current transaction is aborted"), so the conflict is
      // resolved IN the statement instead: the concurrent writer's row wins, ours is skipped.
      const inserted = await tx.tenantFeatureOverride.createMany({
        skipDuplicates: true,
        data: plan.overrides.create.map((entry) => ({
          tenantId,
          featureKey: entry.featureKey,
          effect: entry.effect,
          kind: entry.kind as Prisma.TenantFeatureOverrideCreateManyInput["kind"],
          reason: entry.reason,
          expiresAt: entry.expiresAt ? new Date(entry.expiresAt) : null,
          createdById: entry.createdById,
        })),
      });
      // Rows the statement SKIPPED (a live override won the conflict) were not restored: count them
      // as kept — the concurrent writer's value stands — so the audit report never overstates.
      conflictedOverrides = plan.overrides.create.length - inserted.count;
    }

    // A held (partial) restore supersedes nothing: the older snapshots wait behind it, because the
    // payload that carries their rows is not fully applied yet.
    const superseded =
      held.length === 0
        ? await tx.tenantFeatureConfigSnapshot.updateMany({
            // Only older DOWNGRADE archives are superseded: a MANUAL save-point is never auto-consumed.
            where: {
              tenantId,
              restoredAt: null,
              reason: "DOWNGRADE",
              takenAt: { lt: snapshot.takenAt },
            },
            data: { restoredAt: now, restoredToPlanKey: "SUPERSEDED" },
          })
        : { count: 0 };

    return {
      snapshotId: snapshot.id,
      takenAt: snapshot.takenAt,
      planKey: snapshot.planKey,
      report: (() => {
        const r = summarizeRestore(plan);
        return {
          ...r,
          restored: r.restored - conflictedOverrides,
          keptNewer: r.keptNewer + conflictedOverrides,
        };
      })(),
      supersededSnapshots: superseded.count,
      held,
    };
  }
}
