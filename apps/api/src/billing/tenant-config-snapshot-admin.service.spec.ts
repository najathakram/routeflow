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

function build(
  opts: { tenant?: any; preview?: any; restore?: any; listed?: any[]; audits?: any[] } = {},
) {
  const tx = { tag: "tx" };
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
    auditLog: { findMany: jest.fn().mockResolvedValue(opts.audits ?? []) },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  };
  const planAllows = jest.fn().mockReturnValue(true);
  const transitions = { planAllowsFor: jest.fn().mockResolvedValue(planAllows) };
  const snapshots = {
    list: jest.fn().mockResolvedValue(opts.listed ?? []),
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

  describe("list() attaches the restore report from the AUDIT TRAIL (decision 3, no migration)", () => {
    const row = (id: string, over: any = {}) => ({
      id,
      restoredAt: null,
      restoredToPlanKey: null,
      ...over,
    });
    const audit = (snapshotId: string, report: any, automatic = true) => ({
      meta: { snapshotId, automatic, report },
    });

    it("a restored snapshot carries the counts of the restore that applied it", async () => {
      const { svc, prisma } = build({
        listed: [row("s1", { restoredAt: NOW, restoredToPlanKey: HIGH })],
        audits: [audit("s1", { restored: 3, skipped: 1, keptNewer: 2, unchanged: 0 })],
      });

      const out = await svc.list("t1");

      expect(out[0].restoreReport).toEqual({
        restored: 3,
        skipped: 1,
        keptNewer: 2,
        unchanged: 0,
        automatic: true,
      });
      expect(prisma.auditLog.findMany.mock.calls[0][0].where).toMatchObject({
        tenantId: "t1",
        action: "CONFIG_SNAPSHOT_RESTORED",
      });
    });

    it("a manual restore is reported as not automatic; the NEWEST row for a snapshot wins", async () => {
      const { svc } = build({
        listed: [row("s1", { restoredAt: NOW, restoredToPlanKey: HIGH })],
        audits: [
          audit("s1", { restored: 9, skipped: 0, keptNewer: 0, unchanged: 0 }, false), // newest (desc)
          audit("s1", { restored: 1, skipped: 0, keptNewer: 0, unchanged: 0 }, true),
        ],
      });

      expect((await svc.list("t1"))[0].restoreReport).toMatchObject({
        restored: 9,
        automatic: false,
      });
    });

    it("a restored snapshot with no audit row (restored before the report existed) has restoreReport: null", async () => {
      const { svc } = build({ listed: [row("s1", { restoredAt: NOW, restoredToPlanKey: HIGH })] });
      expect((await svc.list("t1"))[0].restoreReport).toBeNull();
    });

    it("tolerates a malformed audit meta instead of throwing", async () => {
      const { svc } = build({
        listed: [row("s1", { restoredAt: NOW, restoredToPlanKey: HIGH })],
        audits: [{ meta: null }, { meta: { snapshotId: 5 } }, { meta: { snapshotId: "s1" } }],
      });
      expect((await svc.list("t1"))[0].restoreReport).toBeNull();
    });

    it("no restored snapshot (or only superseded ones) means NO audit query at all", async () => {
      const { svc, prisma } = build({
        listed: [row("s1"), row("s2", { restoredAt: NOW, restoredToPlanKey: "SUPERSEDED" })],
      });

      const out = await svc.list("t1");

      expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
      expect(out.every((r) => r.restoreReport === null)).toBe(true);
    });
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
      preview: {
        snapshotId: "s1",
        takenAt: TAKEN,
        planKey: HIGH,
        restoredAt: null,
        ageDays: 5,
        beyondAutoRestoreHorizon: false,
        plan,
      },
    });

    const view = await svc.preview("t1", "s1");

    expect(transitions.planAllowsFor).toHaveBeenCalledWith(HIGH, "v1"); // subscription key wins
    expect(snapshots.previewRestore.mock.calls[0][4]).toBe(planAllows);
    expect(view).toMatchObject({
      ageDays: 5,
      beyondAutoRestoreHorizon: false,
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

    const res = await svc.restoreNow("t1", "s1", NOW);

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
