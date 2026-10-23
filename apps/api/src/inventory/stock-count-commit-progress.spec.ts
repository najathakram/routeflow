import { ServiceUnavailableException } from "@nestjs/common";
import { LockUnavailableError } from "../common/db-locks";
import {
  buildCountUnitWorld,
  CountUnitWorld,
  D,
  deadlock,
  pid,
} from "./testing/count-unit-harness";

/**
 * SA-767 L-2.4 item D (r-note 4 D), unit level: a 503 LOCK_UNAVAILABLE raised DURING the batch committer
 * carries `{ committedLines, totalLines }` (so the client can say "Partly saved" vs "Nothing was
 * saved"), and the session detail GET exposes the same numbers as `commit` while a commit is
 * unfinished. `committedLines` = lines whose ADJUSTMENT movement exists; `totalLines` = lines that
 * write an adjustment (a zero-delta line never does, so it is not counted).
 */
const mockWithAdvisoryLock = jest.fn();
jest.mock("../common/db-locks", () => ({
  ...jest.requireActual("../common/db-locks"),
  withAdvisoryLock: (...args: unknown[]) => mockWithAdvisoryLock(...args),
}));

describe("count commit progress (SA-767 L-2.4 D)", () => {
  let w: CountUnitWorld;
  const line = (i: number, over: Record<string, unknown> = {}) => ({
    id: `line-${String(i).padStart(3, "0")}`,
    sessionId: "sess-1",
    productId: pid(i),
    mode: "REPLACE",
    countedQty: D(90),
    expectedQty: D(100),
    unitCostOverride: null,
    ...over,
  });
  const lines = (n: number) => Array.from({ length: n }, (_, k) => line(k + 1));
  const session = (ls: unknown[], over: Record<string, unknown> = {}) => ({
    id: "sess-1",
    status: "OPEN",
    movementReference: null,
    notes: null,
    startedAt: new Date("2026-10-01T00:00:00Z"),
    lines: ls,
    ...over,
  });
  const commit = () => w.service.commitStockCountSession("sess-1", {}, { sub: "user-1" });

  beforeEach(async () => {
    w = await buildCountUnitWorld(mockWithAdvisoryLock);
  });

  describe("the 503 body", () => {
    it("retries exhausted in batch 2: LOCK_UNAVAILABLE + committedLines 50 of totalLines 60", async () => {
      w.seed(lines(60).map((l) => l.productId));
      w.prisma.stockCountSession.findUnique.mockResolvedValue(session(lines(60)));
      // batch 1 (the first tenantTransaction) commits; every attempt of batch 2 deadlocks
      const base = w.prisma.tenantTransaction.getMockImplementation()!;
      let txNo = 0;
      w.prisma.tenantTransaction.mockImplementation(async (fn: any, opts?: any) => {
        txNo += 1;
        const batch2 = txNo > 1;
        return base(async (tx: any) => {
          if (batch2) throw deadlock();
          return fn(tx);
        }, opts);
      });

      const err: any = await commit().catch((e) => e);

      expect(err).toBeInstanceOf(ServiceUnavailableException);
      expect(err.getStatus()).toBe(503);
      expect(err.getResponse()).toMatchObject({
        code: "LOCK_UNAVAILABLE",
        committedLines: 50,
        totalLines: 60,
      });
    });

    it("no lock connection before anything was written: committedLines 0 (nothing was saved)", async () => {
      w.seed(lines(3).map((l) => l.productId));
      w.prisma.stockCountSession.findUnique.mockResolvedValue(session(lines(3)));
      mockWithAdvisoryLock.mockRejectedValue(new LockUnavailableError(new Error("pool")));

      const err: any = await commit().catch((e) => e);

      expect(err).toBeInstanceOf(ServiceUnavailableException);
      expect(err.getResponse()).toMatchObject({
        code: "LOCK_UNAVAILABLE",
        committedLines: 0,
        totalLines: 3,
      });
    });

    it("a resumed commit that fails again counts the earlier run's movements too", async () => {
      w.seed(lines(3).map((l) => l.productId));
      w.ledger.push({ id: "mv-old", productId: pid(1), type: "ADJUSTMENT" });
      w.prisma.stockCountSession.findUnique.mockResolvedValue(session(lines(3)));
      mockWithAdvisoryLock.mockRejectedValue(new LockUnavailableError(new Error("pool")));

      const err: any = await commit().catch((e) => e);

      expect(err.getResponse()).toMatchObject({ committedLines: 1, totalLines: 3 });
    });

    it("zero-delta lines are not part of totalLines", async () => {
      w.seed(lines(3).map((l) => l.productId));
      w.prisma.stockCountSession.findUnique.mockResolvedValue(
        session([
          line(1),
          line(2, { countedQty: D(100) }),
          line(3, { mode: "ADD", countedQty: D(0) }),
        ]),
      );
      mockWithAdvisoryLock.mockRejectedValue(new LockUnavailableError(new Error("pool")));

      const err: any = await commit().catch((e) => e);

      expect(err.getResponse()).toMatchObject({ committedLines: 0, totalLines: 1 });
    });

    it("any other error is not rewrapped", async () => {
      w.seed(lines(1).map((l) => l.productId));
      w.prisma.stockCountSession.findUnique.mockResolvedValue(session(lines(1)));
      const boom = new Error("boom");
      mockWithAdvisoryLock.mockRejectedValue(boom);

      await expect(commit()).rejects.toBe(boom);
    });
  });

  describe("GET stock-counts/:id exposes commit progress", () => {
    const detail = (ls: unknown[], over: Record<string, unknown> = {}) =>
      w.prisma.stockCountSession.findUnique.mockResolvedValue(session(ls, over));

    it("movements exist and the session is not COMMITTED: { committedLines, totalLines }", async () => {
      detail(lines(3));
      w.ledger.push(
        { id: "m1", productId: pid(1), type: "ADJUSTMENT" },
        { id: "m2", productId: pid(2), type: "ADJUSTMENT" },
      );

      const res: any = await w.service.getStockCountSession("sess-1");

      expect(res.commit).toEqual({ committedLines: 2, totalLines: 3 });
      expect(res.lines).toHaveLength(3);
    });

    it("no movement yet: commit is null", async () => {
      detail(lines(3));

      const res: any = await w.service.getStockCountSession("sess-1");

      expect(res.commit).toBeNull();
    });

    it("COMMITTED and DISCARDED: commit is null (and the movement lookup is not made)", async () => {
      for (const status of ["COMMITTED", "DISCARDED"]) {
        w.ledger.push({ id: "m1", productId: pid(1), type: "ADJUSTMENT" });
        detail(lines(3), { status });
        w.prisma.stockMovement.findMany.mockClear();

        const res: any = await w.service.getStockCountSession("sess-1");

        expect(res.commit).toBeNull();
        expect(w.prisma.stockMovement.findMany).not.toHaveBeenCalled();
      }
    });
  });
});
