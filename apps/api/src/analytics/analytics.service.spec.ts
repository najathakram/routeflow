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
});
