import { Test, TestingModule } from "@nestjs/testing";
import { Prisma } from "@prisma/client";
import { AnalyticsService } from "./analytics.service";
import { PrismaService } from "../prisma/prisma.service";
import { AddonService } from "../billing/addon.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { createMockPrisma } from "../testing/prisma-mock";

const D = (n: number | string) => new Prisma.Decimal(n);

describe("AnalyticsService — invoiced-sales readers", () => {
  let service: AnalyticsService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let addonService: { hasAddon: jest.Mock };
  let systemConfig: { get: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrisma();
    addonService = { hasAddon: jest.fn().mockResolvedValue(false) };
    systemConfig = { get: jest.fn().mockResolvedValue(null) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnalyticsService,
        { provide: PrismaService, useValue: prisma },
        { provide: AddonService, useValue: addonService },
        { provide: SystemConfigService, useValue: systemConfig },
      ],
    }).compile();

    service = module.get<AnalyticsService>(AnalyticsService);
  });

  describe("getGrossMarginTrend", () => {
    it("estimates COGS at each invoice's point-in-time average cost", async () => {
      prisma.invoice.findMany.mockResolvedValue([
        {
          total: D(100),
          issueDate: new Date("2026-06-05"),
          items: [
            {
              productId: "p1",
              qty: D(5),
              subtotal: D(100),
              taxRate: D(0),
              product: { isTobacco: false },
            },
          ],
        },
        {
          total: D(90),
          issueDate: new Date("2026-06-15"),
          items: [
            {
              productId: "p1",
              qty: D(3),
              subtotal: D(90),
              taxRate: D(0),
              product: { isTobacco: false },
            },
          ],
        },
      ]);
      // avgCostAfter snapshots: 2.00 until June 10, then 3.00 — the two
      // invoices straddle the change and must be costed differently.
      prisma.stockMovement.findMany.mockResolvedValue([
        { productId: "p1", createdAt: new Date("2026-06-01"), avgCostAfter: D(2) },
        { productId: "p1", createdAt: new Date("2026-06-10"), avgCostAfter: D(3) },
      ]);

      const result = await service.getGrossMarginTrend();

      expect(result.revenue).toBe(190);
      expect(result.cogs).toBe(19); // 5 × 2.00 (June 5) + 3 × 3.00 (June 15)
      expect(result.grossProfit).toBe(171);
      expect(result.grossMarginPct).toBe(90);
    });

    it("falls back to current averageCost when no snapshot predates the sale", async () => {
      prisma.invoice.findMany.mockResolvedValue([
        {
          total: D(50),
          issueDate: new Date("2026-06-05"),
          items: [
            {
              productId: "p1",
              qty: D(2),
              subtotal: D(50),
              taxRate: D(0),
              product: { isTobacco: false },
            },
          ],
        },
      ]);
      prisma.stockMovement.findMany.mockResolvedValue([]); // no snapshots at all
      prisma.product.findMany.mockResolvedValue([
        { id: "p1", costingMethod: "FIFO", standardCost: null, averageCost: D(4) },
      ]);

      const result = await service.getGrossMarginTrend();

      expect(result.cogs).toBe(8);
      expect(result.grossProfit).toBe(42);
    });

    it("adds ad-hoc (null productId) line revenue with zero COGS and no cost queries", async () => {
      prisma.invoice.findMany.mockResolvedValue([
        {
          total: D(50),
          issueDate: new Date("2026-06-05"),
          items: [{ productId: null, qty: D(5), subtotal: D(50), taxRate: D(0), product: null }],
        },
      ]);

      const result = await service.getGrossMarginTrend();

      expect(result.revenue).toBe(50);
      expect(result.cogs).toBe(0);
      // No sold products → no snapshot or cost-facts queries at all.
      expect(prisma.stockMovement.findMany).not.toHaveBeenCalled();
      expect(prisma.product.findMany).not.toHaveBeenCalled();
    });

    it("no longer reads SALE movements — one invoice fetch feeds revenue AND COGS", async () => {
      prisma.invoice.findMany.mockResolvedValue([
        {
          total: D(10),
          issueDate: new Date("2026-06-05"),
          items: [
            {
              productId: "p1",
              qty: D(1),
              subtotal: D(10),
              taxRate: D(0),
              product: { isTobacco: false },
            },
          ],
        },
      ]);

      await service.getGrossMarginTrend();

      expect(prisma.invoice.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.invoiceItem.findMany).not.toHaveBeenCalled();
      // The only movement query is the snapshot index — never type:"SALE".
      const movementArgs = prisma.stockMovement.findMany.mock.calls[0][0];
      expect(movementArgs.where).toEqual({
        productId: { in: ["p1"] },
        avgCostAfter: { not: null },
        createdAt: { lte: expect.any(Date) },
      });
    });
  });

  describe("getTopProducts", () => {
    const invoiceFixture = [
      {
        issueDate: new Date("2026-06-05"),
        paidAt: null,
        items: [
          {
            productId: "p1",
            qty: D(10),
            subtotal: D(40),
            product: { name: "Flour", isTobacco: false },
          },
          {
            productId: "p2",
            qty: D(2),
            subtotal: D(90),
            product: { name: "Sugar", isTobacco: false },
          },
          { productId: null, qty: D(1), subtotal: D(999), product: null }, // ad-hoc line
        ],
      },
      {
        issueDate: new Date("2026-06-10"),
        paidAt: null,
        items: [
          {
            productId: "p1",
            qty: D(5),
            subtotal: D(20),
            product: { name: "Flour", isTobacco: false },
          },
        ],
      },
    ];

    it("returns BOTH metrics per row; metric only picks the sort; ad-hoc lines drop", async () => {
      prisma.invoice.findMany.mockResolvedValue(invoiceFixture);

      const byRevenue = await service.getTopProducts("revenue", 10);
      expect(byRevenue).toEqual([
        { id: "p2", name: "Sugar", unitsSold: 2, totalRevenue: 90 },
        { id: "p1", name: "Flour", unitsSold: 15, totalRevenue: 60 },
      ]);

      const byUnits = await service.getTopProducts("units", 10);
      expect(byUnits.map((p) => p.id)).toEqual(["p1", "p2"]);
    });

    it("sums revenue from subtotal — NEVER qty × unitPrice (boxed-line overcharge)", async () => {
      // A boxed line: 2 cases + 3 packs @ unitsPerBox 12 stores qty 27. Re-deriving
      // revenue as qty × unitPrice would report 1181.25 instead of the real 43.75.
      prisma.invoice.findMany.mockResolvedValue([
        {
          issueDate: new Date("2026-06-05"),
          items: [
            {
              productId: "p1",
              qty: D(27),
              unitPrice: D(43.75),
              subtotal: D(43.75),
              boxes: 2,
              pieces: 3,
              unitsPerBox: 12,
              product: { name: "Water", isTobacco: false },
            },
          ],
        },
      ]);

      const res = await service.getTopProducts();

      expect(res).toEqual([{ id: "p1", name: "Water", unitsSold: 27, totalRevenue: 43.75 }]);
    });

    it("windows on issueDate with real statuses and never touches the dead sources", async () => {
      await service.getTopProducts("revenue", 10, "2026-01-01", "2026-06-30");

      const args = prisma.invoice.findMany.mock.calls[0][0];
      expect(args.where.status).toEqual({ notIn: ["DRAFT", "VOID", "WRITTEN_OFF"] });
      expect(args.where.issueDate.gte).toEqual(new Date("2026-01-01"));
      expect(args.where.issueDate.lte.toISOString()).toContain("2026-06-30T23:59:59");
      // The old sources are both dead: SALE movements have no writer, and
      // TransactionItem never had one. Queried through Invoice (tenantId trap).
      expect(prisma.stockMovement.findMany).not.toHaveBeenCalled();
      expect(prisma.transactionItem.findMany).not.toHaveBeenCalled();
      expect(prisma.invoiceItem.findMany).not.toHaveBeenCalled();
    });

    it("skips tobacco lines when the exclusion toggle is active", async () => {
      addonService.hasAddon.mockResolvedValue(true);
      systemConfig.get.mockResolvedValue("true");
      prisma.invoice.findMany.mockResolvedValue([
        {
          issueDate: new Date("2026-06-05"),
          items: [
            {
              productId: "pt",
              qty: D(3),
              subtotal: D(60),
              product: { name: "Cigars", isTobacco: true },
            },
            {
              productId: "pn",
              qty: D(5),
              subtotal: D(50),
              product: { name: "Bread", isTobacco: false },
            },
          ],
        },
      ]);

      const res = await service.getTopProducts();

      expect(res).toEqual([{ id: "pn", name: "Bread", unitsSold: 5, totalRevenue: 50 }]);
    });
  });

  describe("getInventoryTurnover", () => {
    it("computes unitsSold and turnoverRate from invoiced sales", async () => {
      prisma.product.findMany.mockResolvedValue([
        { id: "p1", name: "Flour", currentStock: D(20) },
        { id: "p2", name: "Sugar", currentStock: D(0) },
      ]);
      prisma.invoice.findMany.mockResolvedValue([
        {
          issueDate: new Date("2026-06-05"),
          items: [
            {
              productId: "p1",
              qty: D(10),
              subtotal: D(40),
              product: { name: "Flour", isTobacco: false },
            },
          ],
        },
      ]);

      const res = await service.getInventoryTurnover();

      expect(res).toEqual([
        { id: "p1", name: "Flour", unitsSold: 10, currentStock: 20, turnoverRate: 0.5 },
        { id: "p2", name: "Sugar", unitsSold: 0, currentStock: 0, turnoverRate: 0 },
      ]);
      expect(prisma.stockMovement.findMany).not.toHaveBeenCalled();
      expect(prisma.invoiceItem.findMany).not.toHaveBeenCalled();
    });

    it("keeps the tobacco exclusion on the products list", async () => {
      addonService.hasAddon.mockResolvedValue(true);
      systemConfig.get.mockResolvedValue("true");
      prisma.product.findMany.mockResolvedValue([]);

      await service.getInventoryTurnover();

      expect(prisma.product.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ isTobacco: false }),
        }),
      );
    });
  });

  describe("getDeadStock", () => {
    const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

    it("a recent invoiced sale rescues a product no movement ever touched", async () => {
      prisma.product.findMany.mockResolvedValue([
        { id: "selling", name: "Selling", currentStock: D(5) },
        { id: "dead", name: "Dead", currentStock: D(9) },
      ]);
      prisma.invoice.findMany.mockResolvedValue([
        { issueDate: daysAgo(2), items: [{ productId: "selling" }] },
        { issueDate: daysAgo(90), items: [{ productId: "dead" }] },
      ]);
      // No movements at all (both the recent-window and candidate-history calls).
      prisma.stockMovement.findMany.mockResolvedValue([]);

      const res = await service.getDeadStock(30);

      expect(res.map((r) => r.id)).toEqual(["dead"]);
      expect(res[0].daysInactive).toBe(90);
    });

    it("reports the most recent of last movement vs last sale", async () => {
      prisma.product.findMany.mockResolvedValue([{ id: "p1", name: "P1", currentStock: D(3) }]);
      prisma.invoice.findMany.mockResolvedValue([
        { issueDate: daysAgo(80), items: [{ productId: "p1" }] },
      ]);
      prisma.stockMovement.findMany
        .mockResolvedValueOnce([]) // nothing since the cutoff
        .mockResolvedValueOnce([{ productId: "p1", createdAt: daysAgo(40) }]);

      const res = await service.getDeadStock(30);

      expect(res).toHaveLength(1);
      expect(res[0].daysInactive).toBe(40); // movement (40d) is newer than the sale (80d)
    });

    it("keeps the parameterless rolling window open-ended (gte only)", async () => {
      prisma.product.findMany.mockResolvedValue([{ id: "p1", name: "P1", currentStock: D(3) }]);
      prisma.invoice.findMany.mockResolvedValue([]);
      prisma.stockMovement.findMany.mockResolvedValue([]);

      await service.getDeadStock(30);

      const { createdAt } = prisma.stockMovement.findMany.mock.calls[0][0].where;
      expect(createdAt.gte).toEqual(expect.any(Date));
      expect(createdAt.lte).toBeUndefined();
    });

    it("a from/to range REPLACES the rolling window — activity outside it doesn't rescue", async () => {
      prisma.product.findMany.mockResolvedValue([
        { id: "sold-in", name: "In-range", currentStock: D(5) },
        { id: "sold-out", name: "Out-of-range", currentStock: D(9) },
      ]);
      prisma.invoice.findMany.mockResolvedValue([
        { issueDate: new Date("2026-05-10"), items: [{ productId: "sold-in" }] },
        // Sold AFTER the window closes — active today, but dead within May.
        { issueDate: new Date("2026-06-20"), items: [{ productId: "sold-out" }] },
      ]);
      prisma.stockMovement.findMany.mockResolvedValue([]);

      const res = await service.getDeadStock(30, "2026-05-01", "2026-05-31");

      expect(res.map((r) => r.id)).toEqual(["sold-out"]);
      // Display fields stay "most recent activity ever", not range-clipped.
      expect(res[0].lastMovement).toEqual(new Date("2026-06-20"));
      // The movement query is bounded to the same window.
      const { createdAt } = prisma.stockMovement.findMany.mock.calls[0][0].where;
      expect(createdAt.gte).toEqual(new Date("2026-05-01"));
      expect(createdAt.lte.toISOString()).toContain("2026-05-31T23:59:59");
    });
  });

  describe("getDso", () => {
    it("averages days from issue to payment across PAID invoices, unwindowed by default", async () => {
      prisma.invoice.findMany.mockResolvedValue([
        { issueDate: new Date("2026-06-01"), paidAt: new Date("2026-06-11") }, // 10d
        { issueDate: new Date("2026-06-01"), paidAt: new Date("2026-06-21") }, // 20d
      ]);

      const res = await service.getDso();

      expect(res).toEqual({ dso: 15, count: 2 });
      // No bounds ⇒ no issueDate filter — mobile's parameterless call stays all-time.
      expect(prisma.invoice.findMany.mock.calls[0][0].where).toEqual({
        status: "PAID",
        paidAt: { not: null },
      });
    });

    it("windows on issueDate when from/to are given — payment may land after `to`", async () => {
      prisma.invoice.findMany.mockResolvedValue([
        { issueDate: new Date("2026-06-15"), paidAt: new Date("2026-08-14") }, // 60d
      ]);

      const res = await service.getDso("2026-06-01", "2026-06-30");

      expect(res).toEqual({ dso: 60, count: 1 });
      const { where } = prisma.invoice.findMany.mock.calls[0][0];
      expect(where.status).toBe("PAID");
      expect(where.issueDate.gte).toEqual(new Date("2026-06-01"));
      expect(where.issueDate.lte.toISOString()).toContain("2026-06-30T23:59:59");
    });

    it("returns zeros for an empty window", async () => {
      prisma.invoice.findMany.mockResolvedValue([]);

      expect(await service.getDso("2026-01-01", "2026-01-31")).toEqual({ dso: 0, count: 0 });
    });
  });

  describe("tobacco exclusion toggle", () => {
    const tobaccoInvoice = {
      total: D(110),
      issueDate: new Date("2026-06-05"),
      items: [
        {
          productId: "pt",
          qty: D(2),
          subtotal: D(60),
          taxRate: D(0),
          product: { isTobacco: true },
        },
        {
          productId: "pn",
          qty: D(5),
          subtotal: D(50),
          taxRate: D(0),
          product: { isTobacco: false },
        },
      ],
    };

    it("subtracts tobacco revenue AND skips tobacco lines from COGS", async () => {
      addonService.hasAddon.mockResolvedValue(true);
      systemConfig.get.mockResolvedValue("true");
      prisma.invoice.findMany.mockResolvedValue([tobaccoInvoice]);
      prisma.stockMovement.findMany.mockResolvedValue([
        { productId: "pt", createdAt: new Date("2026-06-01"), avgCostAfter: D(10) },
        { productId: "pn", createdAt: new Date("2026-06-01"), avgCostAfter: D(2) },
      ]);

      const result = await service.getGrossMarginTrend();

      expect(result.revenue).toBe(50);
      expect(result.cogs).toBe(10); // 5 × 2.00 — the tobacco line contributes nothing
    });

    it("is inert when the addon is inactive even if the config key is set", async () => {
      addonService.hasAddon.mockResolvedValue(false);
      systemConfig.get.mockResolvedValue("true");
      prisma.invoice.findMany.mockResolvedValue([{ total: D(110) }]);
      prisma.stockMovement.findMany.mockResolvedValue([]);

      const result = await service.getGrossMarginTrend();

      expect(result.revenue).toBe(110);
      expect(systemConfig.get).not.toHaveBeenCalled();
    });

    it("is inert when the toggle is off", async () => {
      addonService.hasAddon.mockResolvedValue(true);
      systemConfig.get.mockResolvedValue("false");
      prisma.invoice.findMany.mockResolvedValue([{ total: D(110) }]);
      prisma.stockMovement.findMany.mockResolvedValue([]);

      const result = await service.getGrossMarginTrend();

      expect(result.revenue).toBe(110);
    });

    it("keeps the invoice COUNT in AOV while removing tobacco value", async () => {
      addonService.hasAddon.mockResolvedValue(true);
      systemConfig.get.mockResolvedValue("true");
      prisma.invoice.findMany.mockResolvedValue([tobaccoInvoice, { total: D(50), items: [] }]);

      const result = await service.getAverageOrderValue();

      expect(result.count).toBe(2);
      expect(result.total).toBe(100); // 110-60 + 50
      expect(result.aov).toBe(50);
    });

    it("skips tobacco categories in sales-by-category", async () => {
      addonService.hasAddon.mockResolvedValue(true);
      systemConfig.get.mockResolvedValue("true");
      prisma.orderItem.findMany.mockResolvedValue([
        { subtotal: D(60), product: { category: "Tobacco", isTobacco: true } },
        { subtotal: D(50), product: { category: "Bakery", isTobacco: false } },
      ]);

      const result = await service.getSalesByCategory();

      expect(result).toEqual([{ category: "Bakery", revenue: 50 }]);
    });
  });

  describe("getCostHistory", () => {
    it("includes COST_BASIS movements and running average snapshots", async () => {
      const day1 = new Date("2026-06-01");
      const day2 = new Date("2026-06-15");
      prisma.stockMovement.findMany.mockResolvedValue([
        {
          createdAt: day1,
          unitCost: D(2),
          avgCostAfter: D(2),
          type: "PURCHASE",
        },
        {
          createdAt: day2,
          unitCost: D(3.15),
          avgCostAfter: D(3.15),
          type: "COST_BASIS",
        },
      ]);

      const result = await service.getCostHistory("p1");

      expect(prisma.stockMovement.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { productId: "p1", type: { in: ["PURCHASE", "COST_BASIS"] } },
        }),
      );
      expect(result).toEqual([
        { date: day1, unitCost: 2, avgCostAfter: 2, type: "PURCHASE" },
        { date: day2, unitCost: 3.15, avgCostAfter: 3.15, type: "COST_BASIS" },
      ]);
    });
  });

  // ─── PR-B: per-buyer sales history behind the product Sales tab ───────────
  describe("getProductSales", () => {
    const inv = (over: Record<string, any> = {}) => ({
      id: "inv-1",
      invoiceNumber: "INV-1",
      orderId: "ord-1",
      order: { orderNumber: "ORD-1042" },
      issueDate: new Date("2026-06-05"),
      customerId: "cust-1",
      customer: { id: "cust-1", businessName: "Acme Grocers" },
      items: [
        {
          qty: D(24),
          boxes: 2,
          pieces: 0,
          unitsPerBox: 12,
          unitPrice: D(30),
          subtotal: D(60),
          originalPrice: null,
          priceType: "STANDARD",
        },
      ],
      ...over,
    });

    it("reads THROUGH Invoice (never invoiceItem) and filters to real sales", async () => {
      prisma.invoice.findMany.mockResolvedValue([inv()]);

      await service.getProductSales("p1");

      // Nested-created invoice lines can carry tenantId = null, so a direct
      // invoiceItem query under forTenant() would silently drop most history.
      expect(prisma.invoiceItem.findMany).not.toHaveBeenCalled();
      const args = prisma.invoice.findMany.mock.calls[0][0];
      expect(args.where.items).toEqual({ some: { productId: "p1" } });
      expect(args.where.status).toEqual({ notIn: ["DRAFT", "VOID", "WRITTEN_OFF"] });
      // Only this product's lines come back, not every line on the invoice.
      expect(args.select.items.where).toEqual({ productId: "p1" });
    });

    it("keeps the stored subtotal for a boxed line instead of qty × unitPrice", async () => {
      prisma.invoice.findMany.mockResolvedValue([inv()]);

      const res = await service.getProductSales("p1");

      // 2 boxes at a $30 BOX price = $60. Re-deriving 24 × 30 = $720 would
      // over-charge by unitsPerBox — the money-discipline trap.
      expect(res.lines[0]).toMatchObject({
        qty: 24,
        boxes: 2,
        pieces: 0,
        unitsPerBox: 12,
        unitPrice: 30,
        lineTotal: 60,
        customerName: "Acme Grocers",
        invoiceNumber: "INV-1",
        orderId: "ord-1",
        orderNumber: "ORD-1042",
      });
      expect(res.summary.totalRevenue).toBe(60);
    });

    it("a directly-raised invoice reports no order, never a sliced uuid", async () => {
      prisma.invoice.findMany.mockResolvedValue([inv({ orderId: null, order: null })]);

      const res = await service.getProductSales("p1");

      expect(res.lines[0].orderId).toBeNull();
      expect(res.lines[0].orderNumber).toBeNull();
    });

    it("flags a re-priced line and carries its struck-through original", async () => {
      prisma.invoice.findMany.mockResolvedValue([
        inv({
          items: [
            {
              qty: D(3),
              boxes: null,
              pieces: null,
              unitsPerBox: null,
              unitPrice: D(8),
              subtotal: D(24),
              originalPrice: D(10),
              priceType: "DISCOUNTED",
            },
          ],
        }),
      ]);

      const res = await service.getProductSales("p1");

      expect(res.lines[0]).toMatchObject({ unitPrice: 8, originalPrice: 10, overridden: true });
    });

    it("averages by revenue per unit, counts distinct buyers, and spans invoices", async () => {
      prisma.invoice.findMany.mockResolvedValue([
        inv(),
        inv({
          id: "inv-2",
          invoiceNumber: "INV-2",
          customerId: "cust-2",
          customer: { id: "cust-2", businessName: "Bodega Two" },
          items: [
            {
              qty: D(6),
              boxes: null,
              pieces: null,
              unitsPerBox: null,
              unitPrice: D(4),
              subtotal: D(24),
              originalPrice: null,
              priceType: "STANDARD",
            },
          ],
        }),
      ]);

      const res = await service.getProductSales("p1");

      expect(res.summary).toMatchObject({
        count: 2,
        buyers: 2,
        totalQty: 30,
        totalRevenue: 84,
        minPrice: 4,
        maxPrice: 30,
        // Weighted: 84 / 30 units — NOT the (30+4)/2 = 17 mean of unit prices.
        avgPrice: 2.8,
      });
    });

    it("renders a deleted customer without crashing, and empties cleanly", async () => {
      prisma.invoice.findMany.mockResolvedValue([inv({ customer: null })]);
      const res = await service.getProductSales("p1");
      expect(res.lines[0].customerName).toBe("—");

      prisma.invoice.findMany.mockResolvedValue([]);
      const empty = await service.getProductSales("p1");
      expect(empty.lines).toEqual([]);
      expect(empty.summary).toMatchObject({
        count: 0,
        buyers: 0,
        totalQty: 0,
        totalRevenue: 0,
        minPrice: null,
        maxPrice: null,
        avgPrice: null,
      });
    });
  });

  describe("getProductDemand", () => {
    const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
    /** The "YYYY-MM-DD" bucket key a date lands in, for locating points by value. */
    const dayKey = (d: Date) => d.toISOString().slice(0, 10);

    it("buckets units and revenue by the invoice issue date", async () => {
      const today = daysAgo(0);
      const older = daysAgo(3);
      prisma.invoice.findMany.mockResolvedValue([
        { issueDate: today, items: [{ qty: D(5), subtotal: D(50) }] },
        { issueDate: older, items: [{ qty: D(2), subtotal: D(20) }] },
      ]);

      const res = await service.getProductDemand("p1", "30d");

      expect(res.buckets.find((b) => b.date === dayKey(today))).toMatchObject({
        units: 5,
        revenue: 50,
      });
      expect(res.buckets.find((b) => b.date === dayKey(older))).toMatchObject({
        units: 2,
        revenue: 20,
      });
      expect(res.totals).toEqual({ units: 7, revenue: 70 });
      expect(res.granularity).toBe("day");
    });

    it("sums revenue from subtotal — NEVER qty × unitPrice (boxed-line overcharge)", async () => {
      // A boxed line: 2 cases + 3 packs @ unitsPerBox 12 stores qty 27. Re-deriving
      // revenue as qty × unitPrice would bill 1181.25 instead of the real 43.75.
      prisma.invoice.findMany.mockResolvedValue([
        {
          issueDate: daysAgo(1),
          items: [
            {
              qty: D(27),
              unitPrice: D(43.75),
              subtotal: D(43.75),
              boxes: 2,
              pieces: 3,
              unitsPerBox: 12,
            },
          ],
        },
      ]);

      const res = await service.getProductDemand("p1", "30d");

      expect(res.totals.revenue).toBe(43.75);
      expect(res.totals.units).toBe(27);
    });

    it.each([
      ["30d", 30],
      ["6m", 26],
      ["1y", 12],
      ["5y", 60],
    ] as const)("zero-fills every bucket for %s", async (range, count) => {
      prisma.invoice.findMany.mockResolvedValue([]);

      const res = await service.getProductDemand("p1", range);

      expect(res.buckets).toHaveLength(count);
      expect(res.buckets.every((b) => b.units === 0 && b.revenue === 0)).toBe(true);
      expect(res.totals).toEqual({ units: 0, revenue: 0 });
      expect(res.range).toBe(range);
    });

    it("filters out DRAFT/VOID/WRITTEN_OFF and matches only this product's lines", async () => {
      prisma.invoice.findMany.mockResolvedValue([]);

      await service.getProductDemand("p1", "30d");

      const args = prisma.invoice.findMany.mock.calls[0][0];
      expect(args.where.status).toEqual({ notIn: ["DRAFT", "VOID", "WRITTEN_OFF"] });
      expect(args.where.items).toEqual({ some: { productId: "p1" } });
      // The nested filter is what keeps other products' (and null-productId ad-hoc)
      // lines out of each invoice's item array.
      expect(args.select.items.where).toEqual({ productId: "p1" });
    });

    it("queries THROUGH Invoice, never invoiceItem directly", async () => {
      // Invoice lines are nested-created, so many carry tenantId = null; forTenant()
      // injects where.tenantId and would silently drop them. Guards a "simplification"
      // back to invoiceItem.findMany, which would lose most of the history.
      prisma.invoice.findMany.mockResolvedValue([]);

      await service.getProductDemand("p1", "1y");

      expect(prisma.forTenant).toHaveBeenCalled();
      expect(prisma.invoiceItem.findMany).not.toHaveBeenCalled();
    });

    it("uses a half-open window whose width matches the range", async () => {
      prisma.invoice.findMany.mockResolvedValue([]);

      await service.getProductDemand("p1", "30d");

      const { gte, lt, lte } = prisma.invoice.findMany.mock.calls[0][0].where.issueDate;
      expect(lte).toBeUndefined(); // half-open — no 23:59:59.999 fudge
      expect((lt.getTime() - gte.getTime()) / 86_400_000).toBe(30);
      const aheadMs = lt.getTime() - Date.now();
      expect(aheadMs).toBeGreaterThan(0);
      expect(aheadMs).toBeLessThanOrEqual(86_400_000);
    });

    it("ignores an invoice that falls outside the window", async () => {
      prisma.invoice.findMany.mockResolvedValue([
        { issueDate: daysAgo(400), items: [{ qty: D(99), subtotal: D(999) }] },
      ]);

      const res = await service.getProductDemand("p1", "30d");

      expect(res.totals).toEqual({ units: 0, revenue: 0 });
    });

    it("reports never-sold vs sold-but-zero-in-window", async () => {
      prisma.invoice.findMany.mockResolvedValue([]);
      prisma.invoice.findFirst.mockResolvedValue(null);

      const never = await service.getProductDemand("p1", "30d");
      expect(never.hasAnySales).toBe(false);
      expect(never.firstSaleAt).toBeNull();
      expect(never.lastSaleAt).toBeNull();

      const sold = daysAgo(200);
      prisma.invoice.findFirst.mockResolvedValue({ issueDate: sold });

      const stale = await service.getProductDemand("p1", "30d");
      expect(stale.hasAnySales).toBe(true);
      expect(stale.lastSaleAt).toBe(dayKey(sold));
      expect(stale.totals.units).toBe(0);
    });

    it("rounds money to cents and quantity to 3dp", async () => {
      prisma.invoice.findMany.mockResolvedValue([
        {
          issueDate: daysAgo(1),
          items: [
            { qty: D(0.333), subtotal: D(0.1) },
            { qty: D(0.333), subtotal: D(0.2) },
            { qty: D(0.333), subtotal: D(0.005) },
          ],
        },
      ]);

      const res = await service.getProductDemand("p1", "30d");

      expect(res.totals.revenue).toBe(0.31); // not 0.30000000000000004
      expect(res.totals.units).toBe(0.999); // 3dp, not roundMoney's 2dp
    });

    it("is unaffected by the tobacco exclusion toggle", async () => {
      // Per-product drill-downs opt out, same as price/cost history.
      addonService.hasAddon.mockResolvedValue(true);
      systemConfig.get.mockResolvedValue("true");
      prisma.invoice.findMany.mockResolvedValue([
        { issueDate: daysAgo(1), items: [{ qty: D(4), subtotal: D(40) }] },
      ]);

      const res = await service.getProductDemand("p1", "30d");

      expect(res.totals).toEqual({ units: 4, revenue: 40 });
      expect(systemConfig.get).not.toHaveBeenCalled();
    });
  });

  describe("route & driver performance", () => {
    // On-time = stop completedAt on or before the END of the run's scheduledDate
    // calendar day (UTC) — there is no ETA field on RouteRunStop to compare against.
    const run = (over: Record<string, unknown> = {}) => ({
      routeId: "r1",
      status: "COMPLETED",
      scheduledDate: new Date("2026-08-10T00:00:00.000Z"),
      startedAt: new Date("2026-08-10T08:00:00.000Z"),
      completedAt: new Date("2026-08-10T10:00:00.000Z"),
      route: { id: "r1", name: "North Loop" },
      orders: [],
      stops: [],
      ...over,
    });
    const stopAt = (iso: string | null) => ({ completedAt: iso ? new Date(iso) : null });

    it("aggregates on-time %, stops/hour, and average duration across a route's runs", async () => {
      prisma.routeRun.findMany.mockResolvedValue([
        // 2h run: 3 stops on the scheduled day, 1 the day after (late), 1 never completed.
        run({
          stops: [
            stopAt("2026-08-10T09:00:00.000Z"),
            stopAt("2026-08-10T09:20:00.000Z"),
            stopAt("2026-08-10T23:59:59.000Z"),
            stopAt("2026-08-11T00:30:00.000Z"),
            stopAt(null),
          ],
        }),
        // 1h run two days later: 2 on-time stops.
        run({
          scheduledDate: new Date("2026-08-12T00:00:00.000Z"),
          startedAt: new Date("2026-08-12T09:00:00.000Z"),
          completedAt: new Date("2026-08-12T10:00:00.000Z"),
          stops: [stopAt("2026-08-12T09:15:00.000Z"), stopAt("2026-08-12T09:45:00.000Z")],
        }),
      ]);

      const [row] = await service.getRoutePerformance();

      expect(row).toMatchObject({
        id: "r1",
        name: "North Loop",
        totalRuns: 2,
        completedRuns: 2,
        completionRate: 100,
      });
      expect(row.onTimeRate).toBeCloseTo((5 / 6) * 100, 5); // 6 completed, 1 late
      expect(row.stopsPerHour).toBe(2); // 6 completed stops over 3 valid hours
      expect(row.avgRunDurationMinutes).toBe(90); // (120m + 60m) / 2
    });

    it("excludes runs missing start/finish stamps from duration math without losing their stops or completion counts", async () => {
      prisma.routeRun.findMany.mockResolvedValue([
        run({
          stops: [
            stopAt("2026-08-10T09:00:00.000Z"),
            stopAt("2026-08-10T09:10:00.000Z"),
            stopAt("2026-08-10T09:20:00.000Z"),
            stopAt("2026-08-10T09:30:00.000Z"),
          ],
        }),
        // In-progress run: startedAt only. Its 2 completed stops still count for
        // on-time %, but must stay out of BOTH sides of stops/hour and duration.
        run({
          status: "IN_PROGRESS",
          completedAt: null,
          stops: [stopAt("2026-08-10T09:40:00.000Z"), stopAt("2026-08-10T09:50:00.000Z")],
        }),
      ]);

      const [row] = await service.getRoutePerformance();

      expect(row.totalRuns).toBe(2);
      expect(row.completedRuns).toBe(1);
      expect(row.completionRate).toBe(50);
      expect(row.onTimeRate).toBe(100); // all 6 completed stops on-time
      expect(row.stopsPerHour).toBe(2); // only the finished run: 4 stops / 2h
      expect(row.avgRunDurationMinutes).toBe(120); // only the finished run
    });

    it("returns null metrics (never NaN/Infinity/0) when a route has no timing data", async () => {
      prisma.routeRun.findMany.mockResolvedValue([
        run({ status: "SCHEDULED", startedAt: null, completedAt: null, stops: [stopAt(null)] }),
        // Zero-length span is junk data, not a 0-minute run — also excluded.
        run({
          status: "COMPLETED",
          startedAt: new Date("2026-08-10T08:00:00.000Z"),
          completedAt: new Date("2026-08-10T08:00:00.000Z"),
          stops: [],
        }),
      ]);

      const [row] = await service.getRoutePerformance();

      expect(row.onTimeRate).toBeNull();
      expect(row.stopsPerHour).toBeNull();
      expect(row.avgRunDurationMinutes).toBeNull();
      expect(row.completionRate).toBe(50);
    });

    it("windows runs on scheduledDate when from/to given, and applies no filter otherwise", async () => {
      prisma.routeRun.findMany.mockResolvedValue([]);

      await service.getRoutePerformance();
      expect(prisma.routeRun.findMany.mock.calls[0][0].where).toEqual({});

      await service.getRoutePerformance("2026-08-01", "2026-08-31");
      const windowed = prisma.routeRun.findMany.mock.calls[1][0].where;
      expect(windowed.scheduledDate.gte).toEqual(new Date("2026-08-01"));
      expect(windowed.scheduledDate.lte).toEqual(new Date("2026-08-31T23:59:59.999Z"));
    });

    it("computes the same stop metrics per driver alongside order-based delivery counts", async () => {
      const driver = { id: "d1", contactName: "Sam Field", user: { username: "sam" } };
      prisma.routeRun.findMany.mockResolvedValue([
        run({
          driver,
          orders: [{ id: "o1" }, { id: "o2" }],
          stops: [stopAt("2026-08-10T09:00:00.000Z"), stopAt("2026-08-11T01:00:00.000Z")],
        }),
        run({
          driver,
          status: "IN_PROGRESS",
          completedAt: null,
          orders: [{ id: "o3" }],
          stops: [stopAt("2026-08-10T09:30:00.000Z")],
        }),
      ]);

      const [row] = await service.getDriverPerformance("2026-08-01", "2026-08-31");

      expect(row).toMatchObject({
        id: "d1",
        name: "Sam Field",
        totalDeliveries: 3,
        completedDeliveries: 2,
      });
      expect(row.onTimeRate).toBeCloseTo((2 / 3) * 100, 5); // 3 completed stops, 1 late
      expect(row.stopsPerHour).toBe(1); // valid run only: 2 stops / 2h
      expect(row.avgRunDurationMinutes).toBe(120);
      // Unassigned runs stay out, and the date window rides along with that filter.
      const where = prisma.routeRun.findMany.mock.calls[0][0].where;
      expect(where.driverId).toEqual({ not: null });
      expect(where.scheduledDate.gte).toEqual(new Date("2026-08-01"));
    });
  });
});
