import { Logger } from "@nestjs/common";
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

    it("RF-3: passes trackedSubcategoryId through onto the SALE row (null when absent)", async () => {
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
            trackedSubcategoryId: "sub-cig",
            qty: 3,
            netSales: 30,
            categoryTax: 0,
          },
          {
            invoiceItemId: "ii-2",
            orderItemId: null,
            trackedCategoryId: "cat-tob",
            // no trackedSubcategoryId → null on the row
            qty: 1,
            netSales: 10,
            categoryTax: 0,
          },
        ],
        db: prisma,
      });
      const data = prisma.regulatedSalesLedger.createMany.mock.calls[0][0].data;
      expect(data).toHaveLength(2);
      expect(data[0]).toMatchObject({ invoiceItemId: "ii-1", trackedSubcategoryId: "sub-cig" });
      expect(data[1]).toMatchObject({ invoiceItemId: "ii-2", trackedSubcategoryId: null });
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
    // A RETURN reversal carries a returnId (a credit-note reversal a creditNoteId) — the
    // provenance preserveReturns keys on. A void/re-sync reversal carries neither.
    const returnReversal = (over: any = {}) => reversal({ returnId: "ret-1", ...over });
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

    it("preserveReturns re-sync: cancels only the sale-record, LEAVES the return standing", async () => {
      // SALE(+10) + a RETURN reversal(−3, returnId). preserveReturns excludes the return
      // from the remaining → reverse the full sale −10 (not the net −7), so the return's
      // reduction survives into the net.
      prisma.regulatedSalesLedger.findMany.mockResolvedValue([
        sale({ qty: 10, netSales: 50 }),
        returnReversal({ qty: -3, netSales: -15 }),
      ]);
      await service.reverseInvoiceEntries({
        invoiceId: "inv-1",
        db: prisma,
        preserveReturns: true,
      });
      const data = written();
      expect(data).toHaveLength(1);
      expect(data[0]).toMatchObject({ invoiceItemId: "ii-1", qty: -10, netSales: -50 });
    });

    it("preserveReturns re-sync with no prior return reverses the full sale (unchanged)", async () => {
      prisma.regulatedSalesLedger.findMany.mockResolvedValue([sale({ qty: 10, netSales: 50 })]);
      await service.reverseInvoiceEntries({
        invoiceId: "inv-1",
        db: prisma,
        preserveReturns: true,
      });
      expect(written()[0]).toMatchObject({ qty: -10, netSales: -50 });
    });

    it("preserveReturns re-sync is idempotent — a prior re-sync reversal is counted, skips", async () => {
      // After pass 1: SALE(+10), return(−3, returnId), re-sync REVERSAL(−10, no returnId).
      // Pass 2 excludes the return but COUNTS the prior re-sync reversal → remaining 0 → skip.
      prisma.regulatedSalesLedger.findMany.mockResolvedValue([
        sale({ qty: 10, netSales: 50 }),
        returnReversal({ qty: -3, netSales: -15 }),
        reversal({ qty: -10, netSales: -50 }), // prior re-sync reversal (no returnId)
      ]);
      await service.reverseInvoiceEntries({
        invoiceId: "inv-1",
        db: prisma,
        preserveReturns: true,
      });
      expect(prisma.regulatedSalesLedger.createMany).not.toHaveBeenCalled();
    });

    it("re-sync after a partial return nets to delivered − returned (returns preserved)", async () => {
      // Full InvoicesService#resyncInvoiceLedger flow. Pre-existing: SALE(+10) + return(−3).
      // preserveReturns reverse cancels the sale (−10, return left), then re-book delivered 4.
      prisma.regulatedSalesLedger.findMany.mockResolvedValue([
        sale({ qty: 10, netSales: 50 }),
        returnReversal({ qty: -3, netSales: -15 }),
      ]);
      await service.reverseInvoiceEntries({
        invoiceId: "inv-1",
        db: prisma,
        preserveReturns: true,
      });
      const reverse = written(0);
      expect(reverse[0]).toMatchObject({ qty: -10, netSales: -50 });

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
      });
      const newSale = written(1);
      expect(newSale[0]).toMatchObject({ entryType: "SALE", qty: 4, netSales: 20 });

      // Net = original SALE(+10) + return(−3) + reverse(−10) + new SALE(+4) = +1 =
      // delivered(4) − returned(3). The return's reduction is preserved (no over-report).
      const netQty = [
        10,
        -3,
        ...reverse.map((r: any) => r.qty),
        ...newSale.map((r: any) => r.qty),
      ].reduce((a, b) => a + b, 0);
      expect(netQty).toBe(1);
    });

    it("RF-3: carries the SALE's trackedSubcategoryId onto the REVERSAL row", async () => {
      prisma.regulatedSalesLedger.findMany.mockResolvedValue([
        sale({ qty: 10, netSales: 50, categoryTax: 0, trackedSubcategoryId: "sub-cig" }),
      ]);
      await service.reverseInvoiceEntries({ invoiceId: "inv-1", db: prisma });
      expect(written()[0]).toMatchObject({
        entryType: "REVERSAL",
        trackedSubcategoryId: "sub-cig",
        qty: -10,
      });
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

    // ─── PR-1a (§5): idempotency key widened from returnId alone to (returnId, orderId) ───

    it("PR-1a: the prior-reversal check is keyed on (returnId, orderId), not returnId alone", async () => {
      arrange({ sales: [saleRow()], items: [{ id: "ii-1", productId: "p1" }] });
      await service.reverseReturnEntries({
        returnId: "ret-1",
        orderId: "ord-1",
        returnedByProduct: new Map([["p1", 3]]),
        db: prisma,
      });
      // Revert probe: dropping `orderId` from this where clause (back to `{ returnId,
      // entryType: "REVERSAL" }`) fails this exact-match assertion.
      expect(prisma.regulatedSalesLedger.findMany).toHaveBeenNthCalledWith(1, {
        where: { returnId: "ret-1", orderId: "ord-1", entryType: "REVERSAL" },
        select: { id: true },
      });
    });

    it("PR-1a fix-round (a REAL prior-reversal store, not a blind mockResolvedValueOnce queue): order B is not blocked by order A's REVERSAL, and a SECOND call for order A IS blocked", async () => {
      // The `arrange()` helper's `findMany` stub is a call-order queue that never
      // inspects `where` — it would pass this exact scenario even against the
      // UN-WIDENED key (`{returnId, entryType}` alone), so it cannot prove the fix.
      // This mock actually tracks which (returnId, orderId) pairs have a REVERSAL,
      // keyed off the real `where` clause each call site sends.
      const reversedPairs = new Set<string>();
      const writtenRows: any[] = [];

      prisma.regulatedSalesLedger.findMany.mockImplementation(async (args: any) => {
        const where = args.where ?? {};
        if (where.entryType === "REVERSAL" && "returnId" in where && "orderId" in where) {
          // The prior-reversal idempotency check this fix-round targets.
          return reversedPairs.has(`${where.returnId}:${where.orderId}`) ? [{ id: "prior-1" }] : [];
        }
        if (where.entryType === "SALE") {
          return [saleRow({ orderId: where.orderId, invoiceItemId: `ii-${where.orderId}` })];
        }
        // priorReversals (keyed by invoiceItemId) — none to fold in for this scenario.
        return [];
      });
      prisma.invoiceItem.findMany.mockImplementation(async (args: any) =>
        (args.where.id.in as string[]).map((id) => ({ id, productId: "p1" })),
      );
      prisma.regulatedSalesLedger.createMany.mockImplementation(async (args: any) => {
        writtenRows.push(...args.data);
        for (const row of args.data) reversedPairs.add(`${row.returnId}:${row.orderId}`);
        return { count: args.data.length };
      });

      // Order A: nothing reversed yet — reverses.
      await service.reverseReturnEntries({
        returnId: "ret-1",
        orderId: "ord-a",
        returnedByProduct: new Map([["p1", 3]]),
        db: prisma,
      });
      expect(reversedPairs.has("ret-1:ord-a")).toBe(true);

      // Order B, SAME returnId: (ret-1, ord-a) already has a REVERSAL, but (ret-1,
      // ord-b) does not — the widened key must not treat this as already-reversed.
      await service.reverseReturnEntries({
        returnId: "ret-1",
        orderId: "ord-b",
        returnedByProduct: new Map([["p1", 3]]),
        db: prisma,
      });
      expect(reversedPairs.has("ret-1:ord-b")).toBe(true);
      expect(writtenRows.filter((r) => r.orderId === "ord-a")).toHaveLength(1);
      expect(writtenRows.filter((r) => r.orderId === "ord-b")).toHaveLength(1);

      // A THIRD call repeating order A must now be a no-op — proves the guard is a
      // real per-pair check, not "always allow" dressed up in a wider where clause.
      writtenRows.length = 0;
      await service.reverseReturnEntries({
        returnId: "ret-1",
        orderId: "ord-a",
        returnedByProduct: new Map([["p1", 3]]),
        db: prisma,
      });
      expect(writtenRows).toHaveLength(0);
    });

    it("RF-3: carries the SALE's trackedSubcategoryId onto the return REVERSAL row", async () => {
      arrange({
        sales: [saleRow({ trackedSubcategoryId: "sub-cig" })],
        items: [{ id: "ii-1", productId: "p1" }],
      });
      await service.reverseReturnEntries({
        returnId: "ret-1",
        orderId: "ord-1",
        returnedByProduct: new Map([["p1", 3]]),
        db: prisma,
      });
      expect(written()[0]).toMatchObject({
        entryType: "REVERSAL",
        returnId: "ret-1",
        trackedSubcategoryId: "sub-cig",
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

    // A delivered-basis reconcile DELETES the open draft's InvoiceItems and re-books
    // the SALE under fresh ids (ii-1 → ii-2) on the SAME order line (oi-1). The
    // cumulative-reversal cap keys on orderItemId, so it survives the rotation.
    it("caps a 2nd full return after a reconcile — SUM floors at 0, not negative", async () => {
      // Ledger: SALE ii-1(+10) → return ret-1(-10) → resync(-10) → SALE ii-2(+10) = net 0.
      // A 2nd full return must reverse NOTHING (order line already fully returned).
      arrange({
        sales: [
          saleRow({
            invoiceItemId: "ii-1",
            orderItemId: "oi-1",
            qty: 10,
            netSales: 100,
            categoryTax: 0,
          }),
          saleRow({
            invoiceItemId: "ii-2",
            orderItemId: "oi-1",
            qty: 10,
            netSales: 100,
            categoryTax: 0,
          }),
        ],
        priorReversals: [
          { invoiceItemId: "ii-1", orderItemId: "oi-1", qty: -10, netSales: -100, categoryTax: 0 },
          { invoiceItemId: "ii-1", orderItemId: "oi-1", qty: -10, netSales: -100, categoryTax: 0 },
        ],
        items: [{ id: "ii-2", productId: "p1" }], // ii-1 was deleted by the reconcile
      });
      await service.reverseReturnEntries({
        returnId: "ret-2",
        orderId: "ord-1",
        returnedByProduct: new Map([["p1", 10]]),
        db: prisma,
      });
      expect(prisma.regulatedSalesLedger.createMany).not.toHaveBeenCalled();
    });

    it("still books a VALID partial return after a reconcile (cap survives item recreation)", async () => {
      // SALE ii-1(+10) → return ret-1 of 3(-3) → resync(-10) → SALE ii-2(+10): net 7 / $70.
      // A 2nd return of 2 (total 5 ≤ 10) is valid and books -2 / -20 against the live row.
      arrange({
        sales: [
          saleRow({
            invoiceItemId: "ii-1",
            orderItemId: "oi-1",
            qty: 10,
            netSales: 100,
            categoryTax: 0,
          }),
          saleRow({
            invoiceItemId: "ii-2",
            orderItemId: "oi-1",
            qty: 10,
            netSales: 100,
            categoryTax: 0,
          }),
        ],
        priorReversals: [
          { invoiceItemId: "ii-1", orderItemId: "oi-1", qty: -3, netSales: -30, categoryTax: 0 },
          { invoiceItemId: "ii-1", orderItemId: "oi-1", qty: -10, netSales: -100, categoryTax: 0 },
        ],
        items: [{ id: "ii-2", productId: "p1" }],
      });
      await service.reverseReturnEntries({
        returnId: "ret-2",
        orderId: "ord-1",
        returnedByProduct: new Map([["p1", 2]]),
        db: prisma,
      });
      expect(written()).toHaveLength(1);
      expect(written()[0]).toMatchObject({ qty: -2, netSales: -20 });
    });

    it("floors a 2nd over-return after a reconcile at the line's remaining (never negative)", async () => {
      // After a partial return of 3 + reconcile, 7 remain. A 2nd return of 10 books only
      // -7 / -70 (closing the line to exactly 0), not -10.
      arrange({
        sales: [
          saleRow({
            invoiceItemId: "ii-1",
            orderItemId: "oi-1",
            qty: 10,
            netSales: 100,
            categoryTax: 0,
          }),
          saleRow({
            invoiceItemId: "ii-2",
            orderItemId: "oi-1",
            qty: 10,
            netSales: 100,
            categoryTax: 0,
          }),
        ],
        priorReversals: [
          { invoiceItemId: "ii-1", orderItemId: "oi-1", qty: -3, netSales: -30, categoryTax: 0 },
          { invoiceItemId: "ii-1", orderItemId: "oi-1", qty: -10, netSales: -100, categoryTax: 0 },
        ],
        items: [{ id: "ii-2", productId: "p1" }],
      });
      await service.reverseReturnEntries({
        returnId: "ret-2",
        orderId: "ord-1",
        returnedByProduct: new Map([["p1", 10]]),
        db: prisma,
      });
      expect(written()).toHaveLength(1);
      expect(written()[0]).toMatchObject({ qty: -7, netSales: -70 });
    });

    it("clamps a fractional partial after a RE-PRICED reconcile so net can't over-reverse", async () => {
      // Reconcile re-priced the line DOWN: dead ii-1 was $12/u, live ii-2 is $10/u, and a
      // pre-reconcile return of 2 (-$24) is preserved. Line remaining = 8 qty / $76. A
      // fractional return of 7.7 pro-rates off the live row's $10/u = $77 > $76 remaining —
      // it must CLAMP to -$76 (net floors at 0), not book -$77 (SUM would go negative).
      arrange({
        sales: [
          saleRow({
            invoiceItemId: "ii-1",
            orderItemId: "oi-1",
            qty: 10,
            netSales: 120,
            categoryTax: 0,
          }),
          saleRow({
            invoiceItemId: "ii-2",
            orderItemId: "oi-1",
            qty: 10,
            netSales: 100,
            categoryTax: 0,
          }),
        ],
        priorReversals: [
          { invoiceItemId: "ii-1", orderItemId: "oi-1", qty: -2, netSales: -24, categoryTax: 0 },
          { invoiceItemId: "ii-1", orderItemId: "oi-1", qty: -10, netSales: -120, categoryTax: 0 },
        ],
        items: [{ id: "ii-2", productId: "p1" }],
      });
      await service.reverseReturnEntries({
        returnId: "ret-2",
        orderId: "ord-1",
        returnedByProduct: new Map([["p1", 7.7]]),
        db: prisma,
      });
      expect(written()[0]).toMatchObject({ qty: -7.7, netSales: -76 });
    });

    it("a non-closing partial return can NEVER drive the line net below 0 (reprice-to-zero)", async () => {
      // Canonical counterexample: SALE ii-1(+10/$100) → return 5(-$50) → reprice to $5/u
      // → resync(-$100) → SALE ii-2(+10/$50). Line net is already $0 (delivered $50 −
      // returned $50) with 5 qty remaining. A 2nd non-closing return of 4 pro-rates off
      // the live $5/u row = -$20 — it MUST clamp to $0 so the category SUM stays 0.
      arrange({
        sales: [
          saleRow({
            invoiceItemId: "ii-1",
            orderItemId: "oi-1",
            qty: 10,
            netSales: 100,
            categoryTax: 0,
          }),
          saleRow({
            invoiceItemId: "ii-2",
            orderItemId: "oi-1",
            qty: 10,
            netSales: 50,
            categoryTax: 0,
          }),
        ],
        priorReversals: [
          { invoiceItemId: "ii-1", orderItemId: "oi-1", qty: -5, netSales: -50, categoryTax: 0 },
          { invoiceItemId: "ii-1", orderItemId: "oi-1", qty: -10, netSales: -100, categoryTax: 0 },
        ],
        items: [{ id: "ii-2", productId: "p1" }],
      });
      await service.reverseReturnEntries({
        returnId: "ret-2",
        orderId: "ord-1",
        returnedByProduct: new Map([["p1", 4]]),
        db: prisma,
      });
      const row = written()[0];
      expect(row.qty).toBe(-4);
      expect(row.netSales).toBeGreaterThanOrEqual(0); // clamped: never a negative-SUM over-reversal
    });

    it("clamps the categoryTax dimension too after a RE-PRICED reconcile", async () => {
      // Same reprice-down shape but with a NON-ZERO tax rate, guarding the taxRem clamp
      // (every other test carries categoryTax 0). Dead ii-1 $12/u + $2.40/u tax, live ii-2
      // $10/u + $2/u tax, pre-reconcile return of 2 preserved. Line remaining = 8 qty /
      // $76 net / $15.20 tax. A 7.7 return pro-rates tax off the live $2/u = $15.40 > the
      // $15.20 remaining — it must CLAMP to -$15.20, not book -$15.40 (tax SUM would go < 0).
      arrange({
        sales: [
          saleRow({
            invoiceItemId: "ii-1",
            orderItemId: "oi-1",
            qty: 10,
            netSales: 120,
            categoryTax: 24,
          }),
          saleRow({
            invoiceItemId: "ii-2",
            orderItemId: "oi-1",
            qty: 10,
            netSales: 100,
            categoryTax: 20,
          }),
        ],
        priorReversals: [
          { invoiceItemId: "ii-1", orderItemId: "oi-1", qty: -2, netSales: -24, categoryTax: -4.8 },
          {
            invoiceItemId: "ii-1",
            orderItemId: "oi-1",
            qty: -10,
            netSales: -120,
            categoryTax: -24,
          },
        ],
        items: [{ id: "ii-2", productId: "p1" }],
      });
      await service.reverseReturnEntries({
        returnId: "ret-2",
        orderId: "ord-1",
        returnedByProduct: new Map([["p1", 7.7]]),
        db: prisma,
      });
      expect(written()[0]).toMatchObject({ qty: -7.7, netSales: -76, categoryTax: -15.2 });
    });

    // ─── B660: the returned qty and the SALE qty must be compared in the SAME unit ───
    //
    // A box-unaware boxed line (standing-order / buyer bare-qty line of a 12-per-box product) is
    // stored `boxes: null, unitsPerBox: null` with qty = BOXES: 6 boxes = 72 pieces, $240 net, $60 levy.
    // Its pack comes ONLY from legacyLinePieces (own split, or a same-product source line with a split),
    // NEVER from the live product (Senior Architect ruling 2026-09-21).
    describe("B660: returned unit vs line unit", () => {
      const boxSale = () =>
        saleRow({
          id: "sale-1",
          orderItemId: "oi-1",
          qty: 6,
          unitBasisQty: 6,
          netSales: 240,
          categoryTax: 60,
        });
      const boxLine = (over: Record<string, unknown> = {}) => ({
        id: "oi-1",
        productId: "p1",
        qty: 6,
        boxes: null,
        pieces: null,
        unitsPerBox: null,
        product: { unitsPerBox: 12 }, // the live pack: only a TRIGGER, never a factor
        ...over,
      });
      /** A same-product line WITH a split: the source line that lets the classifier read the pack. */
      const sourceWithSplit = () => ({
        productId: "p1",
        qty: 72,
        boxes: 6,
        pieces: 0,
        unitsPerBox: 12,
      });
      /** Call 1 = the sale rows' order lines; call 2 (only for ambiguous lines) = same-product source lines. */
      const armLines = (lines: unknown[], sources: unknown[] = []) => {
        prisma.orderItem.findMany.mockReset();
        prisma.orderItem.findMany.mockResolvedValueOnce(lines).mockResolvedValueOnce(sources);
      };
      const reverse = (qty: number, returnedUnit?: "LINE_UNIT" | "PIECES", returnId = "ret-1") =>
        service.reverseReturnEntries({
          returnId,
          orderId: "ord-1",
          returnedByProduct: new Map([["p1", qty]]),
          ...(returnedUnit ? { returnedUnit } : {}),
          db: prisma,
        });
      const arrangeBox = (extra: Record<string, unknown> = {}) =>
        arrange({ sales: [boxSale()], items: [{ id: "ii-1", productId: "p1" }], ...extra });

      it("INLINE (PIECES): 12 pieces of a 6-box line reverse 1/6, not the whole row", async () => {
        arrangeBox();
        armLines([boxLine()], [sourceWithSplit()]);
        await reverse(12, "PIECES");
        expect(written()).toHaveLength(1);
        expect(written()[0]).toMatchObject({
          qty: -1,
          unitBasisQty: -1,
          netSales: -40, // 12 / 72 of $240, not 100%
          categoryTax: -10,
        });
      });

      it("INLINE (PIECES): a 3-piece return reverses 3/72 (about 4.2%), not 50%", async () => {
        arrangeBox();
        armLines([boxLine()], [sourceWithSplit()]);
        await reverse(3, "PIECES");
        expect(written()[0]).toMatchObject({ qty: -0.25, netSales: -10, categoryTax: -2.5 });
      });

      it("INLINE (PIECES): returning ALL 72 pieces closes the line exactly", async () => {
        arrangeBox();
        armLines([boxLine()], [sourceWithSplit()]);
        await reverse(72, "PIECES");
        expect(written()[0]).toMatchObject({ qty: -6, netSales: -240, categoryTax: -60 });
      });

      it("INLINE (PIECES): a second partial return is capped by what the first left", async () => {
        const prior = [
          { invoiceItemId: "ii-1", orderItemId: "oi-1", qty: -1, netSales: -40, categoryTax: -10 },
        ];
        arrangeBox({ priorReversals: prior });
        armLines([boxLine()], [sourceWithSplit()]);
        await reverse(12, "PIECES", "ret-2");
        expect(written()[0]).toMatchObject({ qty: -1, netSales: -40, categoryTax: -10 });
        // and it can never reverse more than the 5 boxes (60 pieces) still on the line
        prisma.regulatedSalesLedger.createMany.mockClear();
        arrangeBox({ priorReversals: prior });
        armLines([boxLine()], [sourceWithSplit()]);
        await reverse(500, "PIECES", "ret-3");
        expect(written()[0]).toMatchObject({ qty: -5, netSales: -200, categoryTax: -50 });
      });

      it("STANDARD (LINE_UNIT): 1 typed BOX reverses the same 1/6 (unit-consistent, unchanged)", async () => {
        arrangeBox();
        await reverse(1, "LINE_UNIT");
        expect(written()[0]).toMatchObject({ qty: -1, netSales: -40, categoryTax: -10 });
        expect(prisma.orderItem.findMany).not.toHaveBeenCalled(); // no extra query on this path
      });

      it("BOTH return paths book the identical reversal for the same physical return (1 box = 12 pieces)", async () => {
        arrangeBox();
        await reverse(1, "LINE_UNIT", "ret-std");
        const standard = written()[0];
        prisma.regulatedSalesLedger.createMany.mockClear();
        arrangeBox();
        armLines([boxLine()], [sourceWithSplit()]);
        await reverse(12, "PIECES", "ret-inl");
        const inline = written()[0];
        const money = ({ qty, unitBasisQty, netSales, categoryTax }: any) => ({
          qty,
          unitBasisQty,
          netSales,
          categoryTax,
        });
        expect(money(inline)).toEqual(money(standard));
      });

      it("the default unit is LINE_UNIT and never queries order lines (existing behaviour)", async () => {
        arrangeBox();
        await reverse(6);
        expect(written()[0]).toMatchObject({ qty: -6, netSales: -240, categoryTax: -60 });
        expect(prisma.orderItem.findMany).not.toHaveBeenCalled();
      });

      it("declaring the WRONG unit reproduces B660 (12 pieces read as 12 boxes closes the row)", async () => {
        arrangeBox();
        await reverse(12, "LINE_UNIT"); // what the inline path did before the unit was declared
        expect(written()[0]).toMatchObject({ qty: -6, netSales: -240, categoryTax: -60 });
      });

      it("PIECES on a box-AWARE line or a product with no pack uses factor 1 (no source query)", async () => {
        const pieceSale = () =>
          saleRow({
            orderItemId: "oi-1",
            qty: 72,
            unitBasisQty: 72,
            netSales: 360,
            categoryTax: 72,
          });
        arrange({ sales: [pieceSale()], items: [{ id: "ii-1", productId: "p1" }] });
        armLines([boxLine({ qty: 72, boxes: 6, unitsPerBox: 12 })]);
        await reverse(12, "PIECES");
        expect(written()[0]).toMatchObject({ qty: -12, netSales: -60, categoryTax: -12 });
        expect(prisma.orderItem.findMany).toHaveBeenCalledTimes(1);
        prisma.regulatedSalesLedger.createMany.mockClear();
        arrange({ sales: [pieceSale()], items: [{ id: "ii-1", productId: "p1" }] });
        armLines([boxLine({ qty: 72, product: { unitsPerBox: null } })]);
        await reverse(12, "PIECES", "ret-2");
        expect(written()[0]).toMatchObject({ qty: -12, netSales: -60, categoryTax: -12 });
      });

      it("PIECES across a box-unaware line AND a box-aware line of one product converts per row", async () => {
        arrange({
          sales: [
            boxSale(),
            saleRow({
              invoiceItemId: "ii-2",
              orderItemId: "oi-2",
              qty: 72,
              unitBasisQty: 72,
              netSales: 360,
              categoryTax: 72,
            }),
          ],
          items: [
            { id: "ii-1", productId: "p1" },
            { id: "ii-2", productId: "p1" },
          ],
        });
        armLines(
          [boxLine(), boxLine({ id: "oi-2", qty: 72, boxes: 6, unitsPerBox: 12 })],
          [sourceWithSplit()],
        );
        await reverse(84, "PIECES"); // 72 pieces close the box line, 12 more come off the piece line
        expect(written()).toHaveLength(2);
        expect(written()[0]).toMatchObject({
          orderItemId: "oi-1",
          qty: -6,
          netSales: -240,
          categoryTax: -60,
        });
        expect(written()[1]).toMatchObject({
          orderItemId: "oi-2",
          qty: -12,
          netSales: -60,
          categoryTax: -12,
        });
      });

      it("PIECES on a freeform line (no orderItemId) queries nothing and uses factor 1", async () => {
        arrange({ sales: [saleRow()], items: [{ id: "ii-1", productId: "p1" }] });
        await reverse(3, "PIECES");
        expect(prisma.orderItem.findMany).not.toHaveBeenCalled();
        expect(written()[0]).toMatchObject({ qty: -3, netSales: -30, categoryTax: -6 });
      });

      it("a no-split line WITH a pack snapshot (the B644/B656 shape) reaches the classifier: qty 72 counts pieces, so factor 1, never x12", async () => {
        const pieceSale = () =>
          saleRow({
            id: "sale-1",
            orderItemId: "oi-1",
            qty: 72,
            unitBasisQty: 72,
            netSales: 360,
            categoryTax: 72,
          });
        arrange({ sales: [pieceSale()], items: [{ id: "ii-1", productId: "p1" }] });
        armLines([boxLine({ qty: 72, unitsPerBox: 12 })], [sourceWithSplit()]);
        await reverse(12, "PIECES");
        // qty === source.qty -> "source-pieces": 12 of 72 pieces is 1/6, NOT 12 x 12 pieces
        expect(written()[0]).toMatchObject({ qty: -12, netSales: -60, categoryTax: -12 });
        expect(prisma.orderItem.findMany).toHaveBeenCalledTimes(2); // it DID go looking for a source
      });

      it("the linked InvoiceItem is the preferred source: a sibling is not even queried", async () => {
        arrangeBox();
        prisma.invoiceItem.findMany.mockReset();
        prisma.invoiceItem.findMany
          .mockResolvedValueOnce([{ id: "ii-1", productId: "p1" }]) // the productId bridge
          .mockResolvedValueOnce([{ id: "ii-1", qty: 72, boxes: 6, pieces: 0, unitsPerBox: 12 }]);
        armLines([boxLine()], [{ ...sourceWithSplit(), qty: 100, boxes: 8 }]); // a sibling that would say unknown
        await reverse(12, "PIECES");
        expect(written()[0]).toMatchObject({ qty: -1, netSales: -40, categoryTax: -10 });
        expect(prisma.orderItem.findMany).toHaveBeenCalledTimes(1); // no sibling query
      });

      it("an InvoiceItem WITHOUT a split falls back to a same-product sibling with a split", async () => {
        arrangeBox();
        prisma.invoiceItem.findMany.mockReset();
        prisma.invoiceItem.findMany
          .mockResolvedValueOnce([{ id: "ii-1", productId: "p1" }])
          .mockResolvedValueOnce([
            { id: "ii-1", qty: 6, boxes: null, pieces: null, unitsPerBox: null },
          ]);
        armLines([boxLine()], [sourceWithSplit()]);
        await reverse(12, "PIECES");
        expect(written()[0]).toMatchObject({ qty: -1, netSales: -40, categoryTax: -10 });
        expect(prisma.orderItem.findMany).toHaveBeenCalledTimes(2);
      });

      describe("unknown pack: parked, never a guess (Senior Architect ruling 2026-09-21)", () => {
        let errorSpy: jest.SpyInstance;
        const parkedMock = () => (prisma as any).regulatedLedgerParkedReversal.createMany;
        beforeEach(() => {
          errorSpy = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
          parkedMock().mockClear();
        });
        afterEach(() => errorSpy.mockRestore());

        it("a box-unaware line with NO own split and NO source line books NOTHING and PARKS the true pieces, even though the live product says 12", async () => {
          arrangeBox();
          armLines([boxLine({ product: { unitsPerBox: 12 } })], []); // live pack 12, no source with a split
          await reverse(12, "PIECES");
          expect(prisma.regulatedSalesLedger.createMany).not.toHaveBeenCalled();
          expect(parkedMock()).toHaveBeenCalledTimes(1);
          expect(parkedMock()).toHaveBeenCalledWith({
            data: [
              {
                tenantId: "t1",
                returnId: "ret-1",
                orderId: "ord-1",
                orderItemId: "oi-1",
                saleEntryId: "sale-1", // the SALE row it will reverse
                returnedPieces: 12, // the TRUE captured pieces, exactly
                reason: expect.stringMatching(/no own split/),
                periodBucket: expect.stringMatching(/^\d{4}-\d{2}$/),
              },
            ],
            skipDuplicates: true, // a retried capture parks it once (UNIQUE returnId + saleEntryId)
          });
          expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/ret-1[\s\S]*unknown pack/));
        });

        it("a source line WITHOUT a split does not count as a source: it parks", async () => {
          arrangeBox();
          armLines(
            [boxLine()],
            [{ productId: "p1", qty: 72, boxes: null, pieces: null, unitsPerBox: 12 }],
          );
          await reverse(12, "PIECES");
          expect(prisma.regulatedSalesLedger.createMany).not.toHaveBeenCalled();
          expect(parkedMock()).toHaveBeenCalledTimes(1);
        });

        it("the returned pieces are not spilled onto the next row: ALL 84 are parked against the unknown row", async () => {
          arrange({
            sales: [
              boxSale(),
              saleRow({
                id: "sale-2",
                invoiceItemId: "ii-2",
                orderItemId: "oi-2",
                qty: 72,
                unitBasisQty: 72,
                netSales: 360,
                categoryTax: 72,
              }),
            ],
            items: [
              { id: "ii-1", productId: "p1" },
              { id: "ii-2", productId: "p1" },
            ],
          });
          armLines([boxLine(), boxLine({ id: "oi-2", qty: 72, boxes: 6, unitsPerBox: 12 })], []);
          await reverse(84, "PIECES");
          expect(prisma.regulatedSalesLedger.createMany).not.toHaveBeenCalled();
          expect(parkedMock()).toHaveBeenCalledTimes(1);
          expect(parkedMock().mock.calls[0][0].data[0]).toMatchObject({
            saleEntryId: "sale-1",
            returnedPieces: 84,
          });
        });

        it("only the unknown product parks: a KNOWN product in the same return still books", async () => {
          arrange({
            sales: [
              boxSale(),
              saleRow({
                id: "sale-3",
                invoiceItemId: "ii-3",
                orderItemId: "oi-3",
                qty: 3,
                unitBasisQty: 3,
                netSales: 30,
                categoryTax: 6,
              }),
            ],
            items: [
              { id: "ii-1", productId: "p1" },
              { id: "ii-3", productId: "p2" },
            ],
          });
          armLines([
            boxLine(),
            boxLine({ id: "oi-3", productId: "p2", qty: 3, boxes: 1, unitsPerBox: 12 }),
          ]);
          await service.reverseReturnEntries({
            returnId: "ret-1",
            orderId: "ord-1",
            returnedByProduct: new Map([
              ["p1", 12],
              ["p2", 3],
            ]),
            returnedUnit: "PIECES",
            db: prisma,
          });
          expect(parkedMock().mock.calls[0][0].data[0]).toMatchObject({
            saleEntryId: "sale-1",
            returnedPieces: 12,
          });
          expect(written()).toHaveLength(1);
          expect(written()[0]).toMatchObject({ orderItemId: "oi-3", qty: -3, netSales: -30 });
        });

        it("a line whose qty matches neither the source's boxes nor its qty is unknown: it parks", async () => {
          arrangeBox();
          armLines([boxLine({ qty: 10 })], [{ ...sourceWithSplit(), qty: 100, boxes: 8 }]);
          await reverse(12, "PIECES");
          expect(prisma.regulatedSalesLedger.createMany).not.toHaveBeenCalled();
          expect(parkedMock()).toHaveBeenCalledTimes(1);
        });

        it("nothing is parked when the pack is known, or on the LINE_UNIT path", async () => {
          arrangeBox();
          armLines([boxLine()], [sourceWithSplit()]);
          await reverse(12, "PIECES");
          arrangeBox();
          await reverse(1, "LINE_UNIT", "ret-2");
          expect(parkedMock()).not.toHaveBeenCalled();
        });
      });
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
        ]) // live SALE rows (meta + existence)
        .mockResolvedValueOnce([
          {
            entryType: "SALE",
            invoiceItemId: "ii-1",
            orderItemId: "oi-1",
            netSales: 30,
            qty: 3,
            categoryTax: 6,
          },
        ]); // all order-line rows (SALE + REVERSAL) for the cap
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

    it("RF-3: carries the live SALE's trackedSubcategoryId onto the credit-note REVERSAL", async () => {
      prisma.regulatedSalesLedger.findMany
        .mockResolvedValueOnce([]) // idempotency
        .mockResolvedValueOnce([
          {
            invoiceItemId: "ii-1",
            netSales: 30,
            qty: 3,
            categoryTax: 0,
            orderId: "ord-1",
            orderItemId: "oi-1",
            invoiceId: "inv-1",
            trackedSubcategoryId: "sub-cig", // reporting breakdown on the live SALE
          },
        ])
        .mockResolvedValueOnce([
          {
            entryType: "SALE",
            invoiceItemId: "ii-1",
            orderItemId: "oi-1",
            netSales: 30,
            qty: 3,
            categoryTax: 0,
          },
        ]);
      prisma.creditNoteItem.findMany.mockResolvedValue([
        {
          tenantId: "t1",
          trackedCategoryId: "cat-A",
          invoiceItemId: "ii-1",
          amount: 15,
          qty: 1.5,
          categoryTax: 0,
        },
      ]);
      await service.reverseCreditNoteEntries({ creditNoteId: "cn-1", db: prisma });
      expect(prisma.regulatedSalesLedger.createMany.mock.calls[0][0].data[0]).toMatchObject({
        entryType: "REVERSAL",
        creditNoteId: "cn-1",
        trackedSubcategoryId: "sub-cig", // copied from the SALE row, not the credit item
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
        .mockResolvedValueOnce([{ invoiceItemId: "ii-1", netSales: 30, orderItemId: "oi-1" }]) // live SALE
        .mockResolvedValueOnce([
          {
            entryType: "SALE",
            invoiceItemId: "ii-1",
            orderItemId: "oi-1",
            netSales: 30,
            qty: 3,
            categoryTax: 0,
          },
          {
            entryType: "REVERSAL",
            invoiceItemId: "ii-1",
            orderItemId: "oi-1",
            netSales: -30,
            qty: -3,
            categoryTax: 0,
          },
        ]); // all order-line rows: SALE fully reversed by a prior return
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
        .mockResolvedValueOnce([{ invoiceItemId: "ii-1", netSales: 100, orderItemId: "oi-1" }]) // live SALE
        .mockResolvedValueOnce([
          {
            entryType: "SALE",
            invoiceItemId: "ii-1",
            orderItemId: "oi-1",
            netSales: 100,
            qty: 10,
            categoryTax: 0,
          },
        ]); // all order-line rows: SALE, no prior reversals
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
        .mockResolvedValueOnce([{ invoiceItemId: "ii-1", netSales: 90, orderItemId: "oi-1" }]) // live SALE
        .mockResolvedValueOnce([
          {
            entryType: "SALE",
            invoiceItemId: "ii-1",
            orderItemId: "oi-1",
            netSales: 90,
            qty: 3,
            categoryTax: 0,
          },
          {
            entryType: "REVERSAL",
            invoiceItemId: "ii-1",
            orderItemId: "oi-1",
            netSales: -30.01,
            qty: -1,
            categoryTax: 0,
          },
          {
            entryType: "REVERSAL",
            invoiceItemId: "ii-1",
            orderItemId: "oi-1",
            netSales: -30.0,
            qty: -1,
            categoryTax: 0,
          },
        ]); // all order-line rows: SALE + two prior partial credits
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

    // A delivered-basis reconcile re-books the credited line's SALE under a fresh
    // invoiceItemId (ii-1 → ii-2) on the same order line (oi-1). The cap keys on
    // orderItemId so a 2nd credit after the reconcile can't re-consume the SALE.
    it("caps a 2nd full credit after a reconcile — SUM floors at 0, not negative", async () => {
      // Ledger: SALE ii-1(+100) → credit cn-1(-100) → resync(-100) → SALE ii-2(+100) = net 0.
      // cn-2 credits the LIVE line (ii-2) in full; it must reverse NOTHING.
      prisma.regulatedSalesLedger.findMany
        .mockResolvedValueOnce([]) // idempotency: none for cn-2
        .mockResolvedValueOnce([
          {
            invoiceItemId: "ii-2",
            netSales: 100,
            orderId: "ord-1",
            orderItemId: "oi-1",
            invoiceId: "inv-1",
          },
        ]) // live SALE
        .mockResolvedValueOnce([
          {
            entryType: "SALE",
            invoiceItemId: "ii-1",
            orderItemId: "oi-1",
            netSales: 100,
            qty: 10,
            categoryTax: 0,
          },
          {
            entryType: "REVERSAL",
            invoiceItemId: "ii-1",
            orderItemId: "oi-1",
            netSales: -100,
            qty: -10,
            categoryTax: 0,
          },
          {
            entryType: "REVERSAL",
            invoiceItemId: "ii-1",
            orderItemId: "oi-1",
            netSales: -100,
            qty: -10,
            categoryTax: 0,
          },
          {
            entryType: "SALE",
            invoiceItemId: "ii-2",
            orderItemId: "oi-1",
            netSales: 100,
            qty: 10,
            categoryTax: 0,
          },
        ]); // all order-line rows
      prisma.creditNoteItem.findMany.mockResolvedValue([
        {
          tenantId: "t1",
          trackedCategoryId: "cat-A",
          invoiceItemId: "ii-2",
          amount: 100,
          qty: 10,
          categoryTax: 0,
        },
      ]);
      await service.reverseCreditNoteEntries({ creditNoteId: "cn-2", db: prisma });
      expect(prisma.regulatedSalesLedger.createMany).not.toHaveBeenCalled();
    });

    it("still books a VALID partial credit after a reconcile (cap survives item recreation)", async () => {
      // SALE ii-1(+100) → credit cn-1 of 3(-30) → resync(-100) → SALE ii-2(+100): net 7 / $70.
      // cn-2 credits 4 units / $40 (total 70 ≤ 100) — valid, books -40 / -4 on the live line.
      prisma.regulatedSalesLedger.findMany
        .mockResolvedValueOnce([]) // idempotency
        .mockResolvedValueOnce([
          {
            invoiceItemId: "ii-2",
            netSales: 100,
            orderId: "ord-1",
            orderItemId: "oi-1",
            invoiceId: "inv-1",
          },
        ]) // live SALE
        .mockResolvedValueOnce([
          {
            entryType: "SALE",
            invoiceItemId: "ii-1",
            orderItemId: "oi-1",
            netSales: 100,
            qty: 10,
            categoryTax: 0,
          },
          {
            entryType: "REVERSAL",
            invoiceItemId: "ii-1",
            orderItemId: "oi-1",
            netSales: -30,
            qty: -3,
            categoryTax: 0,
          },
          {
            entryType: "REVERSAL",
            invoiceItemId: "ii-1",
            orderItemId: "oi-1",
            netSales: -100,
            qty: -10,
            categoryTax: 0,
          },
          {
            entryType: "SALE",
            invoiceItemId: "ii-2",
            orderItemId: "oi-1",
            netSales: 100,
            qty: 10,
            categoryTax: 0,
          },
        ]);
      prisma.creditNoteItem.findMany.mockResolvedValue([
        {
          tenantId: "t1",
          trackedCategoryId: "cat-A",
          invoiceItemId: "ii-2",
          amount: 40,
          qty: 4,
          categoryTax: 0,
        },
      ]);
      await service.reverseCreditNoteEntries({ creditNoteId: "cn-2", db: prisma });
      const row = prisma.regulatedSalesLedger.createMany.mock.calls[0][0].data[0];
      expect(row).toMatchObject({ netSales: -40, qty: -4 });
    });

    it("floors a 2nd over-credit after a reconcile at the line's remaining (never negative)", async () => {
      // After a partial credit of $30 + reconcile, $70 remains. A 2nd credit of $100 books
      // only -70 / -7 (closing the line to exactly 0), not -100.
      prisma.regulatedSalesLedger.findMany
        .mockResolvedValueOnce([]) // idempotency
        .mockResolvedValueOnce([
          {
            invoiceItemId: "ii-2",
            netSales: 100,
            orderId: "ord-1",
            orderItemId: "oi-1",
            invoiceId: "inv-1",
          },
        ]) // live SALE
        .mockResolvedValueOnce([
          {
            entryType: "SALE",
            invoiceItemId: "ii-1",
            orderItemId: "oi-1",
            netSales: 100,
            qty: 10,
            categoryTax: 0,
          },
          {
            entryType: "REVERSAL",
            invoiceItemId: "ii-1",
            orderItemId: "oi-1",
            netSales: -30,
            qty: -3,
            categoryTax: 0,
          },
          {
            entryType: "REVERSAL",
            invoiceItemId: "ii-1",
            orderItemId: "oi-1",
            netSales: -100,
            qty: -10,
            categoryTax: 0,
          },
          {
            entryType: "SALE",
            invoiceItemId: "ii-2",
            orderItemId: "oi-1",
            netSales: 100,
            qty: 10,
            categoryTax: 0,
          },
        ]);
      prisma.creditNoteItem.findMany.mockResolvedValue([
        {
          tenantId: "t1",
          trackedCategoryId: "cat-A",
          invoiceItemId: "ii-2",
          amount: 100,
          qty: 10,
          categoryTax: 0,
        },
      ]);
      await service.reverseCreditNoteEntries({ creditNoteId: "cn-2", db: prisma });
      const row = prisma.regulatedSalesLedger.createMany.mock.calls[0][0].data[0];
      expect(row).toMatchObject({ netSales: -70, qty: -7 });
    });

    it("unreverseCreditNoteEntries deletes the credit note's REVERSAL rows", async () => {
      await service.unreverseCreditNoteEntries({ creditNoteId: "cn-1", db: prisma });
      expect(prisma.regulatedSalesLedger.deleteMany).toHaveBeenCalledWith({
        where: { creditNoteId: "cn-1", entryType: "REVERSAL" },
      });
    });
  });
});
