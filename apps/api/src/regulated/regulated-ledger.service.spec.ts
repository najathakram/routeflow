import { Test } from "@nestjs/testing";
import { RegulatedLedgerService } from "./regulated-ledger.service";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";

describe("RegulatedLedgerService", () => {
  let service: RegulatedLedgerService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const mod = await Test.createTestingModule({
      providers: [RegulatedLedgerService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = mod.get(RegulatedLedgerService);
  });

  describe("writeSaleEntries", () => {
    it("writes a SALE row per REGULATED line, skips standard lines, buckets by month", async () => {
      await service.writeSaleEntries({
        tenantId: "t1",
        orderId: "ord-1",
        invoiceId: "inv-1",
        soldAt: new Date("2026-07-15T00:00:00Z"),
        lines: [
          {
            invoiceItemId: "ii-1",
            orderItemId: null,
            trackedCategoryId: "cat-tob",
            qty: 3,
            netSales: 30,
            categoryTax: 0,
          },
          {
            invoiceItemId: "ii-2",
            orderItemId: null,
            trackedCategoryId: null,
            qty: 2,
            netSales: 20,
            categoryTax: 0,
          },
        ],
        db: prisma,
      });
      expect(prisma.regulatedSalesLedger.createMany).toHaveBeenCalledTimes(1);
      const data = prisma.regulatedSalesLedger.createMany.mock.calls[0][0].data;
      expect(data).toHaveLength(1); // only the regulated line
      expect(data[0]).toMatchObject({
        tenantId: "t1",
        trackedCategoryId: "cat-tob",
        entryType: "SALE",
        invoiceId: "inv-1",
        invoiceItemId: "ii-1",
        netSales: 30,
        categoryTax: 0,
        periodBucket: "2026-07",
      });
    });

    it("no-ops with no regulated lines and for a null tenant", async () => {
      await service.writeSaleEntries({
        tenantId: "t1",
        orderId: null,
        invoiceId: "inv-1",
        soldAt: new Date(),
        lines: [
          {
            invoiceItemId: "ii-1",
            orderItemId: null,
            trackedCategoryId: null,
            qty: 1,
            netSales: 5,
            categoryTax: 0,
          },
        ],
        db: prisma,
      });
      await service.writeSaleEntries({
        tenantId: null,
        orderId: null,
        invoiceId: "inv-1",
        soldAt: new Date(),
        lines: [
          {
            invoiceItemId: "ii-1",
            orderItemId: null,
            trackedCategoryId: "cat",
            qty: 1,
            netSales: 5,
            categoryTax: 0,
          },
        ],
        db: prisma,
      });
      expect(prisma.regulatedSalesLedger.createMany).not.toHaveBeenCalled();
    });
  });

  describe("reverseInvoiceEntries", () => {
    it("negates prior SALE rows and skips already-reversed lines", async () => {
      prisma.regulatedSalesLedger.findMany
        .mockResolvedValueOnce([
          {
            tenantId: "t1",
            trackedCategoryId: "cat",
            invoiceId: "inv-1",
            invoiceItemId: "ii-1",
            orderId: "ord-1",
            orderItemId: null,
            qty: 3,
            unitBasisQty: 3,
            netSales: 30,
            categoryTax: 2,
          },
          {
            tenantId: "t1",
            trackedCategoryId: "cat",
            invoiceId: "inv-1",
            invoiceItemId: "ii-2",
            orderId: "ord-1",
            orderItemId: null,
            qty: 1,
            unitBasisQty: 1,
            netSales: 10,
            categoryTax: 0,
          },
        ])
        .mockResolvedValueOnce([{ invoiceItemId: "ii-2" }]); // ii-2 already reversed

      await service.reverseInvoiceEntries({ invoiceId: "inv-1", db: prisma });
      expect(prisma.regulatedSalesLedger.createMany).toHaveBeenCalledTimes(1);
      const data = prisma.regulatedSalesLedger.createMany.mock.calls[0][0].data;
      expect(data).toHaveLength(1); // only ii-1 (ii-2 already reversed)
      expect(data[0]).toMatchObject({
        entryType: "REVERSAL",
        invoiceItemId: "ii-1",
        qty: -3,
        netSales: -30,
        categoryTax: -2,
      });
    });

    it("no-ops when the invoice has no SALE rows", async () => {
      prisma.regulatedSalesLedger.findMany.mockResolvedValue([]);
      await service.reverseInvoiceEntries({ invoiceId: "inv-x", db: prisma });
      expect(prisma.regulatedSalesLedger.createMany).not.toHaveBeenCalled();
    });
  });

  describe("reverseReturnEntries", () => {
    const saleRow = (over: Record<string, unknown> = {}) => ({
      tenantId: "t1",
      trackedCategoryId: "cat-A",
      orderId: "ord-1",
      orderItemId: null,
      invoiceId: "inv-1",
      invoiceItemId: "ii-1",
      qty: 3,
      unitBasisQty: 3,
      netSales: 30,
      categoryTax: 6,
      ...over,
    });

    // Arrange the 3 regulatedSalesLedger.findMany calls (prior→sales→priorReversals)
    // + the invoiceItem.findMany bridge.
    const arrange = (opts: {
      prior?: unknown[];
      sales: unknown[];
      priorReversals?: unknown[];
      items: unknown[];
    }) => {
      prisma.regulatedSalesLedger.findMany
        .mockResolvedValueOnce(opts.prior ?? [])
        .mockResolvedValueOnce(opts.sales)
        .mockResolvedValueOnce(opts.priorReversals ?? []);
      prisma.invoiceItem.findMany.mockResolvedValue(opts.items);
    };

    const written = () => prisma.regulatedSalesLedger.createMany.mock.calls[0][0].data;

    it("fully reverses a single SALE row, using the row's category snapshot", async () => {
      arrange({ sales: [saleRow()], items: [{ id: "ii-1", productId: "p1" }] });
      await service.reverseReturnEntries({
        returnId: "ret-1",
        orderId: "ord-1",
        returnedByProduct: new Map([["p1", 3]]),
        db: prisma,
      });
      expect(prisma.regulatedSalesLedger.createMany).toHaveBeenCalledTimes(1);
      expect(written()).toHaveLength(1);
      expect(written()[0]).toMatchObject({
        entryType: "REVERSAL",
        returnId: "ret-1",
        invoiceItemId: "ii-1",
        trackedCategoryId: "cat-A", // from the SALE snapshot, not the live product
        qty: -3,
        netSales: -30,
        categoryTax: -6,
      });
    });

    it("PRO-RATES a partial return off the original row (rounded to cents)", async () => {
      arrange({
        sales: [saleRow({ qty: 3, netSales: 10, categoryTax: 6 })],
        items: [{ id: "ii-1", productId: "p1" }],
      });
      await service.reverseReturnEntries({
        returnId: "ret-1",
        orderId: "ord-1",
        returnedByProduct: new Map([["p1", 1]]), // 1 of 3
        db: prisma,
      });
      expect(written()[0]).toMatchObject({ qty: -1, netSales: -3.33, categoryTax: -2 });
    });

    it("is idempotent — a return already reversed writes nothing", async () => {
      prisma.regulatedSalesLedger.findMany.mockResolvedValueOnce([{ id: "existing-rev" }]);
      await service.reverseReturnEntries({
        returnId: "ret-1",
        orderId: "ord-1",
        returnedByProduct: new Map([["p1", 1]]),
        db: prisma,
      });
      expect(prisma.regulatedSalesLedger.createMany).not.toHaveBeenCalled();
    });

    it("no-ops when the order has no SALE rows (return of an un-invoiced sale)", async () => {
      arrange({ sales: [], items: [] });
      await service.reverseReturnEntries({
        returnId: "ret-1",
        orderId: "ord-1",
        returnedByProduct: new Map([["p1", 1]]),
        db: prisma,
      });
      expect(prisma.regulatedSalesLedger.createMany).not.toHaveBeenCalled();
    });

    it("allocates a return across MULTIPLE SALE rows (W4 split invoices) FIFO", async () => {
      arrange({
        sales: [
          saleRow({
            invoiceItemId: "ii-1",
            invoiceId: "inv-1",
            qty: 2,
            netSales: 20,
            categoryTax: 4,
            unitBasisQty: 2,
          }),
          saleRow({
            invoiceItemId: "ii-2",
            invoiceId: "inv-2",
            qty: 3,
            netSales: 30,
            categoryTax: 6,
            unitBasisQty: 3,
          }),
        ],
        items: [
          { id: "ii-1", productId: "p1" },
          { id: "ii-2", productId: "p1" },
        ],
      });
      await service.reverseReturnEntries({
        returnId: "ret-1",
        orderId: "ord-1",
        returnedByProduct: new Map([["p1", 4]]), // 2 from ii-1, 2 from ii-2
        db: prisma,
      });
      const rows = written();
      expect(rows).toHaveLength(2);
      expect(rows.reduce((s: number, r: any) => s + r.qty, 0)).toBe(-4);
      expect(rows.reduce((s: number, r: any) => s + r.netSales, 0)).toBe(-40); // 20 + (30*2/3)
    });

    it("subtracts prior partial reversals so cumulative reversal can't exceed sold qty", async () => {
      arrange({
        sales: [saleRow({ qty: 3, netSales: 30, categoryTax: 0 })],
        // 2 units already reversed elsewhere (-$20 of the $30 row).
        priorReversals: [{ invoiceItemId: "ii-1", qty: -2, netSales: -20, categoryTax: 0 }],
        items: [{ id: "ii-1", productId: "p1" }],
      });
      await service.reverseReturnEntries({
        returnId: "ret-2",
        orderId: "ord-1",
        returnedByProduct: new Map([["p1", 3]]), // wants 3, only 1 remains
        db: prisma,
      });
      expect(written()[0]).toMatchObject({ qty: -1, netSales: -10 });
    });

    it("closing chunk absorbs rounding drift so a fully-returned line nets to exactly 0", async () => {
      // Two prior 1-unit returns booked -3.33 each; this 3rd unit CLOSES the row and
      // must book the exact remaining balance (-3.34), not another pro-rated -3.33,
      // so the +10.00 SALE nets to exactly 0 (not a phantom +0.01).
      arrange({
        sales: [saleRow({ qty: 3, netSales: 10, categoryTax: 0 })],
        priorReversals: [
          { invoiceItemId: "ii-1", qty: -1, netSales: -3.33, categoryTax: 0 },
          { invoiceItemId: "ii-1", qty: -1, netSales: -3.33, categoryTax: 0 },
        ],
        items: [{ id: "ii-1", productId: "p1" }],
      });
      await service.reverseReturnEntries({
        returnId: "ret-3",
        orderId: "ord-1",
        returnedByProduct: new Map([["p1", 1]]),
        db: prisma,
      });
      expect(written()[0]).toMatchObject({ qty: -1, netSales: -3.34 });
    });
  });

  describe("unreverseReturnEntries", () => {
    it("deletes the return's REVERSAL rows", async () => {
      await service.unreverseReturnEntries({ returnId: "ret-1", db: prisma });
      expect(prisma.regulatedSalesLedger.deleteMany).toHaveBeenCalledWith({
        where: { returnId: "ret-1", entryType: "REVERSAL" },
      });
    });
  });
});
