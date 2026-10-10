// The merge paths run inside a Postgres advisory lock (`common/db-locks.ts`, R3) — these specs
// exercise the merge FOLD's pack-grouping, not the lock, so run the critical section inline
// (mirrors orders.service.spec.ts's own mock).
// B1053: fold-math spec — row guard passed through (testing/merge-recheck.ts)
jest.mock("./merge-lock-recheck", () => require("./testing/merge-recheck").pass());
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
    expect(created![0].data).toMatchObject({
      boxes: 1,
      pieces: 0,
      unitsPerBox: 12,
      unitPrice: 36,
      subtotal: 36,
    });
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

  it("7. SA-124a: a winner already carrying 12-pack and 6-pack lines (a prior mismatch's durable state) folds a NEW 6-pack loser into the matching line — no third line, the 12-pack line untouched", async () => {
    h.prisma.order.findMany.mockResolvedValue([
      {
        id: "w1",
        customerId: "cust-1",
        status: "PENDING",
        lineItems: [
          box("w-12", { id: "w-12", unitsPerBox: 12, unitPrice: 36, subtotal: 36 }),
          box("w-6", {
            id: "w-6",
            qty: 6,
            boxes: 1,
            pieces: 0,
            unitsPerBox: 6,
            unitPrice: 18,
            subtotal: 18,
          }),
        ],
      },
      {
        id: "l1",
        customerId: "cust-1",
        status: "PENDING",
        lineItems: [
          box("ll1", { qty: 6, boxes: 1, pieces: 0, unitsPerBox: 6, unitPrice: 18, subtotal: 18 }),
        ],
      },
    ]);
    h.prisma.product.findMany.mockResolvedValue([{ id: "prod-repack", unitsPerBox: 6 }]);

    await h.service.mergeAllPendingForCustomer("cust-1");

    const creates = h.prisma.orderItem.create.mock.calls.filter(
      (c: any) => c[0]?.data?.productId === "prod-repack",
    );
    expect(creates).toHaveLength(0); // no third line — folds into the existing 6-pack line
    const updates = h.prisma.orderItem.update.mock.calls.filter(
      (c: any) => c[0]?.where?.id === "w-6",
    );
    expect(updates).toHaveLength(1);
    expect(updates[0][0].data).toMatchObject({ boxes: 2, pieces: 0, unitsPerBox: 6, subtotal: 36 });
    // the 12-pack line is never referenced by any write — untouched.
    const touchedTwelve = h.prisma.orderItem.update.mock.calls.some(
      (c: any) => c[0]?.where?.id === "w-12",
    );
    expect(touchedTwelve).toBe(false);
  });

  it("8. SA-124: a no-snapshot, no-split loser resolved at the live pack (12) warns and counts — no snapshot means genuinely no pack of its own", async () => {
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
        // box-unaware, no unitsPerBox snapshot at all — nothing of its own to resolve a pack from.
        lineItems: [box("ll1", { boxes: null, pieces: null, unitsPerBox: null })],
      },
    ]);
    h.prisma.product.findMany.mockResolvedValue([{ id: "prod-repack", unitsPerBox: 12 }]);
    const warnSpy = jest
      .spyOn((h.service as any).logger, "warn")
      .mockImplementation(() => undefined);

    const result = await h.service.sweepAllPendingOrders();

    expect(result.livePackFallbacks).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("had no pack snapshot on any contributing line"),
    );
  });

  it("9. SA-124: a snapshotted or split line never falls back to the live pack — no warn, counter stays 0", async () => {
    h.prisma.order.groupBy.mockImplementation(({ where }: any) =>
      where?.tenantId === null
        ? Promise.resolve([])
        : Promise.resolve([{ customerId: "cust-1", tenantId: "t1", _count: { _all: 2 } }]),
    );
    h.prisma.order.findMany.mockResolvedValue([
      { id: "w1", customerId: "cust-1", status: "PENDING", lineItems: [] },
      // box("ll1") carries its own unitsPerBox: 12 snapshot — resolves without the live pack.
      { id: "l1", customerId: "cust-1", status: "PENDING", lineItems: [box("ll1")] },
    ]);
    h.prisma.product.findMany.mockResolvedValue([{ id: "prod-repack", unitsPerBox: 6 }]);
    const warnSpy = jest
      .spyOn((h.service as any).logger, "warn")
      .mockImplementation(() => undefined);

    const result = await h.service.sweepAllPendingOrders();

    expect(result.livePackFallbacks).toBe(0);
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("had no pack snapshot on any contributing line"),
    );
  });

  it("10. SA-124c: two winner lines at the SAME pack — only the primary folds the loser, the second winner line is untouched, never double-counted", async () => {
    h.prisma.order.findMany.mockResolvedValue([
      {
        id: "w1",
        customerId: "cust-1",
        status: "PENDING",
        lineItems: [
          box("w-A", { id: "w-A", qty: 12, boxes: 1, pieces: 0, subtotal: 36 }),
          box("w-B", { id: "w-B", qty: 24, boxes: 2, pieces: 0, subtotal: 72 }),
        ],
      },
      { id: "l1", customerId: "cust-1", status: "PENDING", lineItems: [box("ll1")] },
    ]);
    h.prisma.product.findMany.mockResolvedValue([{ id: "prod-repack", unitsPerBox: 12 }]);

    await h.service.mergeAllPendingForCustomer("cust-1");

    // A (the primary) folds only the loser: 1 + 1 = 2 boxes. NEVER 4 (the pre-fix bug's
    // A + B + loser = 1 + 2 + 1), which would double-count B's 2 boxes on top of its own
    // untouched row.
    const updatesA = h.prisma.orderItem.update.mock.calls.filter(
      (c: any) => c[0]?.where?.id === "w-A",
    );
    expect(updatesA).toHaveLength(1);
    expect(updatesA[0][0].data).toMatchObject({ boxes: 2, pieces: 0, subtotal: 72 });
    expect(updatesA[0][0].data.boxes).not.toBe(4);

    // B is never referenced by ANY write — its own row (2 boxes) survives exactly as stored.
    const touchedB = h.prisma.orderItem.update.mock.calls.some(
      (c: any) => c[0]?.where?.id === "w-B",
    );
    expect(touchedB).toBe(false);

    // No third line created for this product either.
    const creates = h.prisma.orderItem.create.mock.calls.filter(
      (c: any) => c[0]?.data?.productId === "prod-repack",
    );
    expect(creates).toHaveLength(0);
  });

  it("11. Opus round 3 (MED): a plain (never-boxed) product merge never counts a live-pack fallback — the live pack itself is <= 1", async () => {
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
        lineItems: [box("ll1", { boxes: null, pieces: null, unitsPerBox: null })],
      },
    ]);
    h.prisma.product.findMany.mockResolvedValue([{ id: "prod-repack", unitsPerBox: null }]);
    const warnSpy = jest
      .spyOn((h.service as any).logger, "warn")
      .mockImplementation(() => undefined);

    const result = await h.service.sweepAllPendingOrders();

    expect(result.livePackFallbacks).toBe(0);
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("had no pack snapshot on any contributing line"),
    );
  });

  it("12. Opus round 3 (MED 4): forceConsolidateCustomer warns on BOTH kinds and logs their counts (it has no counter field to return, unlike the sweep)", async () => {
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
    const logSpy = jest.spyOn((h.service as any).logger, "log").mockImplementation(() => undefined);

    await h.service.forceConsolidateCustomer("cust-1");

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("contributing lines disagree on pack"),
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("1 pack mismatch(es), 0 live-pack fallback(s)"),
    );
  });
});
