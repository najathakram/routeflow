import { Test } from "@nestjs/testing";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { InsightWindowError } from "../analytics/demand-range";
import { ProductInsightsService } from "./product-insights.service";
import { SalesFactsService } from "./sales-facts.service";
import { InvalidLineCursorError, decodeLineCursor } from "./sales-facts.rules";

/**
 * #2118 — ProductInsightsService against a mocked Prisma: the READ SHAPES (accrual predicate,
 * explicit tenant, through-Invoice, tenant-local instant windows), paging by line, and the
 * per-line netting badges. The money aggregation itself is pinned in
 * `product-insights.aggregate.spec.ts`; real-Postgres behavior in `sales-facts.db.spec.ts`.
 */
const D = (n: number | string) => new Prisma.Decimal(n);
const NY = "America/New_York";

const PRODUCT_ROW = {
  id: "p1",
  name: "Sparkling Water 12pk",
  sku: "SW-12",
  unitSku: null,
  barcode: null,
  unitsPerBox: 12,
  unit: "case",
  isActive: true,
};

/** An invoice as the line read returns it: two lines of p1 unless overridden. */
function inv(n: number, over: Record<string, any> = {}) {
  const issueDate = new Date(`2026-07-${String(20 - n).padStart(2, "0")}T00:00:00.000Z`);
  return {
    id: `inv-${n}`,
    invoiceNumber: `INV-${n}`,
    status: "SENT",
    issueDate,
    createdAt: new Date(issueDate.getTime() + 15 * 3_600_000),
    orderId: `ord-${n}`,
    order: { orderNumber: `ORD-${n}` },
    customerId: "c1",
    customer: { id: "c1", businessName: "Acme Grocers" },
    items: [1, 2].map((k) => ({
      id: `inv-${n}-line-${k}`,
      createdAt: new Date(issueDate.getTime() + 15 * 3_600_000 + k * 1_000),
      qty: D(12),
      subtotal: D(30),
      unitPrice: D(30),
      originalPrice: null,
      priceType: "STANDARD",
      boxes: 1,
      pieces: 0,
      unitsPerBox: 12,
      unitLabel: null,
    })),
    ...over,
  };
}

describe("ProductInsightsService (#2118)", () => {
  let service: ProductInsightsService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    prisma.product.findFirst.mockResolvedValue(PRODUCT_ROW);
    prisma.tenantConfig.findUnique.mockResolvedValue({ timezone: NY });
    const module = await Test.createTestingModule({
      providers: [
        ProductInsightsService,
        SalesFactsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(ProductInsightsService);
  });

  describe("fail-closed context", () => {
    it("refuses a tenant-less (SUPER_ADMIN) context before reading anything", async () => {
      prisma.getTenantId.mockReturnValue(null);
      await expect(service.getProductInsights("p1", {})).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(service.getProductSalesPage("p1", {})).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.invoice.findMany).not.toHaveBeenCalled();
    });

    it("404s an unknown product (a deactivated one is still found by id)", async () => {
      prisma.product.findFirst.mockResolvedValue(null);
      await expect(service.getProductInsights("nope", {})).rejects.toBeInstanceOf(
        NotFoundException,
      );
      const where = prisma.product.findFirst.mock.calls[0][0].where;
      expect(where).toEqual({ id: "nope", tenantId: "test-tenant" }); // no isActive filter
    });

    it("refuses an over-long window before any line read (the controller answers 400)", async () => {
      await expect(
        service.getProductInsights("p1", { from: "2023-01-01", to: "2026-09-25" }),
      ).rejects.toBeInstanceOf(InsightWindowError);
      expect(prisma.invoice.findMany).not.toHaveBeenCalled();
    });
  });

  describe("GET insights — read shapes", () => {
    it("reads lines THROUGH Invoice, accrual basis, explicit tenant, exact issue-day window", async () => {
      await service.getProductInsights("p1", { from: "2026-06-01", to: "2026-08-31" });

      expect(prisma.invoiceItem.findMany).not.toHaveBeenCalled();
      const args = prisma.invoice.findMany.mock.calls[0][0];
      expect(args.where).toEqual({
        tenantId: "test-tenant",
        // A2: WRITTEN_OFF is a sale; only DRAFT/VOID are out.
        status: { notIn: ["DRAFT", "VOID"] },
        items: { some: { productId: "p1" } },
        issueDate: {
          gte: new Date("2026-06-01T00:00:00.000Z"),
          lt: new Date("2026-09-01T00:00:00.000Z"),
        },
      });
      expect(args.select.items.where).toEqual({ productId: "p1" });
      expect(args.take).toBeUndefined();
    });

    it("windows credit notes on the REAL instants of the tenant's local days (A5)", async () => {
      await service.getProductInsights("p1", { from: "2026-06-01", to: "2026-08-31" });

      const cn = prisma.creditNote.findMany.mock.calls[0][0].where;
      expect(cn).toEqual({
        tenantId: "test-tenant",
        status: { not: "VOID" },
        // Midnight New York (EDT) on Jun 1 .. midnight on Sep 1, half-open.
        createdAt: {
          gte: new Date("2026-06-01T04:00:00.000Z"),
          lt: new Date("2026-09-01T04:00:00.000Z"),
        },
        invoice: { is: { items: { some: { productId: "p1" } } } },
      });
    });

    it("reads returns of the product: external refunds in the window, or credit-note returns near it", async () => {
      await service.getProductInsights("p1", { from: "2026-06-01", to: "2026-08-31" });

      const where = prisma.return.findMany.mock.calls[0][0].where;
      expect(where.tenantId).toBe("test-tenant");
      expect(where.items).toEqual({ some: { productId: "p1" } });
      expect(where.OR[0]).toEqual({
        refundMethod: "EXTERNAL_REFUND",
        refundedAt: {
          gte: new Date("2026-06-01T04:00:00.000Z"),
          lt: new Date("2026-09-01T04:00:00.000Z"),
        },
      });
      expect(where.OR[1].creditNoteId).toEqual({ not: null });
    });

    it("an unconfigured tenant (no TenantConfig) uses UTC day bounds, never a guessed zone", async () => {
      prisma.tenantConfig.findUnique.mockResolvedValue(null);
      const res = await service.getProductInsights("p1", { from: "2026-06-01", to: "2026-06-30" });
      expect(res.window.timezone).toBe("UTC");
      expect(prisma.creditNote.findMany.mock.calls[0][0].where.createdAt).toEqual({
        gte: new Date("2026-06-01T00:00:00.000Z"),
        lt: new Date("2026-07-01T00:00:00.000Z"),
      });
    });

    it("attributes a credit-note line item to this product and leaves the rest unattributed", async () => {
      prisma.invoice.findMany.mockImplementation(async (args: any) =>
        // The line → product map is read THROUGH Invoice for just the itemized line ids.
        args.where.items?.some?.id
          ? [{ items: [{ id: "inv-1-line-1", productId: "p1" }] }]
          : [inv(1)],
      );
      prisma.creditNote.findMany.mockResolvedValue([
        {
          id: "cn-1",
          amount: D(20),
          status: "ISSUED",
          createdAt: new Date("2026-07-15T16:00:00.000Z"),
          customerId: "c1",
          customer: { businessName: "Acme Grocers" },
          items: [{ invoiceItemId: "inv-1-line-1", amount: D(12.5) }],
        },
      ]);

      const res = await service.getProductInsights("p1", { from: "2026-07-01", to: "2026-07-31" });

      expect(res.totals).toMatchObject({
        lineGross: 60,
        attributedCredits: 12.5,
        lineNet: 47.5,
        unattributedCredits: 7.5,
      });
      const lineMapRead = prisma.invoice.findMany.mock.calls.find(
        (c: any[]) => c[0].where.items?.some?.id,
      );
      expect(lineMapRead?.[0].where).toEqual({
        tenantId: "test-tenant",
        items: { some: { id: { in: ["inv-1-line-1"] } } },
      });
    });
  });

  describe("GET sales — paged by LINE, never by invoice", () => {
    it("plan §E pin: 3 invoices × 2 lines, limit 4 → 4 lines + cursor; the next page → 2 lines, no cursor", async () => {
      prisma.invoice.findMany.mockResolvedValueOnce([inv(1), inv(2), inv(3)]);

      const page1 = await service.getProductSalesPage("p1", { limit: 4 });

      expect(page1.lines.map((l) => l.lineId)).toEqual([
        "inv-1-line-2",
        "inv-1-line-1",
        "inv-2-line-2",
        "inv-2-line-1",
      ]);
      expect(page1.nextCursor).not.toBeNull();
      // Invoices are fetched limit + 2 at a time — every invoice has ≥ 1 line of the product.
      expect(prisma.invoice.findMany.mock.calls[0][0].take).toBe(6);

      // The DB answers the inclusive keyset "at or after inv-2": inv-2 is re-read, and both of
      // its lines were already served, so only inv-3's come back.
      prisma.invoice.findMany.mockResolvedValueOnce([inv(2), inv(3)]);
      const page2 = await service.getProductSalesPage("p1", {
        limit: 4,
        cursor: page1.nextCursor as string,
      });
      expect(page2.lines.map((l) => l.lineId)).toEqual(["inv-3-line-2", "inv-3-line-1"]);
      expect(page2.nextCursor).toBeNull();

      const cursor = decodeLineCursor(page1.nextCursor as string);
      expect(prisma.invoice.findMany.mock.calls[1][0].where.OR).toEqual([
        { issueDate: { lt: cursor.issueDate } },
        { issueDate: cursor.issueDate, createdAt: { lt: cursor.invoiceCreatedAt } },
        { issueDate: cursor.issueDate, createdAt: cursor.invoiceCreatedAt, id: { lte: "inv-2" } },
      ]);
    });

    it("a page can end mid-invoice and the next one resumes after the served line", async () => {
      prisma.invoice.findMany.mockResolvedValueOnce([inv(1), inv(2), inv(3)]);
      const page1 = await service.getProductSalesPage("p1", { limit: 3 });
      expect(page1.lines.map((l) => l.lineId)).toEqual([
        "inv-1-line-2",
        "inv-1-line-1",
        "inv-2-line-2",
      ]);

      prisma.invoice.findMany.mockResolvedValueOnce([inv(2), inv(3)]);
      const page2 = await service.getProductSalesPage("p1", {
        limit: 3,
        cursor: page1.nextCursor as string,
      });
      expect(page2.lines.map((l) => l.lineId)).toEqual([
        "inv-2-line-1",
        "inv-3-line-2",
        "inv-3-line-1",
      ]);
      expect(page2.nextCursor).toBeNull();
    });

    it("filters to one buyer and keeps the accrual predicate", async () => {
      await service.getProductSalesPage("p1", {
        customerId: "c9",
        from: "2026-01-01",
        to: "2026-01-31",
      });
      const where = prisma.invoice.findMany.mock.calls[0][0].where;
      expect(where).toMatchObject({
        tenantId: "test-tenant",
        customerId: "c9",
        status: { notIn: ["DRAFT", "VOID"] },
        issueDate: {
          gte: new Date("2026-01-01T00:00:00.000Z"),
          lt: new Date("2026-02-01T00:00:00.000Z"),
        },
      });
    });

    it("refuses a forged cursor (the controller answers 400)", async () => {
      await expect(service.getProductSalesPage("p1", { cursor: "e30" })).rejects.toBeInstanceOf(
        InvalidLineCursorError,
      );
    });

    it("badges written-off lines and carries each line's credited amount and returned pieces", async () => {
      prisma.invoice.findMany.mockResolvedValueOnce([inv(1, { status: "WRITTEN_OFF" })]);
      prisma.creditNote.findMany.mockImplementation(async (args: any) => {
        if (args.where.items) {
          return [{ items: [{ invoiceItemId: "inv-1-line-1", amount: D(4.5) }] }];
        }
        if (args.where.id) {
          return [{ id: "cn-r", status: "ISSUED", createdAt: new Date("2026-07-20T12:00:00Z") }];
        }
        return [];
      });
      prisma.return.findMany.mockResolvedValue([
        {
          refundMethod: "CREDIT_NOTE",
          refundedAt: new Date("2026-07-20T12:00:00Z"),
          creditNoteId: "cn-r",
          items: [{ sourceInvoiceItemId: "inv-1-line-2", qty: D(3) }],
        },
      ]);

      const page = await service.getProductSalesPage("p1", {});

      expect(page.lines).toHaveLength(2);
      expect(page.lines.every((l) => l.writtenOff)).toBe(true);
      const byId = Object.fromEntries(page.lines.map((l) => [l.lineId, l]));
      expect(byId["inv-1-line-1"]).toMatchObject({ creditedAmount: 4.5, returnedQty: 0 });
      expect(byId["inv-1-line-2"]).toMatchObject({ creditedAmount: 0, returnedQty: 3 });
      // Boxed line: $30 box of 12 → 2.50 per piece, never the box price.
      expect(byId["inv-1-line-1"]).toMatchObject({ unitPrice: 30, lineTotal: 30, perPiece: 2.5 });
    });
  });

  describe("CSV export", () => {
    async function collect(iter: AsyncIterable<string>): Promise<string> {
      let out = "";
      for await (const chunk of iter) out += chunk;
      return out;
    }

    it("streams a header, one row per line (formula-safe), the row sums and the window totals", async () => {
      prisma.invoice.findMany.mockResolvedValue([
        inv(1, { customer: { id: "c1", businessName: "=HYPERLINK(1)" } }),
      ]);
      const { csv, filename } = await service.prepareCsvExport("p1", {
        from: "2026-07-01",
        to: "2026-07-31",
      });
      const text = await collect(csv);
      const rows = text.split("\r\n");

      expect(filename).toBe("product-sales-SW-12-2026-07-01-to-2026-07-31.csv");
      expect(rows[0]).toMatch(/^Date,Invoice,Written off,Order,Customer,Qty \(pieces\)/);
      expect(rows[1]).toContain("'=HYPERLINK(1)");
      expect(rows.filter((r) => r.startsWith("2026-07-19,INV-1"))).toHaveLength(2);
      expect(text).toContain("Rows total,,,,,24,,,,,,60,,,,0,0");
      expect(text).toContain("Line gross,60");
      expect(text).toContain("Line net,60");
    });

    it("a buyer-filtered export omits the window totals (they would not reconcile with the rows)", async () => {
      prisma.invoice.findMany.mockResolvedValue([inv(1)]);
      const { csv } = await service.prepareCsvExport("p1", { customerId: "c1" });
      const text = await collect(csv);
      expect(text).toContain("Rows total");
      expect(text).not.toContain("Window totals");
    });

    it("validation and the 404 happen before streaming (a refused request is never a partial file)", async () => {
      prisma.product.findFirst.mockResolvedValue(null);
      await expect(service.prepareCsvExport("p1", {})).rejects.toBeInstanceOf(NotFoundException);
      prisma.product.findFirst.mockResolvedValue(PRODUCT_ROW);
      await expect(
        service.prepareCsvExport("p1", { from: "2026-09-01", to: "2026-08-01" }),
      ).rejects.toBeInstanceOf(InsightWindowError);
    });
  });
});
