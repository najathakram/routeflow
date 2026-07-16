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

  describe("reverseInvoiceEntries (net-aware)", () => {
    // Ledger-row factories (the shape findMany returns).
    const sale = (over: any = {}) => ({
      tenantId: "t1",
      trackedCategoryId: "cat",
      entryType: "SALE",
      orderId: "ord-1",
      orderItemId: "oi-1",
      invoiceId: "inv-1",
      invoiceItemId: "ii-1",
      qty: 10,
      unitBasisQty: 10,
      netSales: 50,
      categoryTax: 0,
      ...over,
    });
    const reversal = (over: any = {}) =>
      sale({
        entryType: "REVERSAL",
        qty: -3,
        unitBasisQty: -3,
        netSales: -15,
        categoryTax: 0,
        ...over,
      });
    const written = (call = 0) => prisma.regulatedSalesLedger.createMany.mock.calls[call][0].data;

    it("plain void — reverses the full sale (no prior reversal)", async () => {
      prisma.regulatedSalesLedger.findMany.mockResolvedValue([
        sale({ qty: 10, netSales: 50, categoryTax: 2 }),
      ]);
      await service.reverseInvoiceEntries({ invoiceId: "inv-1", db: prisma });
      const data = written();
      expect(data).toHaveLength(1);
      expect(data[0]).toMatchObject({
        entryType: "REVERSAL",
        invoiceItemId: "ii-1",
        qty: -10,
        netSales: -50,
        categoryTax: -2,
      });
    });

    it("reverses only each line's REMAINING net; a fully-reversed line is skipped", async () => {
      // ii-1: SALE 3, no reversal → reverse -3. ii-2: SALE 1 + REVERSAL -1 → net 0 → skip.
      prisma.regulatedSalesLedger.findMany.mockResolvedValue([
        sale({ invoiceItemId: "ii-1", qty: 3, netSales: 30, categoryTax: 2 }),
        sale({ invoiceItemId: "ii-2", qty: 1, netSales: 10, categoryTax: 0 }),
        reversal({ invoiceItemId: "ii-2", qty: -1, netSales: -10, categoryTax: 0 }),
      ]);
      await service.reverseInvoiceEntries({ invoiceId: "inv-1", db: prisma });
      const data = written();
      expect(data).toHaveLength(1);
      expect(data[0]).toMatchObject({
        invoiceItemId: "ii-1",
        qty: -3,
        netSales: -30,
        categoryTax: -2,
      });
    });

    it("PARTIAL return then void reverses ONLY the un-returned remainder (no over-report)", async () => {
      // SALE(+10) with a prior return REVERSAL(-3) → remaining 7 → reverse -7 (NOT skipped,
      // NOT the full -10). Ledger nets to 0 (voided): 10 − 3 − 7 = 0.
      prisma.regulatedSalesLedger.findMany.mockResolvedValue([
        sale({ qty: 10, netSales: 50 }),
        reversal({ qty: -3, netSales: -15 }),
      ]);
      await service.reverseInvoiceEntries({ invoiceId: "inv-1", db: prisma });
      const data = written();
      expect(data).toHaveLength(1);
      expect(data[0]).toMatchObject({ invoiceItemId: "ii-1", qty: -7, netSales: -35 });
    });

    it("FULL return then void nets to 0 — writes nothing", async () => {
      prisma.regulatedSalesLedger.findMany.mockResolvedValue([
        sale({ qty: 10, netSales: 50 }),
        reversal({ qty: -10, netSales: -50 }),
      ]);
      await service.reverseInvoiceEntries({ invoiceId: "inv-1", db: prisma });
      expect(prisma.regulatedSalesLedger.createMany).not.toHaveBeenCalled();
    });

    it("double void is a no-op (line already fully reversed)", async () => {
      // First void already wrote REVERSAL(-10); a second call finds net 0.
      prisma.regulatedSalesLedger.findMany.mockResolvedValue([
        sale({ qty: 10, netSales: 50 }),
        reversal({ qty: -10, netSales: -50 }),
      ]);
      await service.reverseInvoiceEntries({ invoiceId: "inv-1", db: prisma });
      expect(prisma.regulatedSalesLedger.createMany).not.toHaveBeenCalled();
    });

    it("reconcile after a partial return: reverse remainder + new SALE nets to the delivered qty", async () => {
      // Models InvoicesService#resyncInvoiceLedger's two calls. Pre-existing ledger:
      // SALE(+10) + return REVERSAL(−3). The OLD code left the SALE stranded and wrote a
      // fresh +delivered → +17 over-count; net-aware reverses the remaining −7 first.
      prisma.regulatedSalesLedger.findMany.mockResolvedValue([
        sale({ qty: 10, netSales: 50 }),
        reversal({ qty: -3, netSales: -15 }),
      ]);
      await service.reverseInvoiceEntries({ invoiceId: "inv-1", db: prisma }); // resync step 1
      const reverse = written(0);
      expect(reverse[0]).toMatchObject({ qty: -7, netSales: -35 });

      await service.writeSaleEntries({
        tenantId: "t1",
        orderId: "ord-1",
        invoiceId: "inv-1",
        soldAt: new Date(),
        lines: [
          {
            invoiceItemId: "ii-2",
            orderItemId: "oi-1",
            trackedCategoryId: "cat",
            qty: 4,
            netSales: 20,
            categoryTax: 0,
          },
        ],
        db: prisma,
      }); // resync step 2 — delivered 4
      const newSale = written(1);
      expect(newSale[0]).toMatchObject({ entryType: "SALE", qty: 4, netSales: 20 });

      // Ledger net = original SALE(+10) + return(−3) + reverse(−7) + new SALE(+4) = +4.
      const netQty = [
        10,
        -3,
        ...reverse.map((r: any) => r.qty),
        ...newSale.map((r: any) => r.qty),
      ].reduce((a, b) => a + b, 0);
      // Nets to the DELIVERED qty (4) — the +17 over-count the old stranded-SALE code
      // produced is gone. RESIDUAL (tracked follow-up): the reverse+rebook drops the
      // return's −3 reduction, so the true net (delivered − returned = 1) is still
      // over-reported by the returned qty; preserving returns across a re-reconcile needs
      // order-line-keyed return tracking, out of scope for this net-aware pass.
      expect(netQty).toBe(4);
    });

    it("no-ops when the invoice has no ledger rows", async () => {
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

    it("does not double-reverse when a CREDIT NOTE already reversed the same line", async () => {
      // Reachable path: the returns page can both process the return AND issue a credit
      // note. The credit-note REVERSAL (keyed by invoiceItemId) must count against the
      // return's cap so the SALE isn't reversed twice into a negative filing.
      arrange({
        sales: [saleRow({ qty: 3, netSales: 30, categoryTax: 0 })],
        priorReversals: [{ invoiceItemId: "ii-1", qty: -3, netSales: -30, categoryTax: 0 }],
        items: [{ id: "ii-1", productId: "p1" }],
      });
      await service.reverseReturnEntries({
        returnId: "ret-dup",
        orderId: "ord-1",
        returnedByProduct: new Map([["p1", 3]]), // wants all 3, but 0 remain
        db: prisma,
      });
      expect(prisma.regulatedSalesLedger.createMany).not.toHaveBeenCalled();
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

  describe("reverseCreditNoteEntries", () => {
    it("reverses a credited regulated line against its matching SALE row (stamps source ids)", async () => {
      prisma.regulatedSalesLedger.findMany
        .mockResolvedValueOnce([]) // idempotency: none prior for this creditNoteId
        .mockResolvedValueOnce([
          {
            invoiceItemId: "ii-1",
            netSales: 30,
            qty: 3,
            categoryTax: 6,
            orderId: "ord-1",
            orderItemId: "oi-1",
            invoiceId: "inv-1",
          },
        ]) // SALE rows
        .mockResolvedValueOnce([]); // prior REVERSAL rows: none
      prisma.creditNoteItem.findMany.mockResolvedValue([
        {
          tenantId: "t1",
          trackedCategoryId: "cat-A",
          invoiceItemId: "ii-1",
          amount: 15, // partial credit of the $30 line
          qty: 1.5,
          categoryTax: 3,
        },
      ]);
      await service.reverseCreditNoteEntries({ creditNoteId: "cn-1", db: prisma });
      expect(prisma.regulatedSalesLedger.createMany).toHaveBeenCalledTimes(1);
      expect(prisma.regulatedSalesLedger.createMany.mock.calls[0][0].data[0]).toMatchObject({
        entryType: "REVERSAL",
        creditNoteId: "cn-1",
        trackedCategoryId: "cat-A",
        invoiceItemId: "ii-1",
        orderId: "ord-1", // stamped from the SALE so the return path's cap sees it
        orderItemId: "oi-1",
        invoiceId: "inv-1",
        qty: -1.5,
        netSales: -15,
        categoryTax: -3,
      });
    });

    it("does NOT book a naked reversal when the credited line has no SALE row", async () => {
      // e.g. a pre-W5 / non-split invoice: CreditNoteItem exists but no SALE was ledgered.
      prisma.regulatedSalesLedger.findMany
        .mockResolvedValueOnce([]) // idempotency
        .mockResolvedValueOnce([]) // SALE rows: NONE
        .mockResolvedValueOnce([]); // prior reversals
      prisma.creditNoteItem.findMany.mockResolvedValue([
        {
          tenantId: "t1",
          trackedCategoryId: "cat-A",
          invoiceItemId: "ii-1",
          amount: 15,
          qty: 1.5,
          categoryTax: 3,
        },
      ]);
      await service.reverseCreditNoteEntries({ creditNoteId: "cn-1", db: prisma });
      expect(prisma.regulatedSalesLedger.createMany).not.toHaveBeenCalled();
    });

    it("clamps so a credit can't reverse more than the line's remaining un-reversed balance", async () => {
      // SALE $30/qty3; a prior return already reversed the whole line (-$30/-3).
      // A $30 credit of the same line must reverse NOTHING (already fully reversed).
      prisma.regulatedSalesLedger.findMany
        .mockResolvedValueOnce([]) // idempotency
        .mockResolvedValueOnce([{ invoiceItemId: "ii-1", netSales: 30, qty: 3, categoryTax: 0 }]) // SALE
        .mockResolvedValueOnce([{ invoiceItemId: "ii-1", netSales: -30, qty: -3, categoryTax: 0 }]); // prior REVERSAL
      prisma.creditNoteItem.findMany.mockResolvedValue([
        {
          tenantId: "t1",
          trackedCategoryId: "cat-A",
          invoiceItemId: "ii-1",
          amount: 30,
          qty: 3,
          categoryTax: 0,
        },
      ]);
      await service.reverseCreditNoteEntries({ creditNoteId: "cn-2", db: prisma });
      expect(prisma.regulatedSalesLedger.createMany).not.toHaveBeenCalled();
    });

    it("clamps WITHIN a batch: two items on the same line can't over-reverse the SALE", async () => {
      // Defense-in-depth for the duplicate-invoiceItemId vector: even if two
      // CreditNoteItems reference the same line, cumulative reversal is capped at the SALE.
      prisma.regulatedSalesLedger.findMany
        .mockResolvedValueOnce([]) // idempotency
        .mockResolvedValueOnce([{ invoiceItemId: "ii-1", netSales: 100, qty: 10, categoryTax: 0 }]) // SALE
        .mockResolvedValueOnce([]); // prior reversals: none
      prisma.creditNoteItem.findMany.mockResolvedValue([
        {
          tenantId: "t1",
          trackedCategoryId: "cat-A",
          invoiceItemId: "ii-1",
          amount: 100,
          qty: 10,
          categoryTax: 0,
        },
        {
          tenantId: "t1",
          trackedCategoryId: "cat-A",
          invoiceItemId: "ii-1",
          amount: 100,
          qty: 10,
          categoryTax: 0,
        },
      ]);
      await service.reverseCreditNoteEntries({ creditNoteId: "cn-dup", db: prisma });
      const data = prisma.regulatedSalesLedger.createMany.mock.calls[0][0].data;
      const totalNet = data.reduce((s: number, r: any) => s + r.netSales, 0);
      const totalQty = data.reduce((s: number, r: any) => s + r.qty, 0);
      expect(totalNet).toBe(-100); // NOT -200
      expect(totalQty).toBe(-10);
    });

    it("is idempotent — a credit note already reversed writes nothing", async () => {
      prisma.regulatedSalesLedger.findMany.mockResolvedValueOnce([{ id: "existing-rev" }]);
      await service.reverseCreditNoteEntries({ creditNoteId: "cn-1", db: prisma });
      expect(prisma.regulatedSalesLedger.createMany).not.toHaveBeenCalled();
    });

    it("no-ops when the credit note has no regulated items", async () => {
      prisma.regulatedSalesLedger.findMany.mockResolvedValueOnce([]);
      prisma.creditNoteItem.findMany.mockResolvedValue([]); // only non-regulated (filtered out by the query)
      await service.reverseCreditNoteEntries({ creditNoteId: "cn-1", db: prisma });
      expect(prisma.regulatedSalesLedger.createMany).not.toHaveBeenCalled();
    });

    it("closing credit books the exact remaining balance (no multi-credit drift)", async () => {
      // SALE net 90; two earlier credits already reversed -60.01; this credit's item
      // is -30 nominal but must CLOSE to -29.99 so the line nets to exactly 0.
      prisma.regulatedSalesLedger.findMany
        .mockResolvedValueOnce([]) // idempotency: none for this creditNoteId
        .mockResolvedValueOnce([{ invoiceItemId: "ii-1", netSales: 90, qty: 3, categoryTax: 0 }]) // SALE
        .mockResolvedValueOnce([
          { invoiceItemId: "ii-1", netSales: -30.01, qty: -1, categoryTax: 0 },
          { invoiceItemId: "ii-1", netSales: -30.0, qty: -1, categoryTax: 0 },
        ]); // prior REVERSAL rows
      prisma.creditNoteItem.findMany.mockResolvedValue([
        {
          tenantId: "t1",
          trackedCategoryId: "cat-A",
          invoiceItemId: "ii-1",
          amount: 30,
          qty: 1,
          categoryTax: 0,
        },
      ]);
      await service.reverseCreditNoteEntries({ creditNoteId: "cn-3", db: prisma });
      const row = prisma.regulatedSalesLedger.createMany.mock.calls[0][0].data[0];
      expect(row.netSales).toBe(-29.99); // -90 - (-60.01); total across the 3 credits = -90.00
    });

    it("unreverseCreditNoteEntries deletes the credit note's REVERSAL rows", async () => {
      await service.unreverseCreditNoteEntries({ creditNoteId: "cn-1", db: prisma });
      expect(prisma.regulatedSalesLedger.deleteMany).toHaveBeenCalledWith({
        where: { creditNoteId: "cn-1", entryType: "REVERSAL" },
      });
    });
  });
});
