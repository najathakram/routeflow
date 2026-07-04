import { Test, TestingModule } from "@nestjs/testing";
import { Prisma } from "@prisma/client";
import { AnalyticsService } from "./analytics.service";
import { PrismaService } from "../prisma/prisma.service";
import { AddonService } from "../billing/addon.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { createMockPrisma } from "../testing/prisma-mock";

const D = (n: number | string) => new Prisma.Decimal(n);

describe("AnalyticsService — signed COGS", () => {
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
    it("computes COGS from signed SALE quantities × unitCost", async () => {
      prisma.invoice.findMany.mockResolvedValue([{ total: D(100) }]);
      prisma.stockMovement.findMany.mockResolvedValue([
        { quantity: D(-5), unitCost: D(2) }, // 5 sold @ 2.00 → +10
        { quantity: D(-3), unitCost: D(4) }, // 3 sold @ 4.00 → +12
      ]);

      const result = await service.getGrossMarginTrend();

      expect(result.revenue).toBe(100);
      expect(result.cogs).toBe(22);
      expect(result.grossProfit).toBe(78);
      expect(result.grossMarginPct).toBe(78);
    });

    it("nets a sale + reopen-reversal pair to zero COGS", async () => {
      prisma.invoice.findMany.mockResolvedValue([]);
      prisma.stockMovement.findMany.mockResolvedValue([
        { quantity: D(-5), unitCost: D(2) }, // original delivery
        { quantity: D(5), unitCost: D(2) }, // stop reopened — compensating SALE
      ]);

      const result = await service.getGrossMarginTrend();

      expect(result.cogs).toBe(0);
    });

    it("treats pre-fix SALE rows with null unitCost as zero cost", async () => {
      prisma.invoice.findMany.mockResolvedValue([{ total: D(50) }]);
      prisma.stockMovement.findMany.mockResolvedValue([{ quantity: D(-5), unitCost: null }]);

      const result = await service.getGrossMarginTrend();

      expect(result.cogs).toBe(0);
      expect(result.grossProfit).toBe(50);
    });
  });

  describe("getTopProducts (units metric)", () => {
    it("nets reopen-reversals out of units sold", async () => {
      prisma.stockMovement.findMany.mockResolvedValue([
        { productId: "p1", quantity: D(-10), product: { id: "p1", name: "Flour" } },
        { productId: "p1", quantity: D(4), product: { id: "p1", name: "Flour" } }, // reversal
        { productId: "p2", quantity: D(-3), product: { id: "p2", name: "Sugar" } },
      ]);

      const result = await service.getTopProducts("units", 10);

      expect(result).toEqual([
        { id: "p1", name: "Flour", value: 6 },
        { id: "p2", name: "Sugar", value: 3 },
      ]);
    });
  });

  describe("tobacco exclusion toggle", () => {
    const tobaccoInvoice = {
      total: D(110),
      items: [
        { subtotal: D(60), taxRate: D(0), product: { isTobacco: true } },
        { subtotal: D(50), taxRate: D(0), product: { isTobacco: false } },
      ],
    };

    it("subtracts tobacco line revenue when addon + toggle are active", async () => {
      addonService.hasAddon.mockResolvedValue(true);
      systemConfig.get.mockResolvedValue("true");
      prisma.invoice.findMany.mockResolvedValue([tobaccoInvoice]);
      prisma.stockMovement.findMany.mockResolvedValue([]);

      const result = await service.getGrossMarginTrend();

      expect(result.revenue).toBe(50);
      // COGS query filters tobacco products out
      expect(prisma.stockMovement.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ product: { isTobacco: false } }),
        }),
      );
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
});
