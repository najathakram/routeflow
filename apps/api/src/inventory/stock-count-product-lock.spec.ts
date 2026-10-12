import { ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { LOCK_FAMILIES } from "../common/db-locks";
import { buildCountUnitWorld, CountUnitWorld, D, pid } from "./testing/count-unit-harness";

/**
 * SA-767 r-note 5, SA-3 option (a), unit level: ONE OPEN COUNT PER PRODUCT. Adding a product to a
 * session (the create branch of `upsertStockCountLine`, and the lines an amendment seeds) takes a
 * blocking tx advisory lock `stock-count-product:<tenantId>:<productId>` and then refuses with 409
 * PRODUCT_IN_OPEN_COUNT when another OPEN / REVIEW session already has a line for it. The committer
 * re-checks under its exclusive lock (a legacy overlap), and "finish with skips" does not bypass it.
 * The real-Postgres proofs (race, legacy overlap) are `sa767-count-product-lock.db.spec.ts`.
 */
const mockWithAdvisoryLock = jest.fn();
jest.mock("../common/db-locks", () => ({
  ...jest.requireActual("../common/db-locks"),
  withAdvisoryLock: (...args: unknown[]) => mockWithAdvisoryLock(...args),
}));

describe("one open count per product (SA-767 r-note 5, SA-3)", () => {
  let w: CountUnitWorld;
  const lockEvent = (i: number) => `xlock:stock-count-product|test-tenant:${pid(i)}`;
  const save = (dto: Record<string, unknown> = {}) =>
    w.service.upsertStockCountLine("sess-1", { productId: pid(1), countedQty: 5, ...dto } as any, {
      sub: "u-1",
    });
  const other = (over: Record<string, unknown> = {}) => ({
    productId: pid(1),
    product: { name: "Widget" },
    session: { id: "other-sess", name: "Aisle 3" },
    ...over,
  });

  beforeEach(async () => {
    w = await buildCountUnitWorld(mockWithAdvisoryLock);
    w.seed([pid(1), pid(2)], 100);
    w.prisma.stockCountSession.findFirst.mockResolvedValue({
      id: "sess-1",
      status: "OPEN",
      startedAt: new Date("2026-10-01T00:00:00Z"),
    });
    w.prisma.stockMovement.findFirst.mockResolvedValue(null);
    w.prisma.stockCountLine.findUnique.mockResolvedValue(null);
    w.prisma.stockCountLine.findMany.mockImplementation(async () => {
      w.events.push("overlap-read");
      return [];
    });
  });

  it("the code and the lock family are registered", () => {
    expect((API_ERROR_CODES as Record<string, string>).PRODUCT_IN_OPEN_COUNT).toBe(
      "PRODUCT_IN_OPEN_COUNT",
    );
    expect(LOCK_FAMILIES).toContain("stock-count-product");
  });

  describe("adding a product (the create branch)", () => {
    it("takes the blocking tx lock keyed tenant:product, THEN reads the overlap, THEN creates", async () => {
      await save();

      const lock = w.events.indexOf(lockEvent(1));
      const read = w.events.indexOf("overlap-read");
      expect(lock).toBeGreaterThan(-1);
      expect(read).toBeGreaterThan(lock);
      expect(w.prisma.stockCountLine.create).toHaveBeenCalledTimes(1);
      expect(w.prisma.stockCountLine.create.mock.invocationCallOrder[0]).toBeGreaterThan(
        w.prisma.stockCountLine.findMany.mock.invocationCallOrder[0],
      );
    });

    it("the add tx has a 15 s budget: the 5 s lock_timeout of the product lock fires before Prisma's 5 s default expires (P2028)", async () => {
      await save();

      expect(w.prisma.tenantTransaction).toHaveBeenCalledTimes(1);
      expect(w.prisma.tenantTransaction.mock.calls[0][1]).toMatchObject({ timeout: 15000 });
    });

    it("looks only at OTHER sessions that are OPEN / REVIEW", async () => {
      await save();

      const q = w.prisma.stockCountLine.findMany.mock.calls[0][0];
      expect(q.where).toMatchObject({
        productId: { in: [pid(1)] },
        sessionId: { not: "sess-1" },
        session: { status: { in: ["OPEN", "REVIEW"] } },
      });
    });

    it("409 PRODUCT_IN_OPEN_COUNT with the other session's id and name; nothing is created", async () => {
      w.prisma.stockCountLine.findMany.mockResolvedValue([other()]);

      const err: any = await save().catch((e) => e);

      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getStatus()).toBe(409);
      expect(err.getResponse()).toMatchObject({
        code: "PRODUCT_IN_OPEN_COUNT",
        sessionId: "other-sess",
        sessionName: "Aisle 3",
        conflicts: [
          {
            productId: pid(1),
            productName: "Widget",
            sessionId: "other-sess",
            sessionName: "Aisle 3",
          },
        ],
      });
      expect(w.prisma.stockCountLine.create).not.toHaveBeenCalled();
    });

    it("an unnamed other session carries sessionName null", async () => {
      w.prisma.stockCountLine.findMany.mockResolvedValue([
        other({ session: { id: "other-sess", name: null } }),
      ]);

      const err: any = await save().catch((e) => e);

      expect(err.getResponse()).toMatchObject({ sessionId: "other-sess", sessionName: null });
    });

    it("an EXISTING line of this session (an edit) takes no product lock and reads no overlap", async () => {
      w.prisma.stockCountLine.findUnique.mockResolvedValue({
        id: "line-1",
        sessionId: "sess-1",
        productId: pid(1),
        mode: "REPLACE",
        countedQty: D(4),
        boxes: null,
        pieces: null,
        expectedQty: D(100),
      });

      await save({ countedQty: 6 });

      expect(w.events.some((e) => e.startsWith("xlock:"))).toBe(false);
      expect(w.events).not.toContain("overlap-read");
      expect(w.prisma.stockCountLine.update).toHaveBeenCalledTimes(1);
    });
  });

  describe("amending a committed count (seeds lines)", () => {
    const amend = () =>
      w.service.startStockCountSession({ amendsSessionId: "old" }, { sub: "u-1" });
    beforeEach(() => {
      w.prisma.stockCountSession.findMany.mockResolvedValue([]);
      w.prisma.stockCountSession.findUnique.mockResolvedValue({
        id: "old",
        status: "COMMITTED",
        lines: [
          { productId: pid(2), countedQty: D(7), boxes: null, pieces: null, mode: "REPLACE" },
          { productId: pid(1), countedQty: D(7), boxes: null, pieces: null, mode: "REPLACE" },
        ],
      });
      w.prisma.stockCountSession.create.mockResolvedValue({ id: "new-sess" });
    });

    it("the amend tx (N sorted locks + N creates) has the same 15 s budget", async () => {
      await amend();

      expect(w.prisma.tenantTransaction.mock.calls[0][1]).toMatchObject({ timeout: 15000 });
    });

    it("locks every seeded product in SORTED order, then checks the overlap once", async () => {
      await amend();

      expect(w.events.filter((e) => e.startsWith("xlock:"))).toEqual([lockEvent(1), lockEvent(2)]);
      expect(w.events.filter((e) => e === "overlap-read")).toHaveLength(1);
      expect(w.prisma.stockCountLine.create).toHaveBeenCalledTimes(2);
    });

    it("seeds each line's countedQty through roundCountQty (a legacy unrounded value lands at 3 dp)", async () => {
      w.prisma.stockCountSession.findUnique.mockResolvedValue({
        id: "old",
        status: "COMMITTED",
        lines: [
          {
            productId: pid(1),
            countedQty: D("1.2345"),
            boxes: null,
            pieces: null,
            mode: "REPLACE",
          },
        ],
      });

      await amend();

      expect(w.prisma.stockCountLine.create.mock.calls[0][0].data.countedQty.toString()).toBe(
        "1.235",
      );
    });

    it("refuses with 409 PRODUCT_IN_OPEN_COUNT when a seeded product is open in another count", async () => {
      w.prisma.stockCountLine.findMany.mockResolvedValue([other({ productId: pid(2) })]);

      const err: any = await amend().catch((e) => e);

      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toMatchObject({
        code: "PRODUCT_IN_OPEN_COUNT",
        conflicts: [{ productId: pid(2), sessionId: "other-sess" }],
      });
      expect(w.prisma.stockCountLine.create).not.toHaveBeenCalled();
    });
  });

  describe("the committer re-checks under its exclusive lock (legacy overlap)", () => {
    const line = (i: number) => ({
      id: `line-${i}`,
      sessionId: "sess-1",
      productId: pid(i),
      mode: "REPLACE",
      countedQty: D(90),
      expectedQty: D(100),
      unitCostOverride: null,
    });
    const commit = (dto: Record<string, unknown> = {}) =>
      w.service.commitStockCountSession("sess-1", dto as any, { sub: "user-1" });

    beforeEach(() => {
      w.prisma.stockCountSession.findUnique.mockResolvedValue({
        id: "sess-1",
        status: "OPEN",
        movementReference: null,
        notes: null,
        startedAt: new Date("2026-10-01T00:00:00Z"),
        lines: [line(1), line(2)],
      });
    });

    const expectNothingWritten = () => {
      expect(w.prisma.product.update).not.toHaveBeenCalled();
      expect(w.prisma.stockMovement.create).not.toHaveBeenCalled();
      expect(w.prisma.stockCountSession.updateMany).not.toHaveBeenCalled();
      expect(w.audit.log).not.toHaveBeenCalled();
    };

    it("no overlap: commits as before, after looking at this session's products only", async () => {
      await commit();

      const q = w.prisma.stockCountLine.findMany.mock.calls[0][0];
      expect(q.where).toMatchObject({
        productId: { in: [pid(1), pid(2)] },
        sessionId: { not: "sess-1" },
        session: { status: { in: ["OPEN", "REVIEW"] } },
      });
      expect(w.prisma.product.update).toHaveBeenCalledTimes(2);
    });

    it("409 PRODUCT_IN_OPEN_COUNT listing every conflict (deduplicated); nothing is written", async () => {
      w.prisma.stockCountLine.findMany.mockResolvedValue([
        other({ productId: pid(2) }),
        other({ productId: pid(2) }),
        other({ productId: pid(1), session: { id: "s9", name: null } }),
      ]);

      const err: any = await commit().catch((e) => e);

      expect(err).toBeInstanceOf(ConflictException);
      const body = err.getResponse();
      expect(body.code).toBe("PRODUCT_IN_OPEN_COUNT");
      expect(body.conflicts).toEqual([
        { productId: pid(1), productName: "Widget", sessionId: "s9", sessionName: null },
        {
          productId: pid(2),
          productName: "Widget",
          sessionId: "other-sess",
          sessionName: "Aisle 3",
        },
      ]);
      expectNothingWritten();
    });

    it("finish-with-skips does NOT bypass it", async () => {
      w.ledger.push({ id: "mv-old", productId: pid(1), type: "ADJUSTMENT" }); // a partly saved count
      w.prisma.stockCountLine.findMany.mockResolvedValue([other({ productId: pid(2) })]);

      const err: any = await commit({ finishWithSkips: true }).catch((e) => e);

      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toMatchObject({ code: "PRODUCT_IN_OPEN_COUNT" });
      expectNothingWritten();
    });
  });
});
