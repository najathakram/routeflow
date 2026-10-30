import { readFileSync } from "fs";
import { join } from "path";
import { NotFoundException } from "@nestjs/common";
import { buildCountUnitWorld, CountUnitWorld, D, pid } from "./testing/count-unit-harness";

/**
 * Row 562 S1: `GET inventory/stock-counts/:id/progress`, the few-hundred-byte read a page polls while a long
 * seed or commit runs (the full detail is about 1 MB at 3.4k lines). A pure read: it writes nothing, takes no
 * lock, and loads the lines only when a movement of the count exists to measure against.
 */
const mockWithAdvisoryLock = jest.fn();
jest.mock("../common/db-locks", () => ({
  ...jest.requireActual("../common/db-locks"),
  withAdvisoryLock: (...args: unknown[]) => mockWithAdvisoryLock(...args),
}));

describe("stock count progress (row 562 S1)", () => {
  let w: CountUnitWorld;
  const started = new Date("2026-10-01T00:00:00Z");
  const session = (over: Record<string, unknown> = {}) => ({
    id: "sess-1",
    status: "OPEN",
    startedAt: started,
    seedPlannedLines: null,
    seedCompletedAt: null,
    _count: { lines: 3 },
    ...over,
  });
  const line = (i: number, over: Record<string, unknown> = {}) => ({
    productId: pid(i),
    mode: "REPLACE",
    countedQty: D(0),
    expectedQty: D(10),
    ...over,
  });
  const read = () => w.service.getStockCountProgress("sess-1");

  beforeEach(async () => {
    w = await buildCountUnitWorld(mockWithAdvisoryLock);
    w.prisma.stockCountSession.findUnique.mockResolvedValue(session());
    w.prisma.stockMovement.findMany.mockImplementation(async () => []);
  });

  it("404 for a session that is not in this tenant", async () => {
    w.prisma.stockCountSession.findUnique.mockResolvedValue(null);
    await expect(read()).rejects.toBeInstanceOf(NotFoundException);
  });

  it("an open session with no movement yet: its status and line count, commit null, no line rows loaded", async () => {
    const res = await read();

    expect(res).toEqual({
      status: "OPEN",
      lineCount: 3,
      commit: null,
      seedState: "legacy",
      seeded: 3,
      planned: null,
    });
    expect(w.prisma.stockCountLine.findMany).not.toHaveBeenCalled();
  });

  it("a partly committed session: how many written lines have their movement", async () => {
    w.prisma.stockMovement.findMany.mockResolvedValue([
      { productId: pid(1), type: "ADJUSTMENT" },
      { productId: pid(2), type: "COST_BASIS" }, // a cost correction is not the quantity movement
    ]);
    w.prisma.stockCountLine.findMany.mockResolvedValue([
      line(1),
      line(2),
      line(3, { expectedQty: D(0) }), // zero delta: writes no movement, so it is in neither number
    ]);

    const res = await read();

    expect(res).toEqual({
      status: "OPEN",
      lineCount: 3,
      commit: { committedLines: 1, totalLines: 2 },
      seedState: "legacy",
      seeded: 3,
      planned: null,
    });
  });

  it("a committed or discarded session is not looked up for movements", async () => {
    for (const status of ["COMMITTED", "DISCARDED"]) {
      w.prisma.stockCountSession.findUnique.mockResolvedValue(session({ status }));
      w.prisma.stockMovement.findMany.mockClear();

      const res = await read();

      expect(res).toMatchObject({ status, lineCount: 3, commit: null });
      expect(w.prisma.stockMovement.findMany).not.toHaveBeenCalled();
    }
  });

  describe("the seed-state (SA-999)", () => {
    it("a seed that has not stamped its completion: 'seeding', the lines written of the lines planned", async () => {
      w.prisma.stockCountSession.findUnique.mockResolvedValue(
        session({ seedPlannedLines: 450, _count: { lines: 200 } }),
      );

      const res = await read();

      expect(res).toMatchObject({
        seedState: "seeding",
        seeded: 200,
        planned: 450,
        lineCount: 200,
      });
    });

    it("a seed that stamped its completion: 'complete'", async () => {
      w.prisma.stockCountSession.findUnique.mockResolvedValue(
        session({
          seedPlannedLines: 3,
          seedCompletedAt: new Date("2026-10-01T00:01:00Z"),
          _count: { lines: 3 },
        }),
      );

      expect(await read()).toMatchObject({ seedState: "complete", seeded: 3, planned: 3 });
    });

    it("a seed of 0 lines is 'complete' with planned 0 (stamped in the create)", async () => {
      w.prisma.stockCountSession.findUnique.mockResolvedValue(
        session({ seedPlannedLines: 0, seedCompletedAt: started, _count: { lines: 0 } }),
      );

      expect(await read()).toMatchObject({ seedState: "complete", seeded: 0, planned: 0 });
    });

    it("a row the CHECKs forbid (completed without a planned number) is an error, never a guessed state", async () => {
      w.prisma.stockCountSession.findUnique.mockResolvedValue(
        session({ seedCompletedAt: started }),
      );
      await expect(read()).rejects.toThrow(/seedCompletedAt is set without seedPlannedLines/);
    });

    it("the read selects the two columns it reports", async () => {
      await read();
      expect(w.prisma.stockCountSession.findUnique.mock.calls[0][0].select).toMatchObject({
        seedPlannedLines: true,
        seedCompletedAt: true,
      });
    });
  });

  it("the movement lookup is bounded to this session's reference and lifetime", async () => {
    await read();

    expect(w.prisma.stockMovement.findMany.mock.calls[0][0].where).toMatchObject({
      reference: "STOCK_COUNT-sess-1",
      createdAt: { gte: started },
    });
  });

  it("is a pure read: no write, no transaction, no lock, in the module or the service method", () => {
    const mod = readFileSync(join(__dirname, "stock-count-progress.ts"), "utf8").replace(
      /\/\*[\s\S]*?\*\/|(^|[^:])\/\/.*$/gm,
      "$1",
    );
    expect(mod).not.toMatch(
      /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(|\$executeRaw|tenantTransaction|Lock\(/,
    );
    expect(w.prisma.tenantTransaction).not.toHaveBeenCalled();
  });
});
