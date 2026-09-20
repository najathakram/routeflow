import { FEATURE_REGISTRY } from "./feature-registry";
import { PLAN_KEYS } from "./plan-catalog.constants";
import { PlanTransitionConfigService } from "./plan-transition-config.service";

// Keys and plans come from the live registry/catalog (L-206), never re-typed here.
const LOW = PLAN_KEYS[0];
const HIGH = PLAN_KEYS[PLAN_KEYS.length - 1];
const planFlagKeys = FEATURE_REGISTRY.filter(
  (f) => f.gate.via === "RequirePlanFlag" && !f.defaultGranted,
).map((f) => f.key);
const IN_PLAN = planFlagKeys[0];
const NOT_IN_PLAN = planFlagKeys[1];
const SKU_GRANTED = planFlagKeys[2];
const ADDON_KEYED = FEATURE_REGISTRY.find((f) => f.gate.via === "RequireAddon")!.key;
const DEFAULT_GRANTED = FEATURE_REGISTRY.find((f) => f.defaultGranted)!.key;

const auditCreate = jest.fn().mockResolvedValue({});
const TX = { tag: "tx", auditLog: { create: auditCreate } } as never;
const ACTOR = { id: "u1", name: "Admin" };

function build(enabled: boolean) {
  auditCreate.mockClear();
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
  const svc = new PlanTransitionConfigService(flag as never, snapshots as never, catalog as never);
  return { svc, snapshots, catalog, flag };
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
