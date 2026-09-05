// `@LeaderCron` wraps every cron tick in a Postgres advisory lock (common/cron-lock.ts).
// These specs invoke the tick directly and have no database, so the lock is a PASS-THROUGH here:
// it must still call the body — a mock that skipped it would make every assertion below measure
// a tick that never ran.
jest.mock("../common/db-locks", () => ({
  withAdvisoryLock: async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  }),
  LockTimeoutError: class extends Error {},
  LockUnavailableError: class extends Error {},
}));

import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { TobaccoReportService } from "./tobacco-report.service";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { AuditService } from "../audit/audit.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { createMockPrisma } from "../testing/prisma-mock";

const D = (n: number | string) => new Prisma.Decimal(n);

describe("TobaccoReportService", () => {
  let service: TobaccoReportService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let storage: { upload: jest.Mock; presignedUrl: jest.Mock };
  let audit: { log: jest.Mock };

  const seedPeriodData = () => {
    // One tobacco product: bought 20 @ 5.50, sold 10 @ 8.00 (8% tax) in period,
    // then 5 more sold AFTER the period; currentStock now 5 → ending stock 10.
    prisma.product.findMany.mockResolvedValue([
      {
        id: "p1",
        name: "Cigarillos",
        sku: "CIG-1",
        unit: "pack",
        currentStock: D(5),
        averageCost: D(5.5),
      },
    ]);
    prisma.stockMovement.findMany
      // purchases in period
      .mockResolvedValueOnce([{ productId: "p1", quantity: D(20), unitCost: D(5.5) }])
      // movements after period end (a 5-unit sale → negative)
      .mockResolvedValueOnce([{ productId: "p1", quantity: D(-5) }]);
    prisma.invoiceItem.findMany.mockResolvedValue([
      { productId: "p1", qty: D(10), subtotal: D(80), taxRate: D(0.08) },
    ]);
    prisma.tenantConfig.findUnique.mockResolvedValue({ businessName: "Acme Wholesale" });
  };

  beforeEach(async () => {
    prisma = createMockPrisma();
    storage = {
      upload: jest.fn().mockResolvedValue(undefined),
      presignedUrl: jest.fn().mockResolvedValue("https://signed.example/x"),
    };
    audit = { log: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TobaccoReportService,
        { provide: PrismaService, useValue: prisma },
        { provide: StorageService, useValue: storage },
        { provide: AuditService, useValue: audit },
        { provide: TenantContextService, useValue: { run: jest.fn((_id, fn) => fn()) } },
      ],
    }).compile();

    service = module.get<TobaccoReportService>(TobaccoReportService);
  });

  describe("generateForPeriod", () => {
    it("rejects the current / future months", async () => {
      const now = new Date();
      await expect(
        service.generateForPeriod(now.getUTCFullYear(), now.getUTCMonth() + 1),
      ).rejects.toThrow(BadRequestException);
    });

    it("builds rows with purchases, sales, tax and back-calculated ending stock", async () => {
      seedPeriodData();
      prisma.tobaccoReport.findFirst.mockResolvedValue(null);
      prisma.tobaccoReport.create.mockResolvedValue({ id: "rep-1" });

      await service.generateForPeriod(2026, 6, { userId: "user-1" });

      const created = prisma.tobaccoReport.create.mock.calls[0][0].data;
      expect(created.periodYear).toBe(2026);
      expect(created.periodMonth).toBe(6);
      expect(created.generationCount).toBe(1);
      expect(created.totalQtyPurchased).toBe(20);
      expect(created.totalPurchaseValue).toBe(110); // 20 × 5.50
      expect(created.totalQtySold).toBe(10);
      expect(created.totalSalesValue).toBe(80);
      expect(created.totalTaxCollected).toBe(6.4); // 80 × 0.08
      // ending stock at period end = currentStock(5) − after(-5) = 10
      expect(created.endingStockQty).toBe(10);
      expect(created.endingStockValue).toBe(55); // 10 × 5.50 current avg

      const row = (created.rows as any[])[0];
      expect(row).toMatchObject({
        productId: "p1",
        qtyPurchased: "20",
        purchaseValue: "110.00",
        qtySold: "10",
        salesValue: "80.00",
        taxCollected: "6.40",
        endingStockQty: "10",
        endingStockValue: "55.00",
      });

      // CSV + PDF stored at deterministic keys
      expect(storage.upload).toHaveBeenCalledWith(
        "tobacco-reports/test-tenant/2026-06.csv",
        expect.any(Buffer),
        "text/csv",
      );
      expect(storage.upload).toHaveBeenCalledWith(
        "tobacco-reports/test-tenant/2026-06.pdf",
        expect.any(Buffer),
        "application/pdf",
      );
      const csv = storage.upload.mock.calls[0][1].toString("utf8");
      expect(csv).toContain("Cigarillos,CIG-1,pack,20,110.00,10,80.00,6.40,10,55.00");
      expect(csv).toContain("TOTALS");

      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "tobacco_report.generated",
          meta: expect.objectContaining({ regenerated: false, trigger: "manual" }),
        }),
      );
    });

    it("regenerates into the SAME period row and bumps generationCount", async () => {
      seedPeriodData();
      prisma.tobaccoReport.findFirst.mockResolvedValue({ id: "rep-1", generationCount: 1 });
      prisma.tobaccoReport.update.mockResolvedValue({ id: "rep-1" });

      await service.generateForPeriod(2026, 6, { userId: "user-1" });

      expect(prisma.tobaccoReport.create).not.toHaveBeenCalled();
      const updated = prisma.tobaccoReport.update.mock.calls[0][0];
      expect(updated.where).toEqual({ id: "rep-1" });
      expect(updated.data.generationCount).toBe(2);
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ meta: expect.objectContaining({ regenerated: true }) }),
      );
    });
  });

  describe("generateMonthlyReports (cron)", () => {
    it("only processes ACTIVE tenants with the tobacco_dealer addon", async () => {
      prisma.tenant.findMany.mockResolvedValue([{ id: "t1" }, { id: "t2" }]);
      prisma.tenantAddon.findMany.mockResolvedValue([{ tenantId: "t2" }]);
      // t2: period already generated → skip without generating
      prisma.tobaccoReport.findFirst.mockResolvedValue({ id: "existing", status: "GENERATED" });
      const spy = jest.spyOn(service, "generateForPeriod");

      await service.generateMonthlyReports();

      expect(prisma.tenantAddon.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { addonKey: "tobacco_dealer", active: true } }),
      );
      expect(spy).not.toHaveBeenCalled(); // idempotent skip
    });

    it("isolates per-tenant failures and records a FAILED row", async () => {
      prisma.tenant.findMany.mockResolvedValue([{ id: "t1" }]);
      prisma.tenantAddon.findMany.mockResolvedValue([{ tenantId: "t1" }]);
      prisma.tobaccoReport.findFirst.mockResolvedValue(null);
      jest.spyOn(service, "generateForPeriod").mockRejectedValue(new Error("boom"));

      await expect(service.generateMonthlyReports()).resolves.toBeUndefined();

      expect(prisma.tobaccoReport.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "FAILED", errorMessage: "boom" }),
        }),
      );
    });
  });

  describe("downloadUrl", () => {
    it("returns a presigned URL for the stored artifact", async () => {
      prisma.tobaccoReport.findUnique.mockResolvedValue({ id: "rep-1", csvKey: "k.csv" });

      const result = await service.downloadUrl("rep-1", "csv");

      expect(storage.presignedUrl).toHaveBeenCalledWith("k.csv");
      expect(result).toEqual({ url: "https://signed.example/x" });
    });
  });
});
