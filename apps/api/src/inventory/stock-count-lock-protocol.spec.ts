import { ConflictException } from "@nestjs/common";
import { buildCountUnitWorld, CountUnitWorld, D, pid } from "./testing/count-unit-harness";

/**
 * SA-767 L-2.4 item B (r-note 4 B), unit level: line edits (upsert / remove) and discard take
 * `pg_try_advisory_xact_lock_shared(hashtext('stock-count'), hashtext(<sessionId>))` inside their own
 * tx - the committer's exclusive `stock-count:<sessionId>` key pair - and the status / movements checks
 * run INSIDE that lock. Discard is a CAS. The committer takes its exclusive lock first and re-reads the
 * session's lines under it. The real-Postgres proofs are `sa767-count-lock-protocol.db.spec.ts`.
 */
const mockWithAdvisoryLock = jest.fn();
jest.mock("../common/db-locks", () => ({
  ...jest.requireActual("../common/db-locks"),
  withAdvisoryLock: (...args: unknown[]) => mockWithAdvisoryLock(...args),
}));

describe("stock-count commit-lock protocol (SA-767 L-2.4 B)", () => {
  let w: CountUnitWorld;
  const open = () =>
    w.prisma.stockCountSession.findFirst.mockImplementation(async () => {
      w.events.push("session-read");
      return { id: "sess-1", status: "OPEN", startedAt: new Date("2026-10-01T00:00:00Z") };
    });
  const edits: Array<[string, () => Promise<unknown>]> = [
    [
      "upsertStockCountLine",
      () =>
        w.service.upsertStockCountLine(
          "sess-1",
          { productId: pid(1), countedQty: 1 },
          { sub: "u" },
        ),
    ],
    ["removeStockCountLine", () => w.service.removeStockCountLine("sess-1", pid(1))],
    ["discardStockCountSession", () => w.service.discardStockCountSession("sess-1")],
  ];

  beforeEach(async () => {
    w = await buildCountUnitWorld(mockWithAdvisoryLock);
    w.seed([pid(1)]);
    open();
    w.prisma.stockCountLine.findUnique.mockResolvedValue(null);
    w.prisma.stockCountSession.findUnique.mockResolvedValue({ id: "sess-1", status: "DISCARDED" });
  });

  it.each(edits)(
    "%s: the committer holds the lock -> 409 STOCK_COUNT_COMMITTING, nothing written",
    async (_n, call) => {
      w.state.lockHeld = true;

      const err: any = await call().catch((e) => e);

      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toMatchObject({ code: "STOCK_COUNT_COMMITTING" });
      expect(w.prisma.stockCountLine.create).not.toHaveBeenCalled();
      expect(w.prisma.stockCountLine.update).not.toHaveBeenCalled();
      expect(w.prisma.stockCountLine.deleteMany).not.toHaveBeenCalled();
      expect(w.prisma.stockCountSession.updateMany).not.toHaveBeenCalled();
    },
  );

  it.each(edits)(
    "%s: the lock is the committer's key pair, taken before the status / movements checks",
    async (_n, call) => {
      await call();

      expect(w.events.filter((e) => e === "lock")).toHaveLength(1);
      expect(w.events.indexOf("lock")).toBeLessThan(w.events.indexOf("session-read"));
      expect(w.events.indexOf("lock")).toBeLessThan(w.events.indexOf("movement-read"));
      expect(w.events.indexOf("tx")).toBeLessThan(w.events.indexOf("lock")); // inside its own tx
    },
  );

  it("the edits' shared lock statement derives the key pair exactly like the committer's lock", async () => {
    let sql = "";
    let values: unknown[] = [];
    const base = w.prisma.tenantTransaction.getMockImplementation()!;
    w.prisma.tenantTransaction.mockImplementation(async (fn: any) =>
      base(async (tx: any) => {
        const q = tx.$queryRaw;
        tx.$queryRaw = (s: TemplateStringsArray, ...v: unknown[]) => {
          if (s.join("?").includes("pg_try_advisory_xact_lock_shared")) {
            sql = s.join("?");
            values = v;
          }
          return q(s, ...v);
        };
        return fn(tx);
      }),
    );

    await w.service.removeStockCountLine("sess-1", pid(1));

    // same expression as db-locks' LOCK_SQL.try: pg_try_advisory_lock(hashtext(family), hashtext(key))
    expect(sql.replace(/\s+/g, " ")).toContain(
      "pg_try_advisory_xact_lock_shared(hashtext(?), hashtext(?))",
    );
    expect(values).toEqual(["stock-count", "sess-1"]);
  });

  it("a movement already written for the session is still refused (now under the lock)", async () => {
    w.ledger.push({ id: "mv-1", productId: pid(1), type: "ADJUSTMENT" });

    const err: any = await w.service.removeStockCountLine("sess-1", pid(1)).catch((e) => e);

    expect(err.getResponse()).toMatchObject({ code: "STOCK_COUNT_COMMITTING" });
    expect(w.prisma.stockCountLine.deleteMany).not.toHaveBeenCalled();
  });

  describe("discard is a CAS", () => {
    it("flips OPEN / REVIEW to DISCARDED with one updateMany, and returns the session", async () => {
      w.prisma.stockCountSession.findUnique.mockResolvedValue({
        id: "sess-1",
        status: "DISCARDED",
      });

      const res: any = await w.service.discardStockCountSession("sess-1");

      expect(w.prisma.stockCountSession.updateMany).toHaveBeenCalledTimes(1);
      const cas = w.prisma.stockCountSession.updateMany.mock.calls[0][0];
      expect(cas.where).toEqual({ id: "sess-1", status: { in: ["OPEN", "REVIEW"] } });
      expect(cas.data).toMatchObject({ status: "DISCARDED" });
      expect(cas.data.discardedAt).toBeInstanceOf(Date);
      expect(w.prisma.stockCountSession.update).not.toHaveBeenCalled();
      expect(res).toMatchObject({ id: "sess-1", status: "DISCARDED" });
    });

    it("a CAS that matches no row is a 409, not a silent success", async () => {
      w.prisma.stockCountSession.updateMany.mockResolvedValue({ count: 0 });

      const err: any = await w.service.discardStockCountSession("sess-1").catch((e) => e);

      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getStatus()).toBe(409);
    });
  });

  describe("the committer takes its exclusive lock FIRST and re-reads the lines under it", () => {
    const line = (i: number) => ({
      id: `line-${i}`,
      sessionId: "sess-1",
      productId: pid(i),
      mode: "REPLACE",
      countedQty: D(90),
      expectedQty: D(100),
      unitCostOverride: null,
    });
    const sess = (lines: unknown[]) => ({
      id: "sess-1",
      status: "OPEN",
      movementReference: null,
      notes: null,
      startedAt: new Date("2026-10-01T00:00:00Z"),
      lines,
    });

    it("a line saved by an in-flight edit before the lock is not dropped", async () => {
      w.seed([pid(1), pid(2)]);
      // pre-check read: one line; the read under the lock (after the edit finished): two
      w.prisma.stockCountSession.findUnique
        .mockResolvedValueOnce(sess([line(1)]))
        .mockResolvedValue(sess([line(1), line(2)]));

      const res: any = await w.service.commitStockCountSession("sess-1", {}, { sub: "u" });

      expect(res.applied).toBe(2);
      expect(w.prisma.product.update).toHaveBeenCalledTimes(2);
      expect(w.stock.get(pid(2))!.toString()).toBe("90");
    });

    it("a busy try-lock (an edit holds the shared lock for a moment) is retried before the 409", async () => {
      w.seed([pid(1)]);
      w.prisma.stockCountSession.findUnique.mockResolvedValue(sess([line(1)]));
      mockWithAdvisoryLock
        .mockResolvedValueOnce({ acquired: false })
        .mockImplementation(async (_o: unknown, fn: () => Promise<unknown>) => ({
          acquired: true,
          value: await fn(),
        }));

      const res: any = await w.service.commitStockCountSession("sess-1", {}, { sub: "u" });

      expect(mockWithAdvisoryLock).toHaveBeenCalledTimes(2);
      expect(res.applied).toBe(1);
    });

    it("a committer that waited out a discard stops: DISCARDED under the lock is a 400, no stock moves", async () => {
      w.seed([pid(1)]);
      w.prisma.stockCountSession.findUnique
        .mockResolvedValueOnce(sess([line(1)]))
        .mockResolvedValue({ ...sess([line(1)]), status: "DISCARDED" });

      const err: any = await w.service
        .commitStockCountSession("sess-1", {}, { sub: "u" })
        .catch((e) => e);

      expect(err.getStatus()).toBe(400);
      expect(w.prisma.product.update).not.toHaveBeenCalled();
    });
  });
});
