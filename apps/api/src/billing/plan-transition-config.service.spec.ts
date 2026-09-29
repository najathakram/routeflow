import { Logger } from "@nestjs/common";
import { FEATURE_REGISTRY } from "./feature-registry";
import { PLAN_KEYS } from "./plan-catalog.constants";
import { RestoreBudgetExceededError } from "./tenant-config-snapshot.service";
import {
  HOOK_TX_OPTIONS,
  PlanTransitionConfigService,
  SnapshotFailedError,
} from "./plan-transition-config.service";

// Keys and plans come from the live registry/catalog (L-206), never re-typed here.
const LOW = PLAN_KEYS[0];
const MSG = "raw row fragment (secret)";
const HIGH = PLAN_KEYS[PLAN_KEYS.length - 1];
const planFlagKeys = FEATURE_REGISTRY.filter(
  (f) => f.gate.via === "RequirePlanFlag" && !f.defaultGranted,
).map((f) => f.key);
const IN_PLAN = planFlagKeys[0];
const NOT_IN_PLAN = planFlagKeys[1];
const SKU_GRANTED = planFlagKeys[2];
const ADDON_KEYED = FEATURE_REGISTRY.find((f) => f.gate.via === "RequireAddon")!.key;
// A flag-keyed default (not an add-on): an add-on-keyed default (orders_inline_returns, owner
// ruling 2026-09-28) takes the addonKeyed branch and would leave the defaultGranted branch untested.
const DEFAULT_GRANTED = FEATURE_REGISTRY.find(
  (f) => f.defaultGranted && f.gate.via !== "RequireAddon" && f.gate.via !== "guard",
)!.key;

const auditCreate = jest.fn().mockResolvedValue({});
const raw = jest.fn().mockResolvedValue(1);
// A tagged-template call: the first argument is the strings array.
const sqlOf = () => raw.mock.calls.map((c) => (c[0] as string[]).join("").trim());
const TX = { tag: "tx", auditLog: { create: auditCreate }, $executeRaw: raw } as never;
const ACTOR = { id: "u1", name: "Admin" };

function build(enabled: boolean) {
  auditCreate.mockClear();
  raw.mockClear();
  const snapshots = {
    snapshot: jest.fn().mockResolvedValue({ id: "snap-1", takenAt: new Date() }),
    restoreLatest: jest.fn().mockResolvedValue({
      snapshotId: "snap-0",
      takenAt: new Date(),
      planKey: HIGH,
      report: { restored: 2, skipped: 1, keptNewer: 1, unchanged: 0 },
      supersededSnapshots: 2,
    }),
  };
  const catalog = {
    getVersionForTenant: jest.fn().mockResolvedValue({
      definitions: [{ planKey: HIGH, featureFlags: [IN_PLAN] }],
      // An add-on SKU grants a plan flag to a tenant on ANY plan (grantsFlags), like MSRP/forecasting.
      addonSkus: [{ sku: "SOME_SKU", grantsFlags: [SKU_GRANTED] }],
    }),
  };
  const flag = { isEnabled: jest.fn().mockResolvedValue(enabled) };
  const caches = {
    authority: { invalidate: jest.fn() },
    overrides: { invalidate: jest.fn() },
    configStore: { invalidateTenant: jest.fn() },
  };
  const svc = new PlanTransitionConfigService(
    flag as never,
    snapshots as never,
    catalog as never,
    caches.authority as never,
    caches.overrides as never,
    caches.configStore as never,
  );
  return { svc, snapshots, catalog, flag, caches };
}

/** The real call order at a site: prepare() BEFORE the transaction, onPlanChange(tx, ...) inside it. */
async function runTransition(
  svc: PlanTransitionConfigService,
  t: Parameters<PlanTransitionConfigService["prepare"]>[0],
  now?: Date,
) {
  const prepared = await svc.prepare(t);
  return svc.onPlanChange(TX, t, prepared, now);
}

describe("PlanTransitionConfigService (A2 step b)", () => {
  it("with the flag OFF nothing is read or written on a downgrade or an upgrade", async () => {
    const { svc, snapshots, catalog } = build(false);

    for (const [from, to] of [
      [HIGH, LOW],
      [LOW, HIGH],
    ]) {
      expect(
        await runTransition(svc, {
          tenantId: "t1",
          fromPlanKey: from,
          toPlanKey: to,
          toPlanVersionId: null,
        }),
      ).toEqual({ action: "none" });
    }
    expect(snapshots.snapshot).not.toHaveBeenCalled();
    expect(snapshots.restoreLatest).not.toHaveBeenCalled();
    expect(catalog.getVersionForTenant).not.toHaveBeenCalled();
  });

  it("isEnabled() is the live flag, for sites that skip their extra reads while it is off", async () => {
    expect(await build(true).svc.isEnabled()).toBe(true);
    expect(await build(false).svc.isEnabled()).toBe(false);
  });

  it("the flag is read once, in prepare() BEFORE the transaction — onPlanChange never reads it", async () => {
    const { svc, flag } = build(true);
    const t = { tenantId: "t1", fromPlanKey: HIGH, toPlanKey: LOW, toPlanVersionId: null };

    const prepared = await svc.prepare(t);
    expect(prepared.enabled).toBe(true);
    expect(flag.isEnabled).toHaveBeenCalledTimes(1);

    flag.isEnabled.mockResolvedValue(false); // flipped mid-flight: this plan change stays consistent
    expect(await svc.onPlanChange(TX, t, prepared)).toMatchObject({ action: "snapshot" });
    expect(flag.isEnabled).toHaveBeenCalledTimes(1);
  });

  it("a downgrade snapshots the plan being LEFT, inside the caller's tx, once", async () => {
    const { svc, snapshots } = build(true);
    const now = new Date("2026-09-20T00:00:00Z");

    const out = await runTransition(
      svc,
      { tenantId: "t1", fromPlanKey: HIGH, toPlanKey: LOW, toPlanVersionId: null, actor: ACTOR },
      now,
    );

    expect(out).toEqual({ action: "snapshot", snapshotId: "snap-1" });
    expect(snapshots.snapshot).toHaveBeenCalledTimes(1);
    expect(snapshots.snapshot).toHaveBeenCalledWith(TX, "t1", HIGH, "DOWNGRADE", ACTOR, now);
    expect(snapshots.restoreLatest).not.toHaveBeenCalled();
  });

  it("fails closed: a failed snapshot rejects, so the caller's transaction aborts the downgrade", async () => {
    const { svc, snapshots } = build(true);
    snapshots.snapshot.mockRejectedValueOnce(new Error("db down"));

    await expect(
      runTransition(svc, {
        tenantId: "t1",
        fromPlanKey: HIGH,
        toPlanKey: LOW,
        toPlanVersionId: null,
      }),
    ).rejects.toThrow("db down");
  });

  it("an upgrade restores the newest snapshot the new plan covers, with a plan-aware allow-list", async () => {
    const { svc, snapshots, catalog } = build(true);

    const out = await runTransition(svc, {
      tenantId: "t1",
      fromPlanKey: LOW,
      toPlanKey: HIGH,
      toPlanVersionId: "v1",
    });

    expect(out).toMatchObject({ action: "restore", restore: { snapshotId: "snap-0" } });
    expect(catalog.getVersionForTenant).toHaveBeenCalledWith("v1");
    const [tx, tenantId, toKey, , planAllows] = snapshots.restoreLatest.mock.calls[0];
    expect([tx, tenantId, toKey]).toEqual([TX, "t1", HIGH]);
    expect(planAllows(IN_PLAN)).toBe(true); // the plan's own featureFlags carry it
    expect(planAllows(ADDON_KEYED)).toBe(true); // an add-on any plan can hold
    expect(planAllows(DEFAULT_GRANTED)).toBe(true);
    // A flag an add-on SKU grants (MSRP / forecasting style) is allowed on any plan: the tenant
    // still holds the SKU, so its override/config must not be dropped as "plan lacks it".
    expect(planAllows(SKU_GRANTED)).toBe(true);
    expect(planAllows(NOT_IN_PLAN)).toBe(false); // plan-bundled flag this plan lacks
    expect(planAllows("no.such.feature")).toBe(false);
  });

  it("an automatic restore writes its report into the AUDIT TRAIL in the same tx (no migration)", async () => {
    const { svc } = build(true);

    await runTransition(svc, {
      tenantId: "t1",
      fromPlanKey: LOW,
      toPlanKey: HIGH,
      toPlanVersionId: null,
      actor: { id: "u9" },
    });

    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(auditCreate.mock.calls[0][0].data).toMatchObject({
      tenantId: "t1",
      userId: "u9",
      action: "CONFIG_SNAPSHOT_RESTORED",
      entityType: "tenant",
      entityId: "t1",
      meta: {
        automatic: true,
        snapshotId: "snap-0",
        restoredToPlanKey: HIGH,
        report: { restored: 2, skipped: 1, keptNewer: 1, unchanged: 0 },
        supersededSnapshots: 2,
      },
    });
  });

  // #2226 / SA-386: the admin list reads the audit trail with `take = restoredIds.length`, exact only
  // while each restored snapshot has ONE audit row. The automatic writer's side of that invariant:
  // a second re-upgrade finds the snapshot already restored (restoreLatest → null) and writes nothing.
  it("#2226: a second upgrade after an automatic restore writes NO second audit row for that snapshot", async () => {
    const { svc, snapshots } = build(true);
    const up = { tenantId: "t1", fromPlanKey: LOW, toPlanKey: HIGH, toPlanVersionId: null };
    await runTransition(svc, up); // restores s1 → one audit row
    snapshots.restoreLatest.mockResolvedValueOnce(null); // s1 is stamped: nothing left to restore
    await runTransition(svc, up);
    const restored = auditCreate.mock.calls.filter(
      (c: any[]) => c[0].data.action === "CONFIG_SNAPSHOT_RESTORED",
    );
    expect(restored).toHaveLength(1);
  });

  it("no audit row when nothing was restored, and none for a downgrade", async () => {
    const { svc, snapshots } = build(true);
    snapshots.restoreLatest.mockResolvedValueOnce(null);
    await runTransition(svc, {
      tenantId: "t1",
      fromPlanKey: LOW,
      toPlanKey: HIGH,
      toPlanVersionId: null,
    });
    await runTransition(svc, {
      tenantId: "t1",
      fromPlanKey: HIGH,
      toPlanKey: LOW,
      toPlanVersionId: null,
    });
    expect(auditCreate).not.toHaveBeenCalled();
  });

  describe("a restore NEVER blocks the upgrade (savepointed) — a downgrade snapshot still fails closed", () => {
    const up = { tenantId: "t1", fromPlanKey: LOW, toPlanKey: HIGH, toPlanVersionId: null };

    it("success: SAVEPOINT, then the restore + its audit row, then RELEASE", async () => {
      const { svc } = build(true);

      await runTransition(svc, up);

      expect(sqlOf()).toEqual([
        "SAVEPOINT config_snapshot_restore",
        "RELEASE SAVEPOINT config_snapshot_restore",
      ]);
      expect(auditCreate).toHaveBeenCalledTimes(1);
    });

    it("a restore that THROWS is rolled back to the savepoint and the upgrade carries on (no throw)", async () => {
      const { svc, snapshots } = build(true);
      snapshots.restoreLatest.mockRejectedValueOnce(new Error(`deadlock detected ${MSG}`));

      const out = await runTransition(svc, up);

      expect(out).toEqual({ action: "restore", restore: null });
      expect(sqlOf()).toEqual([
        "SAVEPOINT config_snapshot_restore",
        "ROLLBACK TO SAVEPOINT config_snapshot_restore",
        "SAVEPOINT config_snapshot_alarm",
        "RELEASE SAVEPOINT config_snapshot_alarm",
      ]);
      // ... and a failure is FINDABLE: an audit row (name/code only, never the raw message).
      const data = auditCreate.mock.calls.at(-1)![0].data;
      expect(data).toMatchObject({
        tenantId: "t1",
        action: "CONFIG_SNAPSHOT_RESTORE_FAILED",
        meta: { automatic: true, toPlanKey: HIGH },
      });
      expect(JSON.stringify(data.meta)).not.toContain(MSG);
    });

    it("a SAVEPOINT that cannot be opened means the tx is already aborted: it throws (alarm), never a silent skip", async () => {
      const { svc, snapshots } = build(true);
      raw.mockRejectedValueOnce(new Error("savepoint rejected"));

      await expect(runTransition(svc, up)).rejects.toThrow("savepoint rejected");
      expect(snapshots.restoreLatest).not.toHaveBeenCalled();
    });

    it("a failing ROLLBACK TO SAVEPOINT is logged, never thrown", async () => {
      const { svc, snapshots } = build(true);
      snapshots.restoreLatest.mockRejectedValueOnce(new Error("boom"));
      raw.mockResolvedValueOnce(1).mockRejectedValueOnce(new Error("rollback failed"));

      await expect(runTransition(svc, up)).resolves.toEqual({ action: "restore", restore: null });
    });

    it("a restore abandoned for exceeding its budget is rolled back to the savepoint and the upgrade carries on", async () => {
      const { svc, snapshots } = build(true);
      snapshots.restoreLatest.mockRejectedValueOnce(new RestoreBudgetExceededError("4 s"));

      const out = await runTransition(svc, up);

      expect(out).toEqual({ action: "restore", restore: null });
      expect(sqlOf()).toEqual([
        "SAVEPOINT config_snapshot_restore",
        "ROLLBACK TO SAVEPOINT config_snapshot_restore",
        "SAVEPOINT config_snapshot_alarm",
        "RELEASE SAVEPOINT config_snapshot_alarm",
      ]);
      // ... and a failure is FINDABLE: an audit row (name/code only, never the raw message).
      const data = auditCreate.mock.calls.at(-1)![0].data;
      expect(data).toMatchObject({
        tenantId: "t1",
        action: "CONFIG_SNAPSHOT_RESTORE_FAILED",
        meta: { automatic: true, toPlanKey: HIGH },
      });
      expect(JSON.stringify(data.meta)).not.toContain(MSG);
    });

    it("an abandoned (over-budget) restore is flagged budgetExceeded in its alarm row", async () => {
      const { svc, snapshots } = build(true);
      snapshots.restoreLatest.mockRejectedValueOnce(new RestoreBudgetExceededError("3 s"));

      await runTransition(svc, up);

      expect(auditCreate.mock.calls.at(-1)![0].data.meta).toMatchObject({ budgetExceeded: true });
    });

    it("the alarm write cannot poison the upgrade: it runs in its own savepoint and a failure is swallowed", async () => {
      const { svc, snapshots } = build(true);
      snapshots.restoreLatest.mockRejectedValueOnce(new Error("boom"));
      auditCreate.mockRejectedValueOnce(new Error("audit down"));

      await expect(runTransition(svc, up)).resolves.toEqual({ action: "restore", restore: null });

      expect(sqlOf()).toContain("ROLLBACK TO SAVEPOINT config_snapshot_alarm");
    });

    it("a FAILED AUDIT write is non-fatal too — and rolls the restore back with it (no audit row, no restore)", async () => {
      const { svc } = build(true);
      auditCreate.mockRejectedValueOnce(new Error("audit insert failed"));

      const out = await runTransition(svc, up);

      expect(out).toEqual({ action: "restore", restore: null });
      expect(sqlOf()).toContain("ROLLBACK TO SAVEPOINT config_snapshot_restore");
    });

    it("the opposite for a DOWNGRADE: a failed snapshot still throws (fail closed) and uses no savepoint", async () => {
      const { svc, snapshots } = build(true);
      snapshots.snapshot.mockRejectedValueOnce(new Error("db down"));

      await expect(
        runTransition(svc, {
          tenantId: "t1",
          fromPlanKey: HIGH,
          toPlanKey: LOW,
          toPlanVersionId: null,
        }),
      ).rejects.toThrow("db down");
      expect(sqlOf()).toEqual([]);
    });
  });

  it("a failed downgrade snapshot throws a typed SnapshotFailedError carrying the tenant and the cause", async () => {
    const { svc, snapshots } = build(true);
    snapshots.snapshot.mockRejectedValueOnce(new Error("db down"));

    const err = await runTransition(svc, {
      tenantId: "t9",
      fromPlanKey: HIGH,
      toPlanKey: LOW,
      toPlanVersionId: null,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(SnapshotFailedError);
    expect(err.tenantId).toBe("t9");
    expect(err.message).toContain("db down");
  });

  describe("invalidateCaches — an automatic restore is visible immediately, not after the 30 s TTL", () => {
    it("drops the resolver, override and config-mode caches of THAT tenant when the hook was active", async () => {
      const { svc, caches } = build(true);
      const prepared = await svc.prepare({
        tenantId: "t7",
        fromPlanKey: LOW,
        toPlanKey: HIGH,
        toPlanVersionId: null,
      });

      svc.invalidateCaches("t7", prepared);

      expect(caches.authority.invalidate).toHaveBeenCalledWith("t7");
      expect(caches.overrides.invalidate).toHaveBeenCalledWith("t7");
      expect(caches.configStore.invalidateTenant).toHaveBeenCalledWith("t7");
    });

    it("never throws (the cron's per-tenant catch rethrows) and one failing cache does not leave the others stale", async () => {
      const { svc, caches } = build(true);
      const prepared = await svc.prepare({
        tenantId: "t7",
        fromPlanKey: LOW,
        toPlanKey: HIGH,
        toPlanVersionId: null,
      });
      caches.authority.invalidate.mockImplementation(() => {
        throw new Error("boom");
      });
      // The swallow must stay LOUD (the only operator signal is this log line): a refactor that
      // makes it silent has to fail here.
      const errorSpy = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);

      try {
        expect(() => svc.invalidateCaches("t7", prepared)).not.toThrow();
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining("resolver cache for tenant t7"),
        );
      } finally {
        errorSpy.mockRestore();
      }

      expect(caches.overrides.invalidate).toHaveBeenCalledWith("t7");
      expect(caches.configStore.invalidateTenant).toHaveBeenCalledWith("t7");
    });

    it("touches NOTHING when the flag is off (or there was no transition) — flag-off behaviour is unchanged", async () => {
      const { svc, caches } = build(false);
      const prepared = await svc.prepare({
        tenantId: "t7",
        fromPlanKey: LOW,
        toPlanKey: HIGH,
        toPlanVersionId: null,
      });

      svc.invalidateCaches("t7", prepared);
      svc.invalidateCaches("t7", null);
      svc.invalidateCaches("t7", undefined);

      expect(caches.authority.invalidate).not.toHaveBeenCalled();
      expect(caches.overrides.invalidate).not.toHaveBeenCalled();
      expect(caches.configStore.invalidateTenant).not.toHaveBeenCalled();
    });
  });

  describe("transactionOptions — a longer transaction budget ONLY while the flag is on", () => {
    it("returns the raised budget for an enabled transition", async () => {
      const { svc } = build(true);
      const prepared = await svc.prepare({
        tenantId: "t1",
        fromPlanKey: LOW,
        toPlanKey: HIGH,
        toPlanVersionId: null,
      });
      expect(svc.transactionOptions(prepared)).toBe(HOOK_TX_OPTIONS);
      expect(HOOK_TX_OPTIONS.timeout).toBeGreaterThan(5_000); // Prisma's default is 5 s
    });

    it("returns undefined when the flag is off, or there is no transition — the site's tx is untouched", async () => {
      const { svc } = build(false);
      const prepared = await svc.prepare({
        tenantId: "t1",
        fromPlanKey: LOW,
        toPlanKey: HIGH,
        toPlanVersionId: null,
      });
      expect(svc.transactionOptions(prepared)).toBeUndefined();
      expect(svc.transactionOptions(null)).toBeUndefined();
      expect(svc.transactionOptions(undefined)).toBeUndefined();
    });
  });

  it("the catalog is read BEFORE the transaction and only for an enabled upgrade", async () => {
    const { svc, catalog } = build(true);
    const up = { tenantId: "t1", fromPlanKey: LOW, toPlanKey: HIGH, toPlanVersionId: "v1" };

    await svc.prepare({ ...up, fromPlanKey: HIGH, toPlanKey: LOW }); // downgrade
    await svc.prepare({ ...up, fromPlanKey: HIGH, toPlanKey: HIGH }); // same rank
    await build(false).svc.prepare(up); // flag off
    expect(catalog.getVersionForTenant).not.toHaveBeenCalled();

    await svc.prepare(up);
    expect(catalog.getVersionForTenant).toHaveBeenCalledTimes(1);
  });

  it("a catalog failure never blocks the upgrade: the restore is skipped and logged", async () => {
    const { svc, snapshots, catalog } = build(true);
    catalog.getVersionForTenant.mockRejectedValueOnce(new Error("catalog unseeded"));

    const out = await runTransition(svc, {
      tenantId: "t1",
      fromPlanKey: LOW,
      toPlanKey: HIGH,
      toPlanVersionId: null,
    });

    expect(out).toEqual({ action: "restore", restore: null });
    expect(snapshots.restoreLatest).not.toHaveBeenCalled();
  });

  it("an upgrade with nothing to restore reports restore: null", async () => {
    const { svc, snapshots } = build(true);
    snapshots.restoreLatest.mockResolvedValueOnce(null);

    expect(
      await runTransition(svc, {
        tenantId: "t1",
        fromPlanKey: LOW,
        toPlanKey: HIGH,
        toPlanVersionId: null,
      }),
    ).toEqual({ action: "restore", restore: null });
  });

  it.each([
    ["same plan", HIGH, HIGH],
    ["no previous plan", null, HIGH],
    ["undefined previous plan", undefined, HIGH],
    ["unknown previous plan", "legacy-nonsense", HIGH],
    ["unknown target plan", HIGH, "legacy-nonsense"],
  ])("%s: nothing happens", async (_label, from, to) => {
    const { svc, snapshots } = build(true);

    expect(
      await runTransition(svc, {
        tenantId: "t1",
        fromPlanKey: from as string | null | undefined,
        toPlanKey: to,
        toPlanVersionId: null,
      }),
    ).toEqual({ action: "none" });
    expect(snapshots.snapshot).not.toHaveBeenCalled();
    expect(snapshots.restoreLatest).not.toHaveBeenCalled();
  });
});
