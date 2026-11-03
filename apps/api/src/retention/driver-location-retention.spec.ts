import { Logger } from "@nestjs/common";
import { DriverLocationRetentionService } from "./driver-location-retention.service";
import { RETENTION_MAX_ROWS_PER_RUN } from "./retention-run";
import { parseRetentionSwitch, RetentionSwitchService } from "./retention-switch.service";

const NOW = new Date("2026-11-02T12:00:00.000Z");

function make(opts: {
  mode?: "report" | "enforce";
  tenants?: { id: string; retentionHoldAt: Date | null }[];
  groupBy?: jest.Mock;
  findMany?: jest.Mock;
  deleteMany?: jest.Mock;
  audit?: jest.Mock;
  noTenantRows?: number;
}) {
  const groupBy = opts.groupBy ?? jest.fn(async () => [{ driverId: "d1", _count: { _all: 1 } }]);
  const queue = [["p1"]];
  const findMany =
    opts.findMany ?? jest.fn(async () => (queue.shift() ?? []).map((id) => ({ id })));
  const deleteMany =
    opts.deleteMany ?? jest.fn(async (a: any) => ({ count: a.where.id.in.length }));
  const audit = opts.audit ?? jest.fn(async () => ({}));
  const count = jest.fn(async () => opts.noTenantRows ?? 0);
  const prisma = {
    tenant: {
      findMany: jest.fn(async () => opts.tenants ?? [{ id: "t1", retentionHoldAt: null }]),
    },
    driverLocation: { groupBy, findMany, deleteMany, count },
    auditLog: { create: audit },
  } as any;
  const switches = { modeOf: jest.fn(async () => opts.mode ?? "enforce") } as any;
  return {
    job: new DriverLocationRetentionService(prisma, switches),
    groupBy,
    findMany,
    deleteMany,
    audit,
    count,
  };
}

describe("SA-1083: the retention switch", () => {
  it("enforces only on a stored enforced: true", () => {
    expect(parseRetentionSwitch('{"enforced":true}')).toBe("enforce");
    expect(parseRetentionSwitch(' {"enforced":true,"by":"x"} ')).toBe("enforce");
    for (const raw of [
      null,
      undefined,
      "",
      "true",
      "1",
      "[true]",
      "{bad",
      '{"enforced":false}',
      '{"enforced":"true"}',
      '{"enforced":1}',
    ]) {
      expect(parseRetentionSwitch(raw)).toBe("report");
    }
  });

  it("RT-11: a failed read reports", async () => {
    jest.spyOn(Logger.prototype, "error").mockImplementationOnce(() => undefined);
    const prisma = { $queryRaw: jest.fn().mockRejectedValue(new Error("down")) } as any;
    await expect(new RetentionSwitchService(prisma).modeOf("k")).resolves.toBe("report");
  });

  it("a missing key reports", async () => {
    const prisma = { $queryRaw: jest.fn().mockResolvedValue([]) } as any;
    await expect(new RetentionSwitchService(prisma).modeOf("k")).resolves.toBe("report");
  });
});

describe("SA-1083: DriverLocationRetentionService", () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it("report-only never reaches a delete, and it never selects ids to delete", async () => {
    const { job, findMany, deleteMany } = make({ mode: "report" });
    const out = await job.run(NOW);
    expect(out).toMatchObject({ mode: "report", due: 1, deleted: 0 });
    expect(findMany).not.toHaveBeenCalled();
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it("the cutoff is exactly 90 days, on both dates", async () => {
    const { job, groupBy } = make({});
    await job.run(NOW);
    const cutoff = new Date(NOW.getTime() - 90 * 86_400_000);
    expect(groupBy.mock.calls[0][0].where).toEqual({
      tenantId: "t1",
      OR: [{ recordedAt: { lt: cutoff } }, { createdAt: { lt: cutoff } }],
    });
  });

  it("every delete carries the tenant, the driver, the ids and the hold test", async () => {
    const { job, deleteMany } = make({});
    await job.run(NOW);
    expect(deleteMany.mock.calls[0][0].where).toEqual({
      tenantId: "t1",
      driverId: "d1",
      id: { in: ["p1"] },
      tenant: { retentionHoldAt: null },
    });
  });

  it("a hold set mid-run stops the tenant: a delete that removes nothing doesn't select again", async () => {
    const findMany = jest.fn(async () => [{ id: "p1" }]);
    const deleteMany = jest.fn(async () => ({ count: 0 }));
    const { job } = make({ findMany, deleteMany });
    const out = await job.run(NOW);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(deleteMany).toHaveBeenCalledTimes(1);
    expect(out.deleted).toBe(0);
  });

  it("a held tenant reaches no select and no delete", async () => {
    const { job, findMany, deleteMany } = make({
      tenants: [{ id: "t1", retentionHoldAt: NOW }],
    });
    const out = await job.run(NOW);
    expect(findMany).not.toHaveBeenCalled();
    expect(deleteMany).not.toHaveBeenCalled();
    expect(out).toMatchObject({ due: 0, heldRows: 1 });
  });

  it("one run stops at the cap across tenants and says so", async () => {
    const huge = RETENTION_MAX_ROWS_PER_RUN + 10;
    const groupBy = jest.fn(async () => [{ driverId: "d1", _count: { _all: huge } }]);
    const findMany = jest.fn(async (a: any) =>
      Array.from({ length: a.take }, (_, i) => ({ id: `p${i}` })),
    );
    const { job } = make({
      groupBy,
      findMany,
      tenants: [
        { id: "t1", retentionHoldAt: null },
        { id: "t2", retentionHoldAt: null },
      ],
    });
    const out = await job.run(NOW);
    expect(out.deleted).toBe(RETENTION_MAX_ROWS_PER_RUN);
    expect(out.capped).toBe(true);
    expect(out.perTenant.t2).toEqual({ due: huge, deleted: 0, held: false });
  });

  it("one tenant's failure is counted, keeps what it deleted, and the next tenant still runs", async () => {
    const deleteMany = jest
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue({ count: 1 });
    const queue = [["a"], ["b"], ["c"]];
    const findMany = jest.fn(async () => (queue.shift() ?? []).map((id) => ({ id })));
    const { job } = make({
      deleteMany,
      findMany,
      tenants: [
        { id: "t1", retentionHoldAt: null },
        { id: "t2", retentionHoldAt: null },
      ],
    });
    const out = await job.run(NOW);
    expect(out.failedTenants).toBe(1);
    expect(out.perTenant.t1.deleted).toBe(1);
    expect(out.perTenant.t2.deleted).toBe(1);
    expect(out.deleted).toBe(2);
  });

  it("RT-5: points with no tenant are counted and reach no delete", async () => {
    const { job, deleteMany, count } = make({ tenants: [], noTenantRows: 3 });
    const out = await job.run(NOW);
    expect(out.noTenantRows).toBe(3);
    expect((count.mock.calls as any[][])[0]![0].where.tenantId).toBeNull();
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it("a failed audit write doesn't fail the run", async () => {
    const audit = jest.fn().mockRejectedValue(new Error("down"));
    const { job } = make({ audit });
    await expect(job.run(NOW)).resolves.toMatchObject({ deleted: 1 });
  });

  it("the audit row holds counts and ids only", async () => {
    const { job, audit } = make({});
    await job.run(NOW);
    const data = audit.mock.calls[0][0].data;
    expect(data.tenantId).toBeUndefined();
    expect(data.meta).toEqual({
      mode: "enforce",
      cutoff: new Date(NOW.getTime() - 90 * 86_400_000).toISOString(),
      due: 1,
      deleted: 1,
      heldRows: 0,
      noTenantRows: 0,
      failedTenants: 0,
      capped: false,
      perTenant: { t1: { due: 1, deleted: 1, held: false } },
    });
  });
});
