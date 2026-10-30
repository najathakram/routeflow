import { ConflictException, Logger } from "@nestjs/common";
import { buildCountUnitWorld, CountUnitWorld, D, pid } from "./testing/count-unit-harness";

/**
 * Row 562 S1 (T14), unit level: an amendment seeds its lines in batches of COUNT_SEED_BATCH, each its own
 * transaction with ONE sorted lock statement, instead of N advisory locks and N creates in one 15 s
 * transaction. A conflict that shows up mid-way refuses the whole amendment and discards the new session.
 * The real-Postgres proof is `stock-count-seed.db.spec.ts`.
 */
const mockWithAdvisoryLock = jest.fn();
jest.mock("../common/db-locks", () => ({
  ...jest.requireActual("../common/db-locks"),
  withAdvisoryLock: (...args: unknown[]) => mockWithAdvisoryLock(...args),
}));

const N = 1000;
const ids = Array.from({ length: N }, (_, i) => pid(i + 1));

describe("amend seeds in batches (row 562 S1, T14)", () => {
  let w: CountUnitWorld;
  const amend = () => w.service.startStockCountSession({ amendsSessionId: "old" }, { sub: "u-1" });
  const lockStatements = () => w.events.filter((e) => e.startsWith("xlock:"));
  const transactions = () => w.events.filter((e) => e === "tx").length;

  beforeEach(async () => {
    w = await buildCountUnitWorld(mockWithAdvisoryLock);
    w.seed(ids, 50);
    w.prisma.stockCountSession.findMany.mockResolvedValue([]);
    w.prisma.stockCountSession.findUnique.mockResolvedValue({
      id: "old",
      status: "COMMITTED",
      // out of id order on purpose: the batches are cut from the SORTED ids
      lines: [...ids].reverse().map((productId) => ({
        productId,
        countedQty: D(7),
        boxes: null,
        pieces: null,
        mode: "REPLACE",
      })),
    });
    w.prisma.stockCountSession.create.mockResolvedValue({ id: "new-sess" });
    w.prisma.stockCountSession.findFirst.mockResolvedValue({ id: "new-sess", status: "OPEN" }); // the seeder's OPEN check
    w.prisma.stockCountLine.findMany.mockResolvedValue([]);
    w.prisma.stockCountLine.createMany.mockImplementation(async (a: any) => ({
      count: a.data.length,
    }));
  });

  it("1,000 lines are 5 transactions of 200 with ONE lock statement each (master: 1 transaction, 1,000 locks)", async () => {
    await amend();

    expect(lockStatements()).toHaveLength(5);
    expect(transactions()).toBe(5);
    const sizes = w.prisma.stockCountLine.createMany.mock.calls.map((c: any[]) => c[0].data.length);
    expect(sizes).toEqual([200, 200, 200, 200, 200]);
  });

  it("seeds the same lines: every product once, counted as before, baseline = live stock", async () => {
    await amend();

    const rows = w.prisma.stockCountLine.createMany.mock.calls.flatMap((c: any[]) => c[0].data);
    expect(rows.map((r: any) => r.productId)).toEqual([...ids].sort()); // the seeder sorts as strings; none lost, none doubled
    expect(rows.every((r: any) => r.sessionId === "new-sess" && r.countedById === "u-1")).toBe(
      true,
    );
    expect(rows.every((r: any) => Number(r.countedQty) === 7 && Number(r.expectedQty) === 50)).toBe(
      true,
    );
  });

  it("a conflict found in batch 3 refuses the whole amendment: 409, later batches never run, the session is discarded", async () => {
    let call = 0;
    w.prisma.stockCountLine.findMany.mockImplementation(async () => {
      call += 1; // call 1 is the pre-check, calls 2..6 are the batches
      return call === 4
        ? [
            {
              productId: pid(450),
              product: { name: "Widget" },
              session: { id: "other-sess", name: "Aisle 3" },
            },
          ]
        : [];
    });

    const err: any = await amend().catch((e) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({
      code: "PRODUCT_IN_OPEN_COUNT",
      conflicts: [{ productId: pid(450), sessionId: "other-sess" }],
    });
    expect(w.prisma.stockCountLine.createMany).toHaveBeenCalledTimes(2); // batches 1 and 2 only
    expect(w.prisma.stockCountLine.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ sessionId: "new-sess" }) }),
    );
    expect(w.prisma.stockCountSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "new-sess" }),
        data: expect.objectContaining({ status: "DISCARDED" }),
      }),
    );
  });

  it("a conflict the PRE-check finds creates nothing at all (no session, no lock)", async () => {
    w.prisma.stockCountLine.findMany.mockResolvedValueOnce([
      {
        productId: pid(2),
        product: { name: "Widget" },
        session: { id: "other-sess", name: null },
      },
    ]);

    const err: any = await amend().catch((e) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect(w.prisma.stockCountSession.create).not.toHaveBeenCalled();
    expect(lockStatements()).toHaveLength(0);
  });

  it("a discard that fails after a failed seed logs a warning with the session id, and the seed's own error still wins", async () => {
    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    w.prisma.stockCountLine.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        productId: pid(2),
        product: { name: "Widget" },
        session: { id: "other-sess", name: null },
      },
    ]);
    w.prisma.stockCountSession.updateMany.mockRejectedValue(new Error("discard boom"));

    const err: any = await amend().catch((e) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ code: "PRODUCT_IN_OPEN_COUNT" });
    const lines = warn.mock.calls.map((c) => String(c[0]));
    expect(lines.some((m) => m.includes("new-sess") && m.includes("discard boom"))).toBe(true);
    warn.mockRestore();
  });
});
