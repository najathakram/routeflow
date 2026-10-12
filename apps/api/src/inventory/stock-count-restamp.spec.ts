import { buildCountUnitWorld, CountUnitWorld, D, pid } from "./testing/count-unit-harness";

/**
 * SA-767 L-2.4 item A (r-note 4 A, option (i)), unit level: `expectedQty` is the product's LIVE stock,
 * read in the SAME tx, on a line's create and on every ABSOLUTE write; an INCREMENT scan never
 * re-stamps. The real-Postgres proof is `sa767-count-restamp.db.spec.ts` (A1-A3).
 */
jest.mock("../common/db-locks", () => ({
  ...jest.requireActual("../common/db-locks"),
  withAdvisoryLock: jest.fn(),
}));

describe("upsertStockCountLine - expectedQty stamp rule (SA-767 L-2.4 A)", () => {
  let w: CountUnitWorld;
  const save = (dto: Record<string, unknown>) =>
    w.service.upsertStockCountLine("sess-1", { productId: pid(1), ...dto } as any, { sub: "u-1" });
  const existing = (over: Record<string, unknown> = {}) => ({
    id: "line-1",
    sessionId: "sess-1",
    productId: pid(1),
    mode: "REPLACE",
    countedQty: D(100),
    boxes: null,
    pieces: null,
    expectedQty: D(100),
    ...over,
  });

  beforeEach(async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { withAdvisoryLock } = require("../common/db-locks");
    w = await buildCountUnitWorld(withAdvisoryLock);
    w.seed([pid(1)], 90); // live stock now 90 (a sale of 10 landed after the line was created)
    w.prisma.stockCountSession.findFirst.mockResolvedValue({
      id: "sess-1",
      status: "OPEN",
      startedAt: new Date("2026-10-01T00:00:00Z"),
    });
    w.prisma.stockMovement.findFirst.mockResolvedValue(null);
  });

  it("CREATE stamps the live stock, read inside the transaction (not before it)", async () => {
    w.prisma.stockCountLine.findUnique.mockResolvedValue(null);

    await save({ countedQty: 90 });

    const data = w.prisma.stockCountLine.create.mock.calls[0][0].data;
    expect(Number(data.expectedQty)).toBe(90);
    // the stock the stamp comes from was read after the tx began
    expect(w.events.indexOf("tx")).toBeGreaterThan(-1);
    expect(w.events.lastIndexOf("product-read")).toBeGreaterThan(w.events.indexOf("tx"));
  });

  it("an ABSOLUTE write (typed total / recount) re-stamps expectedQty from the live stock", async () => {
    w.prisma.stockCountLine.findUnique.mockResolvedValue(existing());

    await save({ countedQty: 90 });

    const data = w.prisma.stockCountLine.update.mock.calls[0][0].data;
    expect(Number(data.countedQty)).toBe(90);
    expect(Number(data.expectedQty)).toBe(90); // was 100: the sale would have been subtracted twice
  });

  it("an absolute boxes / pieces split re-stamps too", async () => {
    w.prisma.stockCountLine.findUnique.mockResolvedValue(existing());

    await save({ boxes: 0, pieces: 90 });

    expect(Number(w.prisma.stockCountLine.update.mock.calls[0][0].data.expectedQty)).toBe(90);
  });

  // MF1 (r-note 4 A): both clients resend the FULL absolute countedQty on every edit, so a write that
  // does not change the count (a cost edit, a mode toggle, a same-value resend) must keep the baseline.
  it("a COST-ONLY edit (same absolute countedQty) keeps the baseline: no expectedQty in the write", async () => {
    w.prisma.stockCountLine.findUnique.mockResolvedValue(existing());

    await save({ countedQty: 100, unitCostOverride: 3 });

    const data = w.prisma.stockCountLine.update.mock.calls[0][0].data;
    expect(Number(data.countedQty)).toBe(100);
    expect(data).toHaveProperty("unitCostOverride");
    expect(data).not.toHaveProperty("expectedQty");
  });

  it("a MODE-ONLY toggle (same absolute countedQty) keeps the baseline", async () => {
    w.prisma.stockCountLine.findUnique.mockResolvedValue(existing());

    await save({ countedQty: 100, mode: "ADD" });

    const data = w.prisma.stockCountLine.update.mock.calls[0][0].data;
    expect(data.mode).toBe("ADD");
    expect(data).not.toHaveProperty("expectedQty");
  });

  it("the quantity compare is Decimal equality: a stored 100.000 equals a resent 100", async () => {
    w.prisma.stockCountLine.findUnique.mockResolvedValue(existing({ countedQty: D("100.000") }));

    await save({ countedQty: 100 });

    expect(w.prisma.stockCountLine.update.mock.calls[0][0].data).not.toHaveProperty("expectedQty");
  });

  it("a SAME-VALUE recount after a sale keeps the old baseline (accepted residual ambiguity)", async () => {
    w.prisma.stockCountLine.findUnique.mockResolvedValue(existing());

    await save({ countedQty: 100 }); // live stock is 90; the recount equals the stored count

    expect(w.prisma.stockCountLine.update.mock.calls[0][0].data).not.toHaveProperty("expectedQty");
  });

  describe("boxed product (12 per box)", () => {
    beforeEach(() => {
      w.prisma.product.findFirst.mockResolvedValue({
        id: pid(1),
        name: "Widget",
        kind: "STANDARD",
        currentStock: D(90),
        unitsPerBox: 12,
      });
    });

    it("a changed boxes / pieces split at the SAME quantity counts as a change and re-stamps", async () => {
      w.prisma.stockCountLine.findUnique.mockResolvedValue(
        existing({ countedQty: D(24), boxes: null, pieces: null }), // a legacy line without a split
      );

      await save({ boxes: 2, pieces: 0 });

      const data = w.prisma.stockCountLine.update.mock.calls[0][0].data;
      expect(Number(data.countedQty)).toBe(24);
      expect(Number(data.expectedQty)).toBe(90);
    });

    it("the same split resent (even as 1 box + 12 pieces, which rolls over) keeps the baseline", async () => {
      w.prisma.stockCountLine.findUnique.mockResolvedValue(
        existing({ countedQty: D(24), boxes: 2, pieces: 0 }),
      );

      await save({ boxes: 1, pieces: 12 });

      expect(w.prisma.stockCountLine.update.mock.calls[0][0].data).not.toHaveProperty(
        "expectedQty",
      );
    });
  });

  it("an INCREMENT scan on an existing line keeps the baseline (no expectedQty in the write)", async () => {
    w.prisma.stockCountLine.findUnique.mockResolvedValue(existing({ countedQty: D(4) }));

    await save({ countedQty: 1, increment: true });

    const data = w.prisma.stockCountLine.update.mock.calls[0][0].data;
    expect(Number(data.countedQty)).toBe(5);
    expect(data).not.toHaveProperty("expectedQty");
  });

  it("the FIRST increment scan creates the line with the live stock as its baseline", async () => {
    w.prisma.stockCountLine.findUnique.mockResolvedValue(null);

    await save({ countedQty: 1, increment: true });

    const data = w.prisma.stockCountLine.create.mock.calls[0][0].data;
    expect(Number(data.countedQty)).toBe(1);
    expect(Number(data.expectedQty)).toBe(90);
  });
});
