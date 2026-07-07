import { MeterService } from "./meter.service";

function makeService(caps: {
  seats: number | null;
  routes: number | null;
  scans: number | null;
  msgs: number | null;
}) {
  const prisma = {
    user: { count: jest.fn().mockResolvedValue(3) },
    routeRun: { count: jest.fn().mockResolvedValue(2) },
    meterUsage: {
      findUnique: jest.fn().mockResolvedValue({ used: 5 }),
      upsert: jest.fn().mockResolvedValue({}),
    },
    tenantSubscription: { findUnique: jest.fn().mockResolvedValue(null) },
  } as any;
  const entitlements = { resolve: jest.fn().mockResolvedValue({ caps }) } as any;
  return { svc: new MeterService(prisma, entitlements), prisma };
}

const CAPS = { seats: 5, routes: 3, scans: 20, msgs: 200 };

describe("MeterService", () => {
  it("reads SEATS as a live user count", async () => {
    const { svc, prisma } = makeService(CAPS);
    const r = await svc.read("t1", "SEATS");
    expect(r).toMatchObject({ meter: "SEATS", used: 3, included: 5, remaining: 2, resetsAt: null });
    expect(prisma.user.count).toHaveBeenCalledWith({
      where: {
        tenantId: "t1",
        deletedAt: null,
        status: "ACTIVE",
        role: { in: ["TENANT_ADMIN", "OPERATOR", "DRIVER"] },
      },
    });
  });

  it("reads a cycle meter (SCANS) from the current period bucket", async () => {
    const { svc } = makeService(CAPS);
    const r = await svc.read("t1", "SCANS");
    expect(r.used).toBe(5);
    expect(r.included).toBe(20);
    expect(r.remaining).toBe(15);
    expect(r.resetsAt).toBeInstanceOf(Date);
  });

  it("reports unlimited caps as null included / null remaining", async () => {
    const { svc } = makeService({ seats: null, routes: null, scans: null, msgs: 200 });
    const r = await svc.read("t1", "SCANS");
    expect(r.included).toBeNull();
    expect(r.remaining).toBeNull();
  });

  it("clamps remaining at 0 when over cap (never negative)", async () => {
    const prisma = {
      user: { count: jest.fn() },
      routeRun: { count: jest.fn() },
      meterUsage: { findUnique: jest.fn().mockResolvedValue({ used: 25 }), upsert: jest.fn() },
      tenantSubscription: { findUnique: jest.fn().mockResolvedValue(null) },
    } as any;
    const entitlements = { resolve: jest.fn().mockResolvedValue({ caps: CAPS }) } as any;
    const svc = new MeterService(prisma, entitlements);
    const r = await svc.read("t1", "SCANS");
    expect(r.used).toBe(25);
    expect(r.remaining).toBe(0);
  });

  it("increments a cycle meter via upsert", async () => {
    const { svc, prisma } = makeService(CAPS);
    await svc.increment("t1", "SCANS", 1);
    expect(prisma.meterUsage.upsert).toHaveBeenCalledTimes(1);
    const arg = prisma.meterUsage.upsert.mock.calls[0][0];
    expect(arg.create.used).toBe(1);
    expect(arg.update).toEqual({ used: { increment: 1 } });
  });

  it("ignores increments for live meters (SEATS/ROUTES)", async () => {
    const { svc, prisma } = makeService(CAPS);
    await svc.increment("t1", "SEATS", 1);
    await svc.increment("t1", "ROUTES", 1);
    expect(prisma.meterUsage.upsert).not.toHaveBeenCalled();
  });

  it("ignores non-positive increments (never decrements a monotonic meter)", async () => {
    const { svc, prisma } = makeService(CAPS);
    await svc.increment("t1", "SCANS", -5);
    await svc.increment("t1", "SCANS", 0);
    await svc.increment("t1", "SCANS", NaN);
    expect(prisma.meterUsage.upsert).not.toHaveBeenCalled();
  });

  it("never throws when the meter write fails (metering must not block the flow)", async () => {
    const { svc, prisma } = makeService(CAPS);
    prisma.meterUsage.upsert.mockRejectedValueOnce(new Error("db down"));
    await expect(svc.increment("t1", "SCANS", 1)).resolves.toBeUndefined();
  });
});
