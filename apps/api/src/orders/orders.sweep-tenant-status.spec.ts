import { buildOrdersService } from "./testing/orders-service-harness";

/**
 * SA-776 (row 382): the pending-order sweep (the hourly cron and the boot run share `sweepAllPendingOrders`)
 * CHANGES business records - it merges PENDING orders and deletes the losers - so it is a TRANSACTIONAL job: a
 * tenant that is not TRIAL / ACTIVE (READ_ONLY, SUSPENDED, CANCELLED) gets no automated merge. Red against master,
 * where every tenant's PENDING orders were merged regardless of status.
 */
describe("sweepAllPendingOrders - tenant status (SA-776)", () => {
  let h: Awaited<ReturnType<typeof buildOrdersService>>;

  beforeEach(async () => {
    h = await buildOrdersService();
    jest.spyOn((h.service as any).logger, "log").mockImplementation(() => undefined);
    jest.spyOn((h.service as any).logger, "warn").mockImplementation(() => undefined);
  });

  const groups = (...tenants: string[]) => {
    h.prisma.order.groupBy
      .mockResolvedValueOnce(
        tenants.map((tenantId, i) => ({
          customerId: `cust-${tenantId}`,
          tenantId,
          _count: { _all: 2 + i },
        })),
      )
      .mockResolvedValueOnce([]); // the null-tenant pass
  };

  it.each(["READ_ONLY", "SUSPENDED", "CANCELLED"])(
    "skips a %s tenant's PENDING orders and still merges an ACTIVE tenant's",
    async (status) => {
      const merge = jest
        .spyOn(h.service, "mergeAllPendingForCustomer")
        .mockImplementation(async () => "winner" as never);
      groups("tenant-a", "tenant-b");
      h.prisma.tenant.findMany.mockResolvedValue([
        { id: "tenant-a", status },
        { id: "tenant-b", status: "ACTIVE" },
      ]);

      const result = await h.service.sweepAllPendingOrders();

      expect(merge).toHaveBeenCalledTimes(1);
      expect(merge).toHaveBeenCalledWith("cust-tenant-b", {}, expect.anything());
      expect(result).toEqual(expect.objectContaining({ customers: 1, merged: 1 }));
      // ONE status read for the whole sweep, over exactly the candidate tenants
      expect(h.prisma.tenant.findMany).toHaveBeenCalledTimes(1);
      expect(h.prisma.tenant.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: { in: ["tenant-a", "tenant-b"] } } }),
      );
    },
  );

  it.each(["TRIAL", "ACTIVE"])(
    "still sweeps a %s tenant (the predicate is TRIAL + ACTIVE)",
    async (status) => {
      const merge = jest
        .spyOn(h.service, "mergeAllPendingForCustomer")
        .mockImplementation(async () => "winner" as never);
      groups("tenant-a");
      h.prisma.tenant.findMany.mockResolvedValue([{ id: "tenant-a", status }]);

      await h.service.sweepAllPendingOrders();

      expect(merge).toHaveBeenCalledTimes(1);
    },
  );

  it("a candidate whose tenant row cannot be read is skipped (fail closed: this job writes)", async () => {
    const merge = jest.spyOn(h.service, "mergeAllPendingForCustomer");
    groups("ghost");
    h.prisma.tenant.findMany.mockResolvedValue([]);

    const result = await h.service.sweepAllPendingOrders();

    expect(merge).not.toHaveBeenCalled();
    expect(result.customers).toBe(0);
  });

  it("no candidates: no status read at all", async () => {
    h.prisma.order.groupBy.mockResolvedValue([]);

    await h.service.sweepAllPendingOrders();

    expect(h.prisma.tenant.findMany).not.toHaveBeenCalled();
  });

  it("the boot sweep is the same method: onApplicationBootstrap goes through the gate", async () => {
    const merge = jest
      .spyOn(h.service, "mergeAllPendingForCustomer")
      .mockImplementation(async () => "winner" as never);
    groups("tenant-a");
    h.prisma.tenant.findMany.mockResolvedValue([{ id: "tenant-a", status: "READ_ONLY" }]);
    const sweep = jest.spyOn(h.service, "sweepAllPendingOrders");

    h.service.onApplicationBootstrap();
    await sweep.mock.results[0].value;

    expect(sweep).toHaveBeenCalledTimes(1);
    expect(merge).not.toHaveBeenCalled();
  });
});
