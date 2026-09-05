import { Test } from "@nestjs/testing";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { RegulatedFilingService } from "./regulated-filing.service";
import { RegulatedService } from "./regulated.service";
import { RegulatedReportService } from "./regulated-report.service";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { AuditService } from "../audit/audit.service";
import { roundMoney } from "@routeflow/pricing";
import { createMockPrisma } from "../testing/prisma-mock";

describe("RegulatedFilingService", () => {
  let service: RegulatedFilingService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let regulated: { getLedger: jest.Mock };
  let storage: { upload: jest.Mock; presignedUrl: jest.Mock };
  let audit: { log: jest.Mock };

  // A period 2 years back is always complete regardless of the wall clock.
  const now = new Date();
  const pastYear = now.getUTCFullYear() - 2;
  const futureYear = now.getUTCFullYear() + 1;
  const bucket = `${pastYear}-01`; // MONTHLY index 1

  const category = {
    id: "cat-1",
    name: "Tobacco",
    reportTemplate: "GENERIC",
    reportCadence: "MONTHLY",
    unitBasis: "pack",
  };

  const ledgerRow = (over: Partial<Record<string, unknown>> = {}) => ({
    trackedCategoryId: "cat-1",
    categoryName: "Tobacco",
    periodBucket: bucket,
    qty: 10,
    unitBasisQty: 20,
    netSales: 100,
    categoryTax: 5,
    ...over,
  });

  beforeEach(async () => {
    prisma = createMockPrisma();
    regulated = { getLedger: jest.fn().mockResolvedValue({ rows: [], totals: {} }) };
    storage = {
      upload: jest.fn().mockResolvedValue("key"),
      presignedUrl: jest.fn().mockResolvedValue("https://signed"),
    };
    audit = { log: jest.fn().mockResolvedValue(undefined) };

    const mod = await Test.createTestingModule({
      providers: [
        RegulatedFilingService,
        // Real instance (not mocked) — the TX_COMPTROLLER branch below exercises its
        // manual three-step join against the same mocked `prisma`.
        RegulatedReportService,
        { provide: PrismaService, useValue: prisma },
        { provide: RegulatedService, useValue: regulated },
        { provide: StorageService, useValue: storage },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();
    service = mod.get(RegulatedFilingService);

    prisma.trackedCategory.findUnique.mockResolvedValue(category);
    prisma.regulatedFiling.findFirst.mockResolvedValue(null);
    prisma.regulatedFiling.create.mockImplementation((args: any) =>
      Promise.resolve({ id: "filing-1", ...args.data }),
    );
    prisma.regulatedFiling.update.mockImplementation((args: any) =>
      Promise.resolve({ id: args.where.id, ...args.data }),
    );
  });

  describe("prepareFiling — money/period invariants", () => {
    it("sums getLedger rows into signed net totals (incl. unitBasisQty)", async () => {
      regulated.getLedger.mockResolvedValue({ rows: [ledgerRow()], totals: {} });
      const filing = await service.prepareFiling({
        trackedCategoryId: "cat-1",
        year: pastYear,
        index: 1,
        userId: "u1",
      });
      expect(filing.totalQty).toBe(10);
      expect(filing.totalUnitBasisQty).toBe(20);
      expect(filing.totalNetSales).toBe(100);
      expect(filing.totalCategoryTax).toBe(5);
      expect(storage.upload).toHaveBeenCalledTimes(1);
      // csv key is deterministic + tenant-scoped
      expect(storage.upload.mock.calls[0][0]).toBe(
        `regulated-filings/test-tenant/cat-1/${pastYear}-01.csv`,
      );
    });

    it("does NOT clamp a reversal-heavy period that nets negative", async () => {
      regulated.getLedger.mockResolvedValue({
        rows: [ledgerRow({ qty: -2, unitBasisQty: -4, netSales: -30, categoryTax: -2 })],
        totals: {},
      });
      const filing = await service.prepareFiling({
        trackedCategoryId: "cat-1",
        year: pastYear,
        index: 1,
      });
      expect(filing.totalNetSales).toBe(-30);
      expect(filing.totalCategoryTax).toBe(-2);
    });

    it("filters getLedger rows to the exact in-period bucket set (soldAt-window bleed)", async () => {
      regulated.getLedger.mockResolvedValue({
        rows: [
          ledgerRow({ netSales: 100 }),
          ledgerRow({ periodBucket: `${pastYear}-05`, qty: 999, netSales: 9999, categoryTax: 99 }),
        ],
        totals: {},
      });
      const filing = await service.prepareFiling({
        trackedCategoryId: "cat-1",
        year: pastYear,
        index: 1,
      });
      expect(filing.totalNetSales).toBe(100); // stray out-of-period bucket excluded
      expect((filing.rows as any[]).length).toBe(1);
    });

    it("rounds money to cents (no raw float leak)", async () => {
      regulated.getLedger.mockResolvedValue({
        rows: [ledgerRow({ netSales: 10.005, categoryTax: 0.005 })],
        totals: {},
      });
      const filing = await service.prepareFiling({
        trackedCategoryId: "cat-1",
        year: pastYear,
        index: 1,
      });
      expect(filing.totalNetSales).toBe(roundMoney(10.005));
      expect(filing.totalCategoryTax).toBe(roundMoney(0.005));
    });

    it("rounds qty/unitBasisQty to 3dp so JSON rows == DB == CSV", async () => {
      regulated.getLedger.mockResolvedValue({
        rows: [ledgerRow({ qty: 0.1 + 0.2, unitBasisQty: 0.1 + 0.2 })], // 0.30000000000000004
        totals: {},
      });
      const filing = await service.prepareFiling({
        trackedCategoryId: "cat-1",
        year: pastYear,
        index: 1,
      });
      expect(filing.totalQty).toBe(0.3);
      expect(filing.totalUnitBasisQty).toBe(0.3);
      expect((filing.rows as any[])[0].qty).toBe(0.3);
    });

    it("queries the ledger with an exact exclusive-end [from, to) window", async () => {
      await service.prepareFiling({ trackedCategoryId: "cat-1", year: pastYear, index: 1 });
      const [query, opts] = regulated.getLedger.mock.calls[0];
      expect(opts).toEqual({ exclusiveTo: true });
      // MONTHLY index 1 → [Jan 1, Feb 1), no `to − 1ms` fudge
      expect(query.from).toBe(new Date(Date.UTC(pastYear, 0, 1)).toISOString());
      expect(query.to).toBe(new Date(Date.UTC(pastYear, 1, 1)).toISOString());
    });
  });

  describe("prepareFiling — guards + upsert", () => {
    it("rejects a not-yet-complete period", async () => {
      await expect(
        service.prepareFiling({ trackedCategoryId: "cat-1", year: futureYear, index: 1 }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(storage.upload).not.toHaveBeenCalled();
    });

    it("rejects a null-tenant context", async () => {
      prisma.getTenantId.mockReturnValue(null);
      await expect(
        service.prepareFiling({ trackedCategoryId: "cat-1", year: pastYear, index: 1 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("404s an unknown category", async () => {
      prisma.trackedCategory.findUnique.mockResolvedValue(null);
      await expect(
        service.prepareFiling({ trackedCategoryId: "nope", year: pastYear, index: 1 }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("rejects an out-of-range quarter", async () => {
      await expect(
        service.prepareFiling({
          trackedCategoryId: "cat-1",
          cadence: "QUARTERLY",
          year: pastYear,
          index: 5,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("regeneration bumps generationCount + overwrites at the same key (update, not create)", async () => {
      prisma.regulatedFiling.findFirst.mockResolvedValue({ id: "existing-1", generationCount: 1 });
      regulated.getLedger.mockResolvedValue({ rows: [ledgerRow()], totals: {} });
      const filing = await service.prepareFiling({
        trackedCategoryId: "cat-1",
        year: pastYear,
        index: 1,
      });
      expect(prisma.regulatedFiling.update).toHaveBeenCalled();
      expect(prisma.regulatedFiling.create).not.toHaveBeenCalled();
      expect(filing.generationCount).toBe(2);
    });

    it("retries as an update when a concurrent create hits the unique constraint", async () => {
      regulated.getLedger.mockResolvedValue({ rows: [ledgerRow()], totals: {} });
      prisma.regulatedFiling.findFirst
        .mockResolvedValueOnce(null) // initial: no existing → create path
        .mockResolvedValueOnce({ id: "raced-1", generationCount: 1 }); // post-P2002 lookup
      prisma.regulatedFiling.create.mockRejectedValueOnce({ code: "P2002" });
      const filing = await service.prepareFiling({
        trackedCategoryId: "cat-1",
        year: pastYear,
        index: 1,
      });
      expect(prisma.regulatedFiling.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "raced-1" } }),
      );
      expect(filing.generationCount).toBe(2); // raced.generationCount + 1
    });

    it("defaults cadence from the category when omitted", async () => {
      regulated.getLedger.mockResolvedValue({ rows: [ledgerRow()], totals: {} });
      const filing = await service.prepareFiling({
        trackedCategoryId: "cat-1",
        year: pastYear,
        index: 1,
      });
      expect(filing.cadence).toBe("MONTHLY");
      expect(filing.periodKey).toBe(`${pastYear}-01`);
    });

    it("audit-logs the prepare with the manual trigger", async () => {
      await service.prepareFiling({
        trackedCategoryId: "cat-1",
        year: pastYear,
        index: 1,
        userId: "u1",
      });
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "regulated_filing.prepared",
          entityType: "RegulatedFiling",
          meta: expect.objectContaining({ trigger: "manual", periodKey: `${pastYear}-01` }),
        }),
      );
    });
  });

  describe("prepareFiling — TX_COMPTROLLER template (WP11)", () => {
    const txCategory = {
      id: "cat-tx",
      name: "Cigarettes",
      reportTemplate: "TX_COMPTROLLER",
      reportCadence: "MONTHLY",
      unitBasis: null,
      wholesalerLicenseNo: "12345678",
    };

    it("stores a TX-serialized CSV (no header) and rows Json carrying txRows + warnings, while the Decimal totals stay the ledger aggregate", async () => {
      prisma.trackedCategory.findUnique.mockResolvedValue(txCategory);
      // The four Decimal totals still come from the (category, period) ledger
      // aggregate — unaffected by the TX branch below.
      regulated.getLedger.mockResolvedValue({
        rows: [ledgerRow({ trackedCategoryId: "cat-tx", categoryName: "Cigarettes" })],
        totals: {},
      });
      // The TX per-invoice breakdown is a SEPARATE raw ledger query (RegulatedSalesLedger
      // has no Prisma relations, so it's a manual three-step join) — now also joining
      // through the invoice line to the product for its regulatory reporting config.
      prisma.regulatedSalesLedger.findMany.mockResolvedValue([
        { invoiceId: "inv-1", invoiceItemId: "line-1", unitBasisQty: 20, netSales: 100 },
      ]);
      prisma.invoiceItem.findMany.mockResolvedValue([
        {
          id: "line-1",
          productId: "prod-1",
          qty: 20,
          boxes: null,
          pieces: null,
          unitsPerBox: null,
        },
      ]);
      prisma.product.findMany.mockResolvedValue([
        {
          id: "prod-1",
          name: "Acme Full Flavor",
          unitsPerBox: null,
          regItemType: "1",
          regUomCase: null,
          regUomUnit: "CP",
        },
      ]);
      prisma.invoice.findMany.mockResolvedValue([
        {
          id: "inv-1",
          invoiceNumber: "INV-1",
          issueDate: new Date(`${pastYear}-01-05`),
          customerId: "cust-1",
        },
      ]);
      prisma.customer.findMany.mockResolvedValue([
        {
          id: "cust-1",
          businessName: "Acme Retail",
          taxId: "12345678901",
          tobaccoLicenseNo: null,
          addresses: [
            {
              line1: "1 Main St",
              line2: null,
              city: "Austin",
              state: "TX",
              zip: "78701",
              isDefault: true,
              addressType: "BILLING",
            },
          ],
          authorizations: [{ licenseNumber: "87654321" }],
        },
      ]);

      const filing = await service.prepareFiling({
        trackedCategoryId: "cat-tx",
        year: pastYear,
        index: 1,
      });

      expect(filing.totalNetSales).toBe(100);
      expect(filing.totalUnitBasisQty).toBe(20);

      expect(storage.upload).toHaveBeenCalledTimes(1);
      const csvBuffer: Buffer = storage.upload.mock.calls[0][1];
      const csv = csvBuffer.toString("utf8");
      expect(csv).not.toContain("Wholesaler Permit #"); // no header row
      expect(csv).not.toContain("TOTALS");
      expect(csv).toContain("Acme Retail");

      const rowsJson = filing.rows as any;
      expect(Array.isArray(rowsJson.txRows)).toBe(true);
      expect(rowsJson.txRows.length).toBe(1);
      expect(Array.isArray(rowsJson.warnings)).toBe(true);

      // Persisted filings never pass includeOptionalColumns, so the filed CSV keeps
      // the official 12-column layout — the custom-format pipeline never touches it.
      expect(csv).not.toContain("-custom");
    });
  });

  describe("listFilings + downloadUrl", () => {
    it("lists tenant-scoped filings filtered by category", async () => {
      prisma.regulatedFiling.findMany.mockResolvedValue([{ id: "f1" }]);
      const res = await service.listFilings("cat-1");
      expect(prisma.forTenant).toHaveBeenCalled();
      expect(prisma.regulatedFiling.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { trackedCategoryId: "cat-1" } }),
      );
      expect(res).toEqual([{ id: "f1" }]);
    });

    it("returns a presigned CSV url", async () => {
      prisma.regulatedFiling.findUnique.mockResolvedValue({ id: "f1", csvKey: "k" });
      expect(await service.downloadUrl("f1", "csv")).toEqual({ url: "https://signed" });
    });

    it("404s when the requested artifact key is null", async () => {
      prisma.regulatedFiling.findUnique.mockResolvedValue({ id: "f1", csvKey: null });
      await expect(service.downloadUrl("f1", "csv")).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
