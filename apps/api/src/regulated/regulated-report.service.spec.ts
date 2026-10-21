import { Test } from "@nestjs/testing";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { RegulatedReportService } from "./regulated-report.service";
import { RegulatedService } from "./regulated.service";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { defaultColumnKeys } from "./template-registry";
import * as uncategorised from "./uncategorised-lines";

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
        {
          provide: SellingRestrictionsService,
          useValue: {
            getPolicy: jest
              .fn()
              .mockResolvedValue({ enabled: false, addressPrecedence: "BILLING_FIRST" }),
          },
        },
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
    };

    const line = (over: Partial<Record<string, unknown>> = {}) => ({
      id: "line-1",
      productId: "prod-1",
      qty: 10,
      boxes: null,
      pieces: null,
      unitsPerBox: 10,
      ...over,
    });

    const product = (over: Partial<Record<string, unknown>> = {}) => ({
      id: "prod-1",
      name: "Acme Full Flavor",
      unitsPerBox: 10,
      regItemType: "1",
      regUomCase: null,
      regUomUnit: "CP",
      ...over,
    });

    const invoice = (over: Partial<Record<string, unknown>> = {}) => ({
      id: "inv-1",
      invoiceNumber: "INV-1",
      issueDate: new Date("2026-07-05"),
      customerId: "cust-1",
      ...over,
    });

    const customer = (over: Partial<Record<string, unknown>> = {}) => ({
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
      ...over,
    });

    beforeEach(() => {
      prisma.trackedCategory.findUnique.mockResolvedValue(txCategory);
      prisma.regulatedSalesLedger.findMany.mockResolvedValue([
        { invoiceId: "inv-1", invoiceItemId: "line-1", unitBasisQty: 10, netSales: 100 },
      ]);
      prisma.invoiceItem.findMany.mockResolvedValue([line()]);
      prisma.product.findMany.mockResolvedValue([product()]);
      prisma.invoice.findMany.mockResolvedValue([invoice()]);
      prisma.customer.findMany.mockResolvedValue([customer()]);
    });

    it("does the manual join across ledger → invoice line → product → invoice → customer, querying regulatedSalesLedger with gte/lt (half-open) and selecting invoiceItemId", async () => {
      const report = await service.buildReport({
        category: "cat-tx",
        from: "2026-07-01",
        to: "2026-07-31",
      });

      expect(report.template).toBe("TX_COMPTROLLER");
      expect(report.rows.length).toBe(1);
      expect(report.rows[0][2]).toBe("Acme Retail");
      const [callArg] = prisma.regulatedSalesLedger.findMany.mock.calls[0];
      expect(callArg.select.invoiceItemId).toBe(true);
      expect(callArg.where.soldAt.gte).toEqual(new Date("2026-07-01T00:00:00.000Z"));
      // Half-open: the final day (07-31) is included via a `< 08-01` bound.
      expect(callArg.where.soldAt.lt).toEqual(new Date("2026-08-01T00:00:00.000Z"));
      expect(prisma.invoiceItem.findMany).toHaveBeenCalled();
      expect(prisma.product.findMany).toHaveBeenCalled();
      expect(prisma.invoice.findMany).toHaveBeenCalled();
      expect(prisma.customer.findMany).toHaveBeenCalled();
    });

    it("SA-789 F1: a ledger row whose invoice line was re-created still prints its product detail (resolved via the order line)", async () => {
      prisma.regulatedSalesLedger.findMany.mockResolvedValue([
        {
          invoiceId: "inv-1",
          invoiceItemId: "line-gone", // the old invoice item id: no such InvoiceItem any more
          orderItemId: "oi-1",
          unitBasisQty: 75,
          netSales: 87.5,
        },
      ]);
      prisma.invoiceItem.findMany.mockResolvedValue([]);
      prisma.orderItem.findMany.mockResolvedValue([
        { id: "oi-1", productId: "prod-1", qty: 75, boxes: null, pieces: null, unitsPerBox: 10 },
      ]);

      const report = await service.buildReport({
        category: "cat-tx",
        from: "2026-07-01",
        to: "2026-07-31",
      });

      expect(report.rows).toHaveLength(1);
      expect(report.rows[0][9]).toBe("CP"); // unit of measure comes from the product
      expect(report.warnings.map((w) => w.code)).not.toContain("UNMATCHED_LEDGER_LINE");
    });

    it("shows how many reversals could not be booked in the period, counted from the notices", async () => {
      prisma.auditLog.count.mockResolvedValue(1);
      const report = await service.buildReport({
        category: "cat-tx",
        from: "2026-07-01",
        to: "2026-07-31",
      });
      expect(report.unbookedReversals).toBe(1);
      expect(report.warnings[0]).toEqual({
        code: "UNBOOKED_REVERSALS",
        message: "1 reversals could not be booked; contact support.",
      });
      const where = prisma.auditLog.count.mock.calls[0][0].where;
      expect(where.action).toBe("REGULATED_REVERSAL_UNBOOKED");
      expect(where.createdAt.gte).toEqual(new Date("2026-07-01T00:00:00.000Z"));
      expect(where.createdAt.lt).toEqual(new Date("2026-08-01T00:00:00.000Z"));
    });

    it("a period with no unbooked notices carries no such warning or field", async () => {
      prisma.auditLog.count.mockResolvedValue(0);
      const report = await service.buildReport({
        category: "cat-tx",
        from: "2026-07-01",
        to: "2026-07-31",
      });
      expect(report.unbookedReversals).toBeUndefined();
      expect(report.warnings.map((w) => w.code)).not.toContain("UNBOOKED_REVERSALS");
    });

    it("resolves the customer's address via pickReportAddress precedence (default+BILLING over other rows)", async () => {
      prisma.customer.findMany.mockResolvedValue([
        customer({
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
        }),
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

  describe("custom-column pipeline", () => {
    const txCategory = {
      id: "cat-tx",
      name: "Cigarettes",
      reportTemplate: "TX_COMPTROLLER",
      unitBasis: null,
      wholesalerLicenseNo: "12345678",
    };

    beforeEach(() => {
      prisma.trackedCategory.findUnique.mockResolvedValue(txCategory);
      prisma.regulatedSalesLedger.findMany.mockResolvedValue([
        { invoiceId: "inv-1", invoiceItemId: "line-1", unitBasisQty: 10, netSales: 100 },
      ]);
      prisma.invoiceItem.findMany.mockResolvedValue([
        {
          id: "line-1",
          productId: "prod-1",
          qty: 10,
          boxes: null,
          pieces: null,
          unitsPerBox: 10,
        },
      ]);
      prisma.product.findMany.mockResolvedValue([
        {
          id: "prod-1",
          name: "Acme Full Flavor",
          unitsPerBox: 10,
          regItemType: "1",
          regUomCase: null,
          regUomUnit: "CP",
        },
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
    });

    it("omitting columns leaves the report unaffected (mobile back-compat) and custom unset, TX headerless", async () => {
      const report = await service.buildReport({
        category: "cat-tx",
        from: "2026-07-01",
        to: "2026-07-31",
      });
      expect(report.custom).toBeUndefined();
      expect(report.csv.includeHeader).toBe(false);
    });

    it("400s on an unknown column key", async () => {
      await expect(
        service.buildReport({
          category: "cat-tx",
          from: "2026-07-01",
          to: "2026-07-31",
          columns: "notARealColumn",
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("a columns request exactly equal to the template's default list is not custom and stays headerless", async () => {
      const report = await service.buildReport({
        category: "cat-tx",
        from: "2026-07-01",
        to: "2026-07-31",
        columns: defaultColumnKeys("TX_COMPTROLLER").join(","),
      });
      expect(report.custom).toBeUndefined();
      expect(report.csv.includeHeader).toBe(false);
    });

    it("a reorder-only request is custom, with a header, and the columns/rows follow the requested order", async () => {
      const defaults = defaultColumnKeys("TX_COMPTROLLER");
      const reordered = [defaults[1], defaults[0], ...defaults.slice(2)];
      const report = await service.buildReport({
        category: "cat-tx",
        from: "2026-07-01",
        to: "2026-07-31",
        columns: reordered.join(","),
      });
      expect(report.custom).toBe(true);
      expect(report.csv.includeHeader).toBe(true);
      expect(report.columns.map((c) => c.key)).toEqual(reordered);
    });

    it("requesting the optional itemDescription column is custom, header on, and appends -custom to the CSV filename", async () => {
      const columns = [...defaultColumnKeys("TX_COMPTROLLER"), "itemDescription"].join(",");

      const report = await service.buildReport({
        category: "cat-tx",
        from: "2026-07-01",
        to: "2026-07-31",
        columns,
      });
      expect(report.custom).toBe(true);
      expect(report.csv.includeHeader).toBe(true);
      expect(report.columns[report.columns.length - 1].key).toBe("itemDescription");
      expect(report.rows[0][report.rows[0].length - 1]).toBe("Acme Full Flavor");

      const { filename } = await service.buildReportCsv({
        category: "cat-tx",
        from: "2026-07-01",
        to: "2026-07-31",
        columns,
      });
      expect(filename).toBe("cigarettes-TX_COMPTROLLER-custom-2026-07-01-2026-07-31.csv");
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

  it("F-05: the CSV (filing export) never runs the uncategorised-lines review row; the preview does", async () => {
    const report = {
      template: "TX_COMPTROLLER",
      title: "T",
      categoryId: "c1",
      categoryName: "Cat",
      from: "2026-09-01",
      to: "2026-09-30",
      columns: [],
      rows: [],
      totalsRow: null,
      displayTotals: [],
      warnings: [],
      csv: { preamble: [], includeHeader: false, includeTotals: false, footer: [] },
    };
    const spy = jest.spyOn(service, "buildReport").mockResolvedValue(report as never);
    await service.buildReportCsv({ category: "c1", from: "2026-09-01", to: "2026-09-30" });
    expect(spy).toHaveBeenCalledWith(expect.anything(), { reviewRows: false });
    spy.mockRestore();
  });

  describe("F-05 uncategorised-lines row: the tenant timezone", () => {
    const range = { category: "cat-1", from: "2026-09-01", to: "2026-09-30" };
    let warnings: jest.SpyInstance;
    const policy = (enabled: boolean) =>
      ((service as any).sellingRestrictions.getPolicy as jest.Mock).mockResolvedValue({
        enabled,
        addressPrecedence: "BILLING_FIRST",
      });
    beforeEach(() => {
      prisma.getTenantId.mockReturnValue("tn-1");
      warnings = jest.spyOn(uncategorised, "uncategorisedLineWarnings").mockResolvedValue([]);
    });
    afterEach(() => warnings.mockRestore());

    it("policy ON: the tenant's timezone is read and passed through to the rule check", async () => {
      policy(true);
      prisma.tenantConfig.findUnique.mockResolvedValue({ timezone: "America/Chicago" });
      await service.buildReport(range);
      expect(prisma.tenantConfig.findUnique).toHaveBeenCalledWith({
        where: { tenantId: "tn-1" },
        select: { timezone: true },
      });
      expect(warnings).toHaveBeenCalledTimes(1);
      expect(warnings.mock.calls[0][3]).toBe("America/Chicago");
    });

    it("policy OFF: the tenant config is never read (and no timezone is passed)", async () => {
      policy(false);
      await service.buildReport(range);
      expect(prisma.tenantConfig.findUnique).not.toHaveBeenCalled();
      expect(warnings.mock.calls[0][3]).toBeNull();
    });
  });
});
