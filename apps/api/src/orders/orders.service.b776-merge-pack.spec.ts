// The merge paths run inside a Postgres advisory lock (`common/db-locks.ts`, R3) — these specs
// exercise the merge FOLD's pack-grouping, not the lock, so run the critical section inline
// (mirrors orders.service.spec.ts's own mock).
jest.mock("../common/db-locks", () => ({
  ...jest.requireActual("../common/db-locks"),
  withAdvisoryLock: jest.fn(async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  })),
}));

import { buildOrdersService } from "./testing/orders-service-harness";

/**
 * B776 (CRITICAL, SA-101(1)) — `mergeAllPendingForCustomer`/`forceConsolidateCustomer` used to
 * re-split a merged line's combined piece count using the PRODUCT'S CURRENT live `unitsPerBox`,
 * while still billing at the OLD stored `unitPrice` (a per-box price at the OLD pack size). The
 * six pins the fix must satisfy, red-first against the pre-fix code (see the PR body for the
 * revert-probe output):
 *   1. 12 -> 6: the moved line stays 1 box/$36.
 *   2. made unboxed: it keeps the 12-pack at $36.
 *   3. 12 -> 24: no undercharge.
 *   4. packs 12 and 6: two lines.
 *   5. two 12s: one line.
 *   6. the sweep warns and counts.
 */
const box = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  productId: "prod-repack",
  qty: 12,
  boxes: 1,
  pieces: 0,
  unitsPerBox: 12,
  unitPrice: 36,
  subtotal: 36,
  status: "PENDING",
  priceType: "STANDARD",
  originalPrice: null,
  name: null,
  overrideReason: null,
  overriddenBy: null,
  trackedCategoryId: null,
  ...over,
});

describe("OrdersService merges — B776 pack-mismatch red-first pins (SA-101(1))", () => {
  let h: Awaited<ReturnType<typeof buildOrdersService>>;

  beforeEach(async () => {
    h = await buildOrdersService();
    h.prisma.orderItem.findMany.mockResolvedValue([]);
  });

  it("1. 12 -> 6: a moved (single-loser) line stays 1 box / $36, never re-split by the live 6-pack", async () => {
    h.prisma.order.findMany.mockResolvedValue([
      { id: "w1", customerId: "cust-1", status: "PENDING", lineItems: [] },
      { id: "l1", customerId: "cust-1", status: "PENDING", lineItems: [box("ll1")] },
    ]);
    h.prisma.product.findMany.mockResolvedValue([{ id: "prod-repack", unitsPerBox: 6 }]);

    await h.service.mergeAllPendingForCustomer("cust-1");

    const created = h.prisma.orderItem.create.mock.calls.find(
      (c: any) => c[0]?.data?.productId === "prod-repack",
    );
    expect(created![0].data).toMatchObject({ boxes: 1, pieces: 0, unitsPerBox: 12, subtotal: 36 });
  });

  it("2. product made unboxed: keeps the 12-pack at $36, never 12x overcharged", async () => {
    h.prisma.order.findMany.mockResolvedValue([
      { id: "w1", customerId: "cust-1", status: "PENDING", lineItems: [] },
      { id: "l1", customerId: "cust-1", status: "PENDING", lineItems: [box("ll1")] },
    ]);
    h.prisma.product.findMany.mockResolvedValue([{ id: "prod-repack", unitsPerBox: null }]);

    await h.service.mergeAllPendingForCustomer("cust-1");

    const created = h.prisma.orderItem.create.mock.calls.find(
      (c: any) => c[0]?.data?.productId === "prod-repack",
    );
    expect(created![0].data).toMatchObject({ boxes: 1, pieces: 0, unitsPerBox: 12, subtotal: 36 });
  });

  it("3. 12 -> 24: winner + loser agree at 12, no undercharge from the live 24-pack", async () => {
    // Both winner and loser were sold at pack 12 ($36/box). If re-split by the LIVE 24-pack,
    // the combined 24 pieces would wrongly land as 1 box of 24 = $36 (half the true $72).
    h.prisma.order.findMany.mockResolvedValue([
      { id: "w1", customerId: "cust-1", status: "PENDING", lineItems: [box("wl1")] },
      { id: "l1", customerId: "cust-1", status: "PENDING", lineItems: [box("ll1")] },
    ]);
    h.prisma.product.findMany.mockResolvedValue([{ id: "prod-repack", unitsPerBox: 24 }]);

    await h.service.mergeAllPendingForCustomer("cust-1");

    const upd = h.prisma.orderItem.update.mock.calls[0][0].data;
    expect(upd.boxes).toBe(2);
    expect(upd.pieces).toBe(0);
    expect(upd.unitsPerBox).toBe(12);
    expect(upd.subtotal).toBeCloseTo(72, 2);
    expect(upd.subtotal).not.toBeCloseTo(36, 2); // the undercharge this pin exists for
  });

  it("4. packs 12 and 6 disagree: TWO separate lines, never folded", async () => {
    h.prisma.order.findMany.mockResolvedValue([
      { id: "w1", customerId: "cust-1", status: "PENDING", lineItems: [] },
      {
        id: "l1",
        customerId: "cust-1",
        status: "PENDING",
        lineItems: [box("ll1", { unitsPerBox: 12, unitPrice: 36, subtotal: 36 })],
      },
      {
        id: "l2",
        customerId: "cust-1",
        status: "PENDING",
        lineItems: [
          box("ll2", { qty: 6, boxes: 1, pieces: 0, unitsPerBox: 6, unitPrice: 18, subtotal: 18 }),
        ],
      },
    ]);
    h.prisma.product.findMany.mockResolvedValue([{ id: "prod-repack", unitsPerBox: 6 }]);

    await h.service.mergeAllPendingForCustomer("cust-1");

    const creates = h.prisma.orderItem.create.mock.calls.filter(
      (c: any) => c[0]?.data?.productId === "prod-repack",
    );
    expect(creates).toHaveLength(2);
    const packs = creates
      .map((c: any) => c[0].data.unitsPerBox)
      .sort((a: number, b: number) => a - b);
    expect(packs).toEqual([6, 12]);
  });

  it("5. two losers both at pack 12: ONE merged line, not two", async () => {
    h.prisma.order.findMany.mockResolvedValue([
      { id: "w1", customerId: "cust-1", status: "PENDING", lineItems: [] },
      { id: "l1", customerId: "cust-1", status: "PENDING", lineItems: [box("ll1")] },
      { id: "l2", customerId: "cust-1", status: "PENDING", lineItems: [box("ll2")] },
    ]);
    h.prisma.product.findMany.mockResolvedValue([{ id: "prod-repack", unitsPerBox: 12 }]);

    await h.service.mergeAllPendingForCustomer("cust-1");

    const creates = h.prisma.orderItem.create.mock.calls.filter(
      (c: any) => c[0]?.data?.productId === "prod-repack",
    );
    expect(creates).toHaveLength(1);
    expect(creates[0][0].data).toMatchObject({
      boxes: 2,
      pieces: 0,
      unitsPerBox: 12,
      subtotal: 72,
    });
  });

  it("6. the sweep warns and counts a pack disagreement", async () => {
    h.prisma.order.groupBy.mockImplementation(({ where }: any) =>
      where?.tenantId === null
        ? Promise.resolve([])
        : Promise.resolve([{ customerId: "cust-1", tenantId: "t1", _count: { _all: 2 } }]),
    );
    h.prisma.order.findMany.mockResolvedValue([
      { id: "w1", customerId: "cust-1", status: "PENDING", lineItems: [] },
      {
        id: "l1",
        customerId: "cust-1",
        status: "PENDING",
        lineItems: [box("ll1", { unitsPerBox: 12, unitPrice: 36, subtotal: 36 })],
      },
      {
        id: "l2",
        customerId: "cust-1",
        status: "PENDING",
        lineItems: [
          box("ll2", { qty: 6, boxes: 1, pieces: 0, unitsPerBox: 6, unitPrice: 18, subtotal: 18 }),
        ],
      },
    ]);
    h.prisma.product.findMany.mockResolvedValue([{ id: "prod-repack", unitsPerBox: 6 }]);
    const warnSpy = jest
      .spyOn((h.service as any).logger, "warn")
      .mockImplementation(() => undefined);

    const result = await h.service.sweepAllPendingOrders();

    expect(result.packMismatches).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("contributing lines disagree on pack"),
    );
  });
});
