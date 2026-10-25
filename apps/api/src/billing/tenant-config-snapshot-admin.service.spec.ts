import { ConflictException, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { FEATURE_REGISTRY } from "./feature-registry";
import { PLAN_KEYS } from "./plan-catalog.constants";
import { TenantConfigSnapshotAdminService } from "./tenant-config-snapshot-admin.service";
import { TenantConfigSnapshotService } from "./tenant-config-snapshot.service";

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
    auditLog: { findMany: jest.fn().mockResolvedValue([]) },
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
            supersededSnapshots: 0,
            held: [],
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

  it("list() never queries the audit trail when nothing is restored", async () => {
    const { svc, snapshots, prisma } = build();
    snapshots.list.mockResolvedValueOnce([{ id: "s1", restoredAt: null }]);
    const rows = await svc.list("t1");
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
    expect(rows[0].restoreReport).toBeNull();
  });

  it("list() reads the restore report back from the row's own audit entry (no migration)", async () => {
    const { svc, snapshots, prisma } = build();
    snapshots.list.mockResolvedValueOnce([
      { id: "s1", restoredAt: TAKEN, restoredToPlanKey: HIGH },
    ]);
    prisma.auditLog.findMany.mockResolvedValueOnce([
      {
        meta: {
          automatic: false,
          snapshotId: "s1",
          report: { restored: 2, skipped: 1, keptNewer: 0, unchanged: 3 },
        },
      },
    ]);

    const rows = await svc.list("t1");

    // Bounded: the entityType/entityId pair hits AuditLog_entityType_entityId_idx (both writers
    // always set them), newest first, and one row per restored snapshot at most.
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith({
      where: {
        tenantId: "t1",
        action: "CONFIG_SNAPSHOT_RESTORED",
        entityType: "tenant",
        entityId: "t1",
      },
      select: { meta: true },
      orderBy: { createdAt: "desc" },
      take: 1,
    });
    expect(rows[0].restoreReport).toEqual({
      automatic: false,
      restored: 2,
      skipped: 1,
      keptNewer: 0,
      unchanged: 3,
    });
  });

  it("list() marks an automatic restore's report distinctly from a manual one", async () => {
    const { svc, snapshots, prisma } = build();
    snapshots.list.mockResolvedValueOnce([{ id: "s1", restoredAt: TAKEN }]);
    prisma.auditLog.findMany.mockResolvedValueOnce([
      {
        meta: {
          automatic: true,
          snapshotId: "s1",
          report: { restored: 1, skipped: 0, keptNewer: 0, unchanged: 0 },
        },
      },
    ]);

    const rows = await svc.list("t1");

    expect(rows[0].restoreReport?.automatic).toBe(true);
  });

  it("list() reports null for a restored row whose audit row is missing — never fabricates a count", async () => {
    const { svc, snapshots, prisma } = build();
    snapshots.list.mockResolvedValueOnce([{ id: "s1", restoredAt: TAKEN }]);
    prisma.auditLog.findMany.mockResolvedValueOnce([]); // no matching audit row at all

    const rows = await svc.list("t1");

    expect(rows[0].restoreReport).toBeNull();
  });

  it("list() takes at most one audit row per restored snapshot (take = restored count)", async () => {
    const { svc, snapshots, prisma } = build();
    snapshots.list.mockResolvedValueOnce([
      { id: "s1", restoredAt: TAKEN },
      { id: "s2", restoredAt: TAKEN },
      { id: "s3", restoredAt: null },
    ]);
    prisma.auditLog.findMany.mockResolvedValueOnce([]);
    await svc.list("t1");
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 2 }));
  });

  it.each([
    ["an empty report object", {}],
    ["a string count", { restored: "abc", skipped: 0, keptNewer: 0, unchanged: 0 }],
    ["a missing count", { restored: 1, skipped: 0, keptNewer: 0 }],
    ["a NaN count", { restored: Number.NaN, skipped: 0, keptNewer: 0, unchanged: 0 }],
    ["an Infinity count", { restored: 1, skipped: Infinity, keptNewer: 0, unchanged: 0 }],
    ["a numeric string", { restored: "2", skipped: 0, keptNewer: 0, unchanged: 0 }],
    ["a negative count", { restored: -1, skipped: 0, keptNewer: 0, unchanged: 0 }],
    ["a fractional count", { restored: 1, skipped: 1.5, keptNewer: 0, unchanged: 0 }],
    ["a non-object report", "abc"],
  ])("list() reports null, never made-up counts, for %s", async (_label, report) => {
    const { svc, snapshots, prisma } = build();
    snapshots.list.mockResolvedValueOnce([{ id: "s1", restoredAt: TAKEN }]);
    prisma.auditLog.findMany.mockResolvedValueOnce([
      { meta: { automatic: false, snapshotId: "s1", report } },
    ]);
    const rows = await svc.list("t1");
    expect(rows[0].restoreReport).toBeNull();
  });

  it("list() newest-wins: when two audit rows carry one snapshotId the first (newest) row is used", async () => {
    const { svc, snapshots, prisma } = build();
    snapshots.list.mockResolvedValueOnce([{ id: "s1", restoredAt: TAKEN }]);
    prisma.auditLog.findMany.mockResolvedValueOnce([
      {
        meta: { snapshotId: "s1", report: { restored: 9, skipped: 0, keptNewer: 0, unchanged: 0 } },
      },
      {
        meta: { snapshotId: "s1", report: { restored: 1, skipped: 0, keptNewer: 0, unchanged: 0 } },
      },
    ]);
    const rows = await svc.list("t1");
    expect(rows[0].restoreReport?.restored).toBe(9);
  });

  it("list() a malformed NEWEST audit row yields null, never an older duplicate's stale report", async () => {
    const { svc, snapshots, prisma } = build();
    snapshots.list.mockResolvedValueOnce([{ id: "s1", restoredAt: TAKEN }]);
    prisma.auditLog.findMany.mockResolvedValueOnce([
      {
        meta: {
          snapshotId: "s1",
          report: { restored: -1, skipped: 0, keptNewer: 0, unchanged: 0 },
        },
      },
      {
        meta: { snapshotId: "s1", report: { restored: 3, skipped: 0, keptNewer: 0, unchanged: 0 } },
      },
    ]);
    const rows = await svc.list("t1");
    expect(rows[0].restoreReport).toBeNull();
  });

  it("list() matches each restored row to its OWN audit entry, never mixing up two snapshots", async () => {
    const { svc, snapshots, prisma } = build();
    snapshots.list.mockResolvedValueOnce([
      { id: "s1", restoredAt: TAKEN },
      { id: "s2", restoredAt: TAKEN },
    ]);
    prisma.auditLog.findMany.mockResolvedValueOnce([
      {
        meta: {
          automatic: false,
          snapshotId: "s1",
          report: { restored: 1, skipped: 0, keptNewer: 0, unchanged: 0 },
        },
      },
      {
        meta: {
          automatic: true,
          snapshotId: "s2",
          report: { restored: 9, skipped: 9, keptNewer: 9, unchanged: 9 },
        },
      },
    ]);

    const rows = await svc.list("t1");

    expect(rows.find((r) => r.id === "s1")?.restoreReport).toMatchObject({ restored: 1 });
    expect(rows.find((r) => r.id === "s2")?.restoreReport).toMatchObject({ restored: 9 });
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

  it("row 640: the allow-list is built on the SUBSCRIPTION pin when it has one, else the tenant pin", async () => {
    const pinned = build({
      tenant: {
        plan: "STARTER",
        planVersionId: "v-tenant",
        subscription: { planKey: HIGH, planVersionId: "v-sub" },
      },
    });
    await pinned.svc.preview("t1", "s1");
    expect(pinned.transitions.planAllowsFor).toHaveBeenCalledWith(HIGH, "v-sub");
    const unpinned = build({
      tenant: {
        plan: "STARTER",
        planVersionId: "v-tenant",
        subscription: { planKey: HIGH, planVersionId: null },
      },
    });
    await unpinned.svc.preview("t1", "s1");
    expect(unpinned.transitions.planAllowsFor).toHaveBeenCalledWith(HIGH, "v-tenant");
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

  // #2226 / SA-386: list() reads the audit trail with `take = restoredIds.length`, exact only while
  // each restored snapshot has ONE audit row. The manual writer's side of that invariant: a second
  // restore of the same snapshot is refused (409) and writes no second audit row — whether the
  // first had already committed (the preview sees restoredAt) or they raced (the claim loses).
  it("#2226: a second restore of the same snapshot is refused and writes no second audit row", async () => {
    const { svc, tx, snapshots } = build();
    await svc.restoreNow("t1", "s1", "admin-1", NOW);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    snapshots.previewRestore.mockResolvedValueOnce({
      snapshotId: "s1",
      takenAt: TAKEN,
      planKey: HIGH,
      restoredAt: NOW, // the first restore committed
      plan: emptyPlan(),
    });
    await expect(svc.restoreNow("t1", "s1", "admin-1", NOW)).rejects.toThrow(
      "This snapshot was already restored",
    );
    expect(snapshots.restoreSnapshot).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it("#2226: a restore that loses the claim race after its preview is refused and writes no audit row", async () => {
    const { svc, tx } = build({ restore: null }); // the claim matched 0 rows: someone restored first
    await expect(svc.restoreNow("t1", "s1", "admin-1", NOW)).rejects.toThrow(
      "This snapshot was already restored",
    );
    expect(tx.auditLog.create).not.toHaveBeenCalled();
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

// ─── BO-13: through the REAL snapshot service over an in-memory tx, so the preview, the Restore now
// write, the held reporting and the "claimable until it completes" rule are proven end to end.
describe("TenantConfigSnapshotAdminService — a held delivery method (BO-13)", () => {
  const FM = "fulfilment_model";
  const T0 = new Date("2026-09-01T00:00:00.000Z");

  function buildReal(seed: { stored: string; snapshotMode: string; inTransit: number }) {
    const state = {
      inTransit: seed.inTransit,
      configs: [
        {
          id: "c-fm",
          tenantId: "t1",
          featureKey: FM,
          mode: seed.stored,
          settings: null,
          reason: "r",
          updatedById: null,
          updatedAt: T0,
        },
        {
          id: "c-other",
          tenantId: "t1",
          featureKey: CONFIG_KEY,
          mode: "stale",
          settings: null,
          reason: "r",
          updatedById: null,
          updatedAt: T0,
        },
      ] as any[],
      snapshot: {
        id: "s1",
        tenantId: "t1",
        planKey: HIGH,
        reason: "DOWNGRADE",
        takenAt: TAKEN,
        restoredAt: null as Date | null,
        restoredToPlanKey: null as string | null,
        payload: {
          version: 1,
          configs: [
            {
              featureKey: FM,
              mode: seed.snapshotMode,
              settings: null,
              reason: "r",
              updatedById: null,
            },
            {
              featureKey: CONFIG_KEY,
              mode: Object.keys(
                FEATURE_REGISTRY.find((f) => f.key === CONFIG_KEY)!.config!.modes,
              )[0],
              settings: null,
              reason: "r",
              updatedById: null,
            },
          ],
          overrides: [],
        },
      },
      audits: [] as any[],
    };
    const delegates = {
      order: { count: jest.fn(async () => state.inTransit) },
      tenantAddon: { findMany: jest.fn(async () => []) },
      tenantFeatureOverride: { findMany: async () => [] },
      tenantFeatureConfig: {
        findMany: async () => state.configs.map((c) => ({ ...c })),
        upsert: async () => undefined,
        updateMany: async ({ where, data }: any) => {
          const row = state.configs.find((c) => c.id === where.id);
          if (row) Object.assign(row, data, { updatedAt: NOW });
          return { count: row ? 1 : 0 };
        },
      },
      tenantFeatureConfigSnapshot: {
        findFirst: async ({ where }: any) =>
          where.restoredAt === null && state.snapshot.restoredAt !== null
            ? null
            : { ...state.snapshot },
        updateMany: async ({ where, data }: any) => {
          if (where.id) {
            if (state.snapshot.restoredAt !== where.restoredAt) return { count: 0 };
            Object.assign(state.snapshot, data);
            return { count: 1 };
          }
          return { count: 0 };
        },
      },
      auditLog: { create: jest.fn(async ({ data }: any) => state.audits.push(data)) },
    };
    const prisma = {
      ...delegates,
      tenant: {
        findUnique: jest.fn().mockResolvedValue({
          plan: "STARTER",
          planVersionId: null,
          subscription: { planKey: HIGH },
        }),
      },
      $transaction: jest.fn(async (fn: any) => fn(delegates)),
    };
    const svc = new TenantConfigSnapshotAdminService(
      prisma as never,
      new TenantConfigSnapshotService(),
      { planAllowsFor: jest.fn().mockResolvedValue(() => true) } as never,
      { invalidate: jest.fn() } as never,
      { invalidate: jest.fn() } as never,
      { invalidate: jest.fn() } as never,
    );
    return { svc, state, delegates, prisma };
  }

  it("preview lists the held row as skipped with CARRIER_IN_TRANSIT and does not offer to restore it", async () => {
    const { svc } = buildReal({ stored: "delivery", snapshotMode: "ship", inTransit: 2 });

    const view = await svc.preview("t1", "s1");

    expect(view.skipped).toEqual([
      { kind: "config", featureKey: FM, reason: "CARRIER_IN_TRANSIT" },
    ]);
    expect(view.willRestore.map((w) => w.featureKey)).toEqual([CONFIG_KEY]);
  });

  it("preview lists FULFILMENT_MODE_NEEDS_FLEET for own delivery on an account with no fleet", async () => {
    const { svc } = buildReal({ stored: "ship", snapshotMode: "delivery", inTransit: 0 });
    const view = await svc.preview("t1", "s1");
    expect(view.skipped).toEqual([
      { kind: "config", featureKey: FM, reason: "FULFILMENT_MODE_NEEDS_FLEET" },
    ]);
  });

  it("restoreNow restores the rest, returns held, leaves the snapshot claimable and audits the partial run on its own action", async () => {
    const { svc, state } = buildReal({ stored: "delivery", snapshotMode: "ship", inTransit: 2 });

    const res = await svc.restoreNow("t1", "s1", "admin-1", NOW);

    expect(res.held).toEqual([
      {
        kind: "fulfilment",
        featureKey: FM,
        from: "delivery",
        to: "ship",
        reason: "CARRIER_IN_TRANSIT",
        count: 2,
      },
    ]);
    expect(state.configs.find((c) => c.id === "c-fm")!.mode).toBe("delivery");
    expect(state.configs.find((c) => c.id === "c-other")!.mode).not.toBe("stale");
    expect(state.snapshot.restoredAt).toBeNull();
    expect(state.audits).toHaveLength(1);
    expect(state.audits[0]).toMatchObject({
      action: "CONFIG_SNAPSHOT_RESTORE_HELD",
      meta: {
        report: { skipped: 1 },
        held: [{ kind: "fulfilment", featureKey: FM, reason: "CARRIER_IN_TRANSIT" }],
      },
    });
  });

  it("a second restoreNow after the orders are delivered applies the held row and only THEN stamps the snapshot", async () => {
    const { svc, state } = buildReal({ stored: "delivery", snapshotMode: "ship", inTransit: 2 });
    await svc.restoreNow("t1", "s1", "admin-1", NOW);

    state.inTransit = 0; // delivered
    const res = await svc.restoreNow("t1", "s1", "admin-1", NOW);

    expect(res.held).toEqual([]);
    expect(state.configs.find((c) => c.id === "c-fm")!.mode).toBe("ship");
    expect(state.snapshot).toMatchObject({ restoredAt: NOW, restoredToPlanKey: HIGH });
    expect(state.audits.map((a) => a.action)).toEqual([
      "CONFIG_SNAPSHOT_RESTORE_HELD",
      "CONFIG_SNAPSHOT_RESTORED",
    ]);
    await expect(svc.restoreNow("t1", "s1", "admin-1", NOW)).rejects.toThrow(
      "This snapshot was already restored",
    );
  });
});
