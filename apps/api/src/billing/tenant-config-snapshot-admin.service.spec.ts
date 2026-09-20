import { ConflictException, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { FEATURE_REGISTRY } from "./feature-registry";
import { PLAN_KEYS } from "./plan-catalog.constants";
import { TenantConfigSnapshotAdminService } from "./tenant-config-snapshot-admin.service";

const HIGH = PLAN_KEYS[PLAN_KEYS.length - 1];
const LOW = PLAN_KEYS[0];
const CONFIG_KEY = FEATURE_REGISTRY.find((f) => f.config)!.key;
const PLAIN_KEY = FEATURE_REGISTRY.find((f) => !f.config)!.key;
const NOW = new Date("2026-09-20T00:00:00.000Z");
const TAKEN = new Date("2026-09-10T00:00:00.000Z");

const emptyPlan = () => ({
  configs: { create: [], update: [], unchanged: [], keptNewer: [], skipped: [] },
  overrides: { create: [], unchanged: [], keptNewer: [], skipped: [] },
});

function build(opts: { tenant?: any; preview?: any; restore?: any } = {}) {
  const tx = { tag: "tx", auditLog: { create: jest.fn().mockResolvedValue({}) } };
  const prisma = {
    tenant: {
      findUnique: jest
        .fn()
        .mockResolvedValue(
          opts.tenant === undefined
            ? { plan: "STARTER", planVersionId: "v1", subscription: { planKey: HIGH } }
            : opts.tenant,
        ),
    },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  };
  const planAllows = jest.fn().mockReturnValue(true);
  const transitions = { planAllowsFor: jest.fn().mockResolvedValue(planAllows) };
  const snapshots = {
    list: jest.fn().mockResolvedValue([]),
    previewRestore: jest
      .fn()
      .mockResolvedValue(
        opts.preview === undefined
          ? { snapshotId: "s1", takenAt: TAKEN, planKey: HIGH, restoredAt: null, plan: emptyPlan() }
          : opts.preview,
      ),
    restoreSnapshot: jest.fn().mockResolvedValue(
      opts.restore === undefined
        ? {
            snapshotId: "s1",
            takenAt: TAKEN,
            planKey: HIGH,
            report: { restored: 2, skipped: 1, keptNewer: 0, unchanged: 0 },
          }
        : opts.restore,
    ),
  };
  const authority = { invalidate: jest.fn() };
  const overrides = { invalidate: jest.fn() };
  const configStore = { invalidate: jest.fn() };
  const svc = new TenantConfigSnapshotAdminService(
    prisma as never,
    snapshots as never,
    transitions as never,
    authority as never,
    overrides as never,
    configStore as never,
  );
  return { svc, prisma, tx, snapshots, transitions, planAllows, authority, overrides, configStore };
}

describe("TenantConfigSnapshotAdminService (A2 step c)", () => {
  it("list() delegates to the snapshot service for that tenant", async () => {
    const { svc, snapshots, prisma } = build();
    await svc.list("t1");
    expect(snapshots.list).toHaveBeenCalledWith(prisma, "t1");
  });

  it("preview() judges the snapshot against the tenant's CURRENT plan and flattens the plan", async () => {
    const plan = emptyPlan();
    (plan.configs.create as any[]).push({ featureKey: CONFIG_KEY });
    (plan.overrides.create as any[]).push({ featureKey: PLAIN_KEY });
    (plan.configs.keptNewer as any[]).push("kept.config");
    (plan.overrides.skipped as any[]).push({
      featureKey: "gone.feature",
      reason: "UNKNOWN_FEATURE",
    });
    (plan.configs.unchanged as any[]).push("same.config");
    const { svc, transitions, snapshots, planAllows } = build({
      preview: { snapshotId: "s1", takenAt: TAKEN, planKey: HIGH, restoredAt: null, plan },
    });

    const view = await svc.preview("t1", "s1");

    expect(transitions.planAllowsFor).toHaveBeenCalledWith(HIGH, "v1"); // subscription key wins
    expect(snapshots.previewRestore.mock.calls[0][4]).toBe(planAllows);
    expect(view).toMatchObject({
      snapshotId: "s1",
      currentPlanKey: HIGH,
      willRestore: [
        { kind: "config", featureKey: CONFIG_KEY },
        { kind: "override", featureKey: PLAIN_KEY },
      ],
      keptNewer: ["kept.config"],
      skipped: [{ kind: "override", featureKey: "gone.feature", reason: "UNKNOWN_FEATURE" }],
      unchangedCount: 1,
    });
  });

  it("a tenant with no subscription planKey is judged on its legacy Tenant.plan", async () => {
    const { svc, transitions } = build({
      tenant: { plan: "STARTER", planVersionId: null, subscription: null },
    });
    await svc.preview("t1", "s1");
    expect(transitions.planAllowsFor).toHaveBeenCalledWith(expect.any(String), null);
  });

  it.each([
    ["an unknown tenant", { tenant: null }, NotFoundException],
    ["an unknown snapshot", { preview: null }, NotFoundException],
    [
      "an unreadable payload",
      {
        preview: { snapshotId: "s1", takenAt: TAKEN, planKey: HIGH, restoredAt: null, plan: null },
      },
      UnprocessableEntityException,
    ],
  ])("preview() maps %s to the right HTTP error", async (_l, opts, Err) => {
    await expect(build(opts as any).svc.preview("t1", "s1")).rejects.toBeInstanceOf(Err);
  });

  it("restoreNow() previews and restores in ONE transaction, stamps the CURRENT plan, then drops the caches", async () => {
    const plan = emptyPlan();
    (plan.configs.create as any[]).push({ featureKey: CONFIG_KEY });
    (plan.configs.update as any[]).push({ id: "c1", entry: { featureKey: "second.config" } });
    const { svc, prisma, tx, snapshots, authority, overrides, configStore } = build({
      preview: { snapshotId: "s1", takenAt: TAKEN, planKey: HIGH, restoredAt: null, plan },
    });

    const res = await svc.restoreNow("t1", "s1", "admin-1", NOW);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(snapshots.previewRestore.mock.calls[0][0]).toBe(tx);
    expect(snapshots.restoreSnapshot.mock.calls[0].slice(0, 5)).toEqual([
      tx,
      "t1",
      "s1",
      HIGH,
      NOW,
    ]);
    expect(res).toMatchObject({ snapshotId: "s1", restoredToPlanKey: HIGH });
    expect(authority.invalidate).toHaveBeenCalledWith("t1");
    expect(overrides.invalidate).toHaveBeenCalledWith("t1");
    expect(configStore.invalidate.mock.calls).toEqual([
      ["t1", CONFIG_KEY],
      ["t1", "second.config"],
    ]);
  });

  it("restoreNow() runs in a transaction with an explicit 30 s budget (the admin restore is unbounded, so Prisma's 5 s default would P2028 a large snapshot)", async () => {
    const { svc, prisma } = build();

    await svc.restoreNow("t1", "s1", "admin-1", NOW);

    expect(prisma.$transaction.mock.calls[0][1]).toEqual({ timeout: 30_000, maxWait: 5_000 });
  });

  it("restoreNow() writes its audit row (actor + report) INSIDE the restore transaction", async () => {
    const { svc, tx } = build();

    await svc.restoreNow("t1", "s1", "admin-1", NOW);

    const data = tx.auditLog.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      tenantId: "t1",
      userId: "admin-1",
      action: "CONFIG_SNAPSHOT_RESTORED",
      entityType: "tenant",
      entityId: "t1",
      meta: { platformAdmin: true, automatic: false, snapshotId: "s1", restoredToPlanKey: HIGH },
    });
  });

  it("if the audit write fails the whole restore fails and no cache is dropped (never a restore with no trail)", async () => {
    const { svc, tx, authority } = build();
    tx.auditLog.create.mockRejectedValueOnce(new Error("audit down"));

    await expect(svc.restoreNow("t1", "s1", "admin-1", NOW)).rejects.toThrow("audit down");

    expect(authority.invalidate).not.toHaveBeenCalled();
  });

  it("restoreNow() refuses an already-restored snapshot with 409 and writes nothing", async () => {
    const { svc, snapshots, authority } = build({
      preview: {
        snapshotId: "s1",
        takenAt: TAKEN,
        planKey: HIGH,
        restoredAt: NOW,
        plan: emptyPlan(),
      },
    });

    await expect(svc.restoreNow("t1", "s1")).rejects.toBeInstanceOf(ConflictException);
    expect(snapshots.restoreSnapshot).not.toHaveBeenCalled();
    expect(authority.invalidate).not.toHaveBeenCalled();
  });

  it("restoreNow() that loses a race (restoreSnapshot -> null) is a 409, and no cache is dropped", async () => {
    const { svc, authority } = build({ restore: null });

    await expect(svc.restoreNow("t1", "s1")).rejects.toBeInstanceOf(ConflictException);
    expect(authority.invalidate).not.toHaveBeenCalled();
  });

  it("restoreNow() maps an unknown snapshot to 404 and an unreadable payload to 422", async () => {
    await expect(build({ preview: null }).svc.restoreNow("t1", "x")).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      build({
        preview: { snapshotId: "s1", takenAt: TAKEN, planKey: LOW, restoredAt: null, plan: null },
      }).svc.restoreNow("t1", "s1"),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });
});
