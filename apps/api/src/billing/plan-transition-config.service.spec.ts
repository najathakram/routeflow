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

const TX = { tag: "tx" } as never;
const ACTOR = { id: "u1", name: "Admin" };

function build(flag: string | undefined) {
  const snapshots = {
    snapshot: jest.fn().mockResolvedValue({ id: "snap-1", takenAt: new Date() }),
    restoreLatest: jest.fn().mockResolvedValue({
      snapshotId: "snap-0",
      takenAt: new Date(),
      planKey: HIGH,
      report: { restored: 2, skipped: 0, keptNewer: 0, unchanged: 0 },
    }),
  };
  const catalog = {
    getVersionForTenant: jest.fn().mockResolvedValue({
      definitions: [{ planKey: HIGH, featureFlags: [IN_PLAN] }],
      // An add-on SKU grants a plan flag to a tenant on ANY plan (grantsFlags), like MSRP/forecasting.
      addonSkus: [{ sku: "SOME_SKU", grantsFlags: [SKU_GRANTED] }],
    }),
  };
  const config = { get: (k: string) => (k === "ENTITLEMENT_CONFIG_SNAPSHOT" ? flag : undefined) };
  const svc = new PlanTransitionConfigService(
    config as never,
    snapshots as never,
    catalog as never,
  );
  return { svc, snapshots, catalog };
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
  it.each([undefined, "", "off", "0", "false", "yes please"])(
    "flag %p is OFF: nothing is read or written on a downgrade or an upgrade",
    async (flag) => {
      const { svc, snapshots, catalog } = build(flag);
      expect(svc.isEnabled()).toBe(false);

      expect(
        await runTransition(svc, {
          tenantId: "t1",
          fromPlanKey: HIGH,
          toPlanKey: LOW,
          toPlanVersionId: null,
        }),
      ).toEqual({ action: "none" });
      expect(
        await runTransition(svc, {
          tenantId: "t1",
          fromPlanKey: LOW,
          toPlanKey: HIGH,
          toPlanVersionId: null,
        }),
      ).toEqual({ action: "none" });
      expect(snapshots.snapshot).not.toHaveBeenCalled();
      expect(snapshots.restoreLatest).not.toHaveBeenCalled();
      expect(catalog.getVersionForTenant).not.toHaveBeenCalled();
    },
  );

  it.each(["on", "ON", " 1 ", "true"])("flag %p turns it on", (flag) => {
    expect(build(flag).svc.isEnabled()).toBe(true);
  });

  it("a downgrade snapshots the plan being LEFT, inside the caller's tx, once", async () => {
    const { svc, snapshots } = build("on");
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
    const { svc, snapshots } = build("on");
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
    const { svc, snapshots, catalog } = build("on");

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

  it("the catalog is read BEFORE the transaction and only for an enabled upgrade", async () => {
    const { svc, catalog } = build("on");
    const up = { tenantId: "t1", fromPlanKey: LOW, toPlanKey: HIGH, toPlanVersionId: "v1" };

    await svc.prepare({ ...up, fromPlanKey: HIGH, toPlanKey: LOW }); // downgrade
    await svc.prepare({ ...up, fromPlanKey: HIGH, toPlanKey: HIGH }); // same rank
    await build(undefined).svc.prepare(up); // flag off
    expect(catalog.getVersionForTenant).not.toHaveBeenCalled();

    await svc.prepare(up);
    expect(catalog.getVersionForTenant).toHaveBeenCalledTimes(1);
  });

  it("a catalog failure never blocks the upgrade: the restore is skipped and logged", async () => {
    const { svc, snapshots, catalog } = build("on");
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
    const { svc, snapshots } = build("on");
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
    const { svc, snapshots } = build("on");

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
