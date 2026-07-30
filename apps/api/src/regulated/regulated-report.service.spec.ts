import { Test } from "@nestjs/testing";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { RegulatedReportService } from "./regulated-report.service";
import { RegulatedService } from "./regulated.service";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";

describe("RegulatedReportService", () => {
  let service: RegulatedReportService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let regulated: { getLedger: jest.Mock };

  const category = {
    id: "cat-1",
    name: "Tobacco",
    reportTemplate: "GENERIC",
    unitBasis: "pack",
    wholesalerLicenseNo: null,
    txItemType: null,
    txUom: null,
  };

  beforeEach(async () => {
    prisma = createMockPrisma();
    regulated = { getLedger: jest.fn().mockResolvedValue({ rows: [], totals: {} }) };

    const mod = await Test.createTestingModule({
      providers: [
        RegulatedReportService,
        { provide: PrismaService, useValue: prisma },
        { provide: RegulatedService, useValue: regulated },
      ],
    }).compile();
    service = mod.get(RegulatedReportService);

    prisma.trackedCategory.findUnique.mockResolvedValue(category);
  });

  describe("date/range validation", () => {
    it("400s when from is after to", async () => {
      await expect(
        service.buildReport({ category: "cat-1", from: "2026-07-10", to: "2026-07-01" }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("400s on a non-date string", async () => {
      await expect(
        service.buildReport({ category: "cat-1", from: "not-a-date", to: "2026-07-01" }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("400s on a span over 366 days", async () => {
      await expect(
        service.buildReport({ category: "cat-1", from: "2026-01-01", to: "2027-01-02" }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("accepts a full leap-year span of exactly 366 inclusive days", async () => {
      await expect(
        service.buildReport({ category: "cat-1", from: "2024-01-01", to: "2024-12-31" }),
      ).resolves.toBeDefined();
    });

    it("404s an unknown category", async () => {
      prisma.trackedCategory.findUnique.mockResolvedValue(null);
      await expect(
        service.buildReport({ category: "nope", from: "2026-07-01", to: "2026-07-31" }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("template resolution", () => {
    it("falls back to the category's reportTemplate when none is given", async () => {
      prisma.trackedCategory.findUnique.mockResolvedValue({
        ...category,
        reportTemplate: "CA_CDTFA",
      });
      const report = await service.buildReport({
        category: "cat-1",
        from: "2026-07-01",
        to: "2026-07-31",
      });
      expect(report.template).toBe("CA_CDTFA");
      expect(report.title).toBe("CDTFA Excise Filing");
    });

    it("an explicit unknown template string still resolves via the GENERIC aggregate path", async () => {
      const report = await service.buildReport({
        category: "cat-1",
        from: "2026-07-01",
        to: "2026-07-31",
        template: "SOME_TYPO",
      });
      expect(report.title).toBe("Regulated Filing"); // GENERIC fallback title
    });
  });

  describe("non-TX ledger query", () => {
    it("queries getLedger with the half-open [from, to+1day) window (final day included)", async () => {
      await service.buildReport({ category: "cat-1", from: "2026-07-01", to: "2026-07-31" });
      const [query, opts] = regulated.getLedger.mock.calls[0];
      expect(opts).toEqual({ exclusiveTo: true });
      expect(query.from).toBe(new Date("2026-07-01T00:00:00.000Z").toISOString());
      expect(query.to).toBe(new Date("2026-08-01T00:00:00.000Z").toISOString());
    });
  });

  describe("TX_COMPTROLLER template", () => {
    const txCategory = {
      id: "cat-tx",
      name: "Cigarettes",
      reportTemplate: "TX_COMPTROLLER",
      unitBasis: null,
      wholesalerLicenseNo: "12345678",
      txItemType: 1,
      txUom: "CP",
    };

    it("does the manual three-step join, querying regulatedSalesLedger with gte/lt (half-open)", async () => {
      prisma.trackedCategory.findUnique.mockResolvedValue(txCategory);
      prisma.regulatedSalesLedger.findMany.mockResolvedValue([
        { invoiceId: "inv-1", unitBasisQty: 10, netSales: 100 },
      ]);
      prisma.invoice.findMany.mockResolvedValue([
        {
          id: "inv-1",
          invoiceNumber: "INV-1",
          issueDate: new Date("2026-07-05"),
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

      const report = await service.buildReport({
        category: "cat-tx",
        from: "2026-07-01",
        to: "2026-07-31",
      });

      expect(report.template).toBe("TX_COMPTROLLER");
      expect(report.rows.length).toBe(1);
      expect(report.rows[0][2]).toBe("Acme Retail");
      const [callArg] = prisma.regulatedSalesLedger.findMany.mock.calls[0];
      expect(callArg.where.soldAt.gte).toEqual(new Date("2026-07-01T00:00:00.000Z"));
      // Half-open: the final day (07-31) is included via a `< 08-01` bound.
      expect(callArg.where.soldAt.lt).toEqual(new Date("2026-08-01T00:00:00.000Z"));
      expect(prisma.invoice.findMany).toHaveBeenCalled();
      expect(prisma.customer.findMany).toHaveBeenCalled();
    });

    it("resolves the customer's address via pickReportAddress precedence (default+BILLING over other rows)", async () => {
      prisma.trackedCategory.findUnique.mockResolvedValue(txCategory);
      prisma.regulatedSalesLedger.findMany.mockResolvedValue([
        { invoiceId: "inv-1", unitBasisQty: 10, netSales: 100 },
      ]);
      prisma.invoice.findMany.mockResolvedValue([
        {
          id: "inv-1",
          invoiceNumber: "INV-1",
          issueDate: new Date("2026-07-05"),
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
              line1: "Shipping Ave",
              line2: null,
              city: "Houston",
              state: "TX",
              zip: "77001",
              isDefault: false,
              addressType: "SHIPPING",
            },
            {
              line1: "Billing Blvd",
              line2: null,
              city: "Austin",
              state: "TX",
              zip: "78701",
              isDefault: true,
              addressType: "BILLING",
            },
          ],
          authorizations: [],
        },
      ]);

      const report = await service.buildReport({
        category: "cat-tx",
        from: "2026-07-01",
        to: "2026-07-31",
      });
      expect(report.rows[0][3]).toBe("Billing Blvd"); // street
      expect(report.rows[0][4]).toBe("Austin"); // city
    });
  });

  describe("buildReportCsv", () => {
    it("returns a slugified filename carrying category, template, and range", async () => {
      const { filename, csv } = await service.buildReportCsv({
        category: "cat-1",
        from: "2026-07-01",
        to: "2026-07-31",
      });
      expect(filename).toBe("tobacco-GENERIC-2026-07-01-2026-07-31.csv");
      expect(typeof csv).toBe("string");
    });

    it("sanitizes a caller-supplied template — the filename goes into a header", async () => {
      // An unknown template falls back to GENERIC columns but is echoed back verbatim,
      // and the filename is interpolated into a quoted Content-Disposition value.
      const { filename } = await service.buildReportCsv({
        category: "cat-1",
        from: "2026-07-01",
        to: "2026-07-31",
        template: "x\";filename*=UTF-8''evil.html;a=\"",
      });
      expect(filename).toBe("tobacco-x-filename-UTF-8-evil-html-a-2026-07-01-2026-07-31.csv");
      expect(filename).not.toMatch(/["\r\n;]/);
    });
  });
});
