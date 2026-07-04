import { Test, TestingModule } from "@nestjs/testing";
import { Prisma } from "@prisma/client";
import { TobaccoService } from "./tobacco.service";
import { PrismaService } from "../prisma/prisma.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { AuditService } from "../audit/audit.service";
import { createMockPrisma } from "../testing/prisma-mock";

const D = (n: number | string) => new Prisma.Decimal(n);

describe("TobaccoService", () => {
  let service: TobaccoService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let systemConfig: { get: jest.Mock; set: jest.Mock };
  let audit: { log: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrisma();
    systemConfig = { get: jest.fn().mockResolvedValue(null), set: jest.fn() };
    audit = { log: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TobaccoService,
        { provide: PrismaService, useValue: prisma },
        { provide: SystemConfigService, useValue: systemConfig },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();

    service = module.get<TobaccoService>(TobaccoService);
  });

  describe("getSales", () => {
    it("filters to tobacco products on real invoices and computes line tax", async () => {
      prisma.invoiceItem.findMany.mockResolvedValue([
        {
          id: "ii-1",
          qty: D(10),
          unitPrice: D(8),
          subtotal: D(80),
          taxRate: D(0.08),
          product: { id: "p1", name: "Cigarillos", sku: null, unit: "pack" },
          invoice: {
            id: "inv-1",
            invoiceNumber: "INV-1",
            issueDate: new Date("2026-06-10"),
            customer: {
              id: "c1",
              businessName: "Corner Store",
              tobaccoLicenseNo: "TL-123",
              tobaccoLicenseExpiry: null,
            },
          },
        },
      ]);

      const result = await service.getSales({ from: "2026-06-01", to: "2026-06-30" });

      const where = prisma.invoiceItem.findMany.mock.calls[0][0].where;
      expect(where.product).toEqual({ isTobacco: true });
      expect(where.invoice.status).toEqual({ notIn: ["DRAFT", "VOID", "WRITTEN_OFF"] });

      expect(result[0].tax).toBe(6.4); // 80 × 0.08
      expect(result[0].customer.tobaccoLicenseNo).toBe("TL-123");
    });
  });

  describe("getPurchases", () => {
    it("returns PURCHASE movements of flagged products with supplier license", async () => {
      prisma.stockMovement.findMany.mockResolvedValue([
        {
          id: "m1",
          createdAt: new Date("2026-06-05"),
          quantity: D(20),
          unitCost: D(5.5),
          reference: "BILL-1",
          product: { id: "p1", name: "Cigarillos", sku: null, unit: "pack" },
          supplier: { id: "s1", name: "TobacCo", tobaccoLicenseNo: "WH-99" },
        },
      ]);

      const result = await service.getPurchases({});

      const where = prisma.stockMovement.findMany.mock.calls[0][0].where;
      expect(where.type).toBe("PURCHASE");
      expect(where.product).toEqual({ isTobacco: true });
      expect(result[0].value).toBe(110); // 20 × 5.50
      expect(result[0].supplier.tobaccoLicenseNo).toBe("WH-99");
    });
  });

  describe("getInventory", () => {
    it("values stock at average cost and keeps null-cost products visible", async () => {
      prisma.product.findMany.mockResolvedValue([
        {
          id: "p1",
          name: "Cigarillos",
          sku: null,
          unit: "pack",
          isActive: true,
          currentStock: D(40),
          averageCost: D(5.5),
        },
        {
          id: "p2",
          name: "Chew",
          sku: null,
          unit: "tin",
          isActive: true,
          currentStock: D(10),
          averageCost: null,
        },
      ]);

      const result = await service.getInventory();

      expect(result[0].totalValue).toBe(220);
      expect(result[1].totalValue).toBeNull();
    });
  });

  describe("settings", () => {
    it("writes the exclusion toggle and audit-logs the change", async () => {
      systemConfig.get.mockResolvedValue("true");

      const result = await service.updateSettings({ excludeFromMainAnalytics: true }, "user-1");

      expect(systemConfig.set).toHaveBeenCalledWith("tobacco.excludeFromMainAnalytics", "true");
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: "tobacco_settings.updated", userId: "user-1" }),
      );
      expect(result.excludeFromMainAnalytics).toBe(true);
    });
  });
});
