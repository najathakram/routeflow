import { Prisma } from "@prisma/client";
import {
  REAL_INVOICE_STATUSES,
  buildCostIndex,
  costAt,
  estimateCogs,
  fetchCostIndex,
  fetchInvoicedSaleLines,
  fetchProductCostFacts,
  resolveUnitCost,
  roundQty,
  soldProductIds,
} from "./invoiced-sales";

const D = (n: number | string) => new Prisma.Decimal(n);

/** Stub db with ONLY the three models the helpers may touch — a query against
 *  anything else (e.g. invoiceItem) is structurally impossible, pinning the
 *  through-Invoice rule at the type/shape level. */
const stubDb = (opts: { invoices?: any[]; movements?: any[]; products?: any[] } = {}) => ({
  invoice: { findMany: jest.fn().mockResolvedValue(opts.invoices ?? []) },
  stockMovement: { findMany: jest.fn().mockResolvedValue(opts.movements ?? []) },
  product: { findMany: jest.fn().mockResolvedValue(opts.products ?? []) },
});

describe("fetchInvoicedSaleLines", () => {
  const win = { from: new Date("2026-06-01"), to: new Date("2026-06-30") };

  it("queries THROUGH invoice.findMany with the real-sale statuses by default", async () => {
    const db = stubDb();

    await fetchInvoicedSaleLines(db, { ...win, dateBasis: "issueDate" });

    const args = db.invoice.findMany.mock.calls[0][0];
    expect(args.where.status).toBe(REAL_INVOICE_STATUSES);
    expect(args.where.status).toEqual({ notIn: ["DRAFT", "VOID", "WRITTEN_OFF"] });
    expect(args.where.issueDate).toEqual({ gte: win.from, lte: win.to });
    expect(args.where.paidAt).toBeUndefined();
  });

  it("windows on paidAt (not issueDate) for the paidAt basis, and passes PAID through", async () => {
    const db = stubDb();

    await fetchInvoicedSaleLines(db, { ...win, dateBasis: "paidAt", status: "PAID" as any });

    const args = db.invoice.findMany.mock.calls[0][0];
    expect(args.where.status).toBe("PAID");
    expect(args.where.paidAt).toEqual({ gte: win.from, lte: win.to });
    expect(args.where.issueDate).toBeUndefined();
  });

  it("flattens lines, Number()s Decimals, and carries the parent invoice's dates", async () => {
    const issueDate = new Date("2026-06-10");
    const paidAt = new Date("2026-06-20");
    const db = stubDb({
      invoices: [
        {
          issueDate,
          paidAt,
          items: [
            {
              productId: "p1",
              qty: D(27),
              subtotal: D(43.75),
              product: { name: "Water", isTobacco: false },
            },
            { productId: null, qty: D(1), subtotal: D(9.99), product: null },
          ],
        },
      ],
    });

    const lines = await fetchInvoicedSaleLines(db, { ...win, dateBasis: "issueDate" });

    expect(lines).toEqual([
      {
        productId: "p1",
        qty: 27,
        subtotal: 43.75,
        productName: "Water",
        isTobacco: false,
        issueDate,
        paidAt,
      },
      {
        productId: null,
        qty: 1,
        subtotal: 9.99,
        productName: null,
        isTobacco: false,
        issueDate,
        paidAt,
      },
    ]);
  });
});

describe("cost index", () => {
  const rows = [
    { productId: "p1", createdAt: new Date("2026-06-10"), avgCostAfter: D(3) },
    { productId: "p1", createdAt: new Date("2026-06-01"), avgCostAfter: D(2) }, // out of order
    { productId: "p2", createdAt: new Date("2026-06-05"), avgCostAfter: D(7) },
    { productId: "p1", createdAt: new Date("2026-06-20"), avgCostAfter: null }, // skipped
  ];

  it("buildCostIndex groups by product, sorts, Number()s, and skips null snapshots", () => {
    const index = buildCostIndex(rows);

    expect(index.get("p1")).toEqual([
      { t: new Date("2026-06-01").getTime(), cost: 2 },
      { t: new Date("2026-06-10").getTime(), cost: 3 },
    ]);
    expect(index.get("p2")).toHaveLength(1);
  });

  it("costAt picks the latest snapshot at or before the date (inclusive <=)", () => {
    const index = buildCostIndex(rows);

    expect(costAt(index, "p1", new Date("2026-05-31"))).toBeNull(); // before first
    expect(costAt(index, "p1", new Date("2026-06-01"))).toBe(2); // exact match inclusive
    expect(costAt(index, "p1", new Date("2026-06-05"))).toBe(2); // between → earlier
    expect(costAt(index, "p1", new Date("2026-06-10"))).toBe(3);
    expect(costAt(index, "p1", new Date("2026-07-01"))).toBe(3); // after last → last
    expect(costAt(index, "unknown", new Date("2026-06-05"))).toBeNull();
  });
});

describe("resolveUnitCost fallback ladder", () => {
  const at = new Date("2026-06-05");
  const index = buildCostIndex([
    { productId: "p1", createdAt: new Date("2026-06-01"), avgCostAfter: D(2) },
  ]);

  it("a point-in-time snapshot wins even for STANDARD products", () => {
    const facts = { costingMethod: "STANDARD", standardCost: D(9), averageCost: D(5) };
    expect(resolveUnitCost(index, "p1", at, facts)).toBe(2);
  });

  it("no snapshot + STANDARD → standardCost", () => {
    const facts = { costingMethod: "STANDARD", standardCost: D(9), averageCost: D(5) };
    expect(resolveUnitCost(index, "p2", at, facts)).toBe(9);
  });

  it("no snapshot + non-STANDARD → current averageCost", () => {
    const facts = { costingMethod: "FIFO", standardCost: null, averageCost: D(5) };
    expect(resolveUnitCost(index, "p2", at, facts)).toBe(5);
  });

  it("nothing at all → 0; missing facts → 0", () => {
    expect(
      resolveUnitCost(index, "p2", at, {
        costingMethod: "FIFO",
        standardCost: null,
        averageCost: null,
      }),
    ).toBe(0);
    expect(resolveUnitCost(index, "p2", at, undefined)).toBe(0);
  });
});

describe("estimateCogs", () => {
  const index = buildCostIndex([
    { productId: "p1", createdAt: new Date("2026-06-01"), avgCostAfter: D(2) },
    { productId: "p1", createdAt: new Date("2026-06-10"), avgCostAfter: D(3) },
  ]);
  const facts = new Map([
    ["p1", { costingMethod: "FIFO", standardCost: null, averageCost: D(99) }],
  ]);

  it("costs each line at its OWN issueDate (lines straddling a snapshot differ)", () => {
    const lines = [
      { productId: "p1", qty: 5, issueDate: new Date("2026-06-05"), isTobacco: false },
      { productId: "p1", qty: 3, issueDate: new Date("2026-06-15"), isTobacco: false },
    ];
    expect(estimateCogs(lines, index, facts)).toBe(19); // 5×2 + 3×3
  });

  it("ad-hoc lines (null productId) contribute nothing", () => {
    const lines = [
      { productId: null, qty: 100, issueDate: new Date("2026-06-05"), isTobacco: false },
    ];
    expect(estimateCogs(lines, index, facts)).toBe(0);
  });

  it("excludeTobacco skips tobacco lines", () => {
    const lines = [
      { productId: "p1", qty: 5, issueDate: new Date("2026-06-05"), isTobacco: true },
      { productId: "p1", qty: 1, issueDate: new Date("2026-06-05"), isTobacco: false },
    ];
    expect(estimateCogs(lines, index, facts, { excludeTobacco: true })).toBe(2);
    expect(estimateCogs(lines, index, facts)).toBe(12);
  });
});

describe("fetchers", () => {
  it("fetchCostIndex skips the query entirely for an empty product set", async () => {
    const db = stubDb();
    const index = await fetchCostIndex(db, [], new Date());
    expect(index.size).toBe(0);
    expect(db.stockMovement.findMany).not.toHaveBeenCalled();
  });

  it("fetchCostIndex queries snapshots only — any type, non-null avgCostAfter", async () => {
    const until = new Date("2026-06-30");
    const db = stubDb({
      movements: [{ productId: "p1", createdAt: new Date("2026-06-01"), avgCostAfter: D(2) }],
    });

    const index = await fetchCostIndex(db, ["p1"], until);

    expect(db.stockMovement.findMany).toHaveBeenCalledWith({
      where: { productId: { in: ["p1"] }, avgCostAfter: { not: null }, createdAt: { lte: until } },
      select: { productId: true, createdAt: true, avgCostAfter: true },
      orderBy: { createdAt: "asc" },
    });
    expect(costAt(index, "p1", until)).toBe(2);
  });

  it("fetchProductCostFacts maps products by id and skips empty sets", async () => {
    const empty = stubDb();
    expect((await fetchProductCostFacts(empty, [])).size).toBe(0);
    expect(empty.product.findMany).not.toHaveBeenCalled();

    const db = stubDb({
      products: [{ id: "p1", costingMethod: "FIFO", standardCost: null, averageCost: D(4) }],
    });
    const facts = await fetchProductCostFacts(db, ["p1"]);
    expect(facts.get("p1")).toEqual({
      costingMethod: "FIFO",
      standardCost: null,
      averageCost: D(4),
    });
  });
});

describe("small helpers", () => {
  it("soldProductIds dedupes and drops nulls", () => {
    expect(
      soldProductIds([
        { productId: "p1" },
        { productId: null },
        { productId: "p1" },
        { productId: "p2" },
      ]),
    ).toEqual(["p1", "p2"]);
  });

  it("roundQty rounds to 3dp and zeroes non-finite input", () => {
    expect(roundQty(0.1 + 0.2)).toBe(0.3);
    expect(roundQty(1.23456)).toBe(1.235);
    expect(roundQty(Number.NaN)).toBe(0);
    expect(roundQty(Number.POSITIVE_INFINITY)).toBe(0);
  });
});
