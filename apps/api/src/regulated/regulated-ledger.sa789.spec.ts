import { Test } from "@nestjs/testing";
import { RegulatedLedgerService } from "./regulated-ledger.service";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";

/**
 * SA-789 F1 (row 558): a regulated SALE row whose invoice item was re-created (fresh id) by a legacy
 * rebuild must still be reversed by a return or a credit note, resolving the line through its stable
 * order line. The ledger itself is never edited.
 */
describe("RegulatedLedgerService: rotated invoice item (SA-789 F1)", () => {
  let service: RegulatedLedgerService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const mod = await Test.createTestingModule({
      providers: [RegulatedLedgerService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = mod.get(RegulatedLedgerService);
  });

  // The SALE row still carries the OLD invoice item id ("ii-old", deleted by the rebuild).
  const staleSale = (over: Record<string, unknown> = {}) => ({
    id: "sale-1",
    entryType: "SALE",
    tenantId: "t1",
    trackedCategoryId: "cat-A",
    orderId: "ord-1",
    orderItemId: "oi-1",
    invoiceId: "inv-1",
    invoiceItemId: "ii-old",
    qty: 75,
    unitBasisQty: 75,
    netSales: 87.5,
    categoryTax: 0,
    createdAt: new Date("2026-10-05T22:44:00Z"),
    ...over,
  });
  const orderItem = (over: Record<string, unknown> = {}) => ({
    id: "oi-1",
    productId: "p1",
    qty: 75,
    boxes: null,
    pieces: null,
    unitLabel: null,
    unitsPerBox: null,
    ...over,
  });

  describe("return", () => {
    it("books a REVERSAL for a return of 10 units through the order line", async () => {
      prisma.regulatedSalesLedger.findMany
        .mockResolvedValueOnce([]) // idempotency
        .mockResolvedValueOnce([staleSale()]) // the order's SALE rows
        .mockResolvedValueOnce([]); // prior reversals
      prisma.invoiceItem.findMany.mockResolvedValue([]); // the old id no longer exists
      prisma.orderItem.findMany.mockResolvedValue([orderItem()]);
      prisma.product.findMany.mockResolvedValue([{ id: "p1", unitsPerBox: 1 }]);

      await service.reverseReturnEntries({
        returnId: "ret-1",
        orderId: "ord-1",
        returnedByProduct: new Map([["p1", 10]]),
        returnedUnit: "PIECES",
        db: prisma,
      });

      expect(prisma.regulatedSalesLedger.createMany).toHaveBeenCalledTimes(1);
      const [row] = prisma.regulatedSalesLedger.createMany.mock.calls[0][0].data;
      expect(row).toMatchObject({
        entryType: "REVERSAL",
        returnId: "ret-1",
        orderItemId: "oi-1",
        qty: -10,
        unitBasisQty: -10,
        netSales: -11.67,
      });
    });

    it("counts a prior credit-note reversal booked under the NEW item id against the line cap", async () => {
      // SALE 75 under the old id; a credit note already reversed 70 (stamped with the new id and the
      // order line). A return of 10 may only take the 5 left.
      prisma.regulatedSalesLedger.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([staleSale()])
        .mockResolvedValueOnce([
          {
            invoiceItemId: "ii-new",
            orderItemId: "oi-1",
            qty: -70,
            unitBasisQty: -70,
            netSales: -81.67,
            categoryTax: 0,
          },
        ]);
      prisma.invoiceItem.findMany.mockResolvedValue([]);
      prisma.orderItem.findMany.mockResolvedValue([orderItem()]);
      prisma.product.findMany.mockResolvedValue([{ id: "p1", unitsPerBox: 1 }]);

      await service.reverseReturnEntries({
        returnId: "ret-2",
        orderId: "ord-1",
        returnedByProduct: new Map([["p1", 10]]),
        returnedUnit: "PIECES",
        db: prisma,
      });

      const [row] = prisma.regulatedSalesLedger.createMany.mock.calls[0][0].data;
      expect(row).toMatchObject({ qty: -5, unitBasisQty: -5, netSales: -5.83 });
    });
  });

  describe("credit note", () => {
    const arrangeCredit = () => {
      prisma.creditNoteItem.findMany.mockResolvedValue([
        {
          tenantId: "t1",
          trackedCategoryId: "cat-A",
          invoiceItemId: "ii-new", // the credited line is the CURRENT (re-created) invoice item
          amount: 11.67,
          qty: 10,
          categoryTax: 0,
        },
      ]);
      prisma.invoiceItem.findMany.mockResolvedValue([
        { id: "ii-new", orderItemId: "oi-1", invoiceId: "inv-1" },
      ]);
      prisma.regulatedSalesLedger.findMany
        .mockResolvedValueOnce([]) // idempotency
        .mockResolvedValueOnce([staleSale()]) // live SALE rows for the credited line
        .mockResolvedValueOnce([staleSale()]); // every row of the order line (cap)
    };

    it("books a REVERSAL of 10 on the rotated line through its order line", async () => {
      arrangeCredit();
      await service.reverseCreditNoteEntries({ creditNoteId: "cn-1", db: prisma });

      expect(prisma.regulatedSalesLedger.createMany).toHaveBeenCalledTimes(1);
      const [row] = prisma.regulatedSalesLedger.createMany.mock.calls[0][0].data;
      expect(row).toMatchObject({
        entryType: "REVERSAL",
        creditNoteId: "cn-1",
        orderItemId: "oi-1",
        invoiceId: "inv-1",
        qty: -10,
        netSales: -11.67,
      });
    });

    it("looks the live SALE rows up by the credited item's order line as well as its id", async () => {
      arrangeCredit();
      await service.reverseCreditNoteEntries({ creditNoteId: "cn-1", db: prisma });
      const where = prisma.regulatedSalesLedger.findMany.mock.calls[1][0].where;
      expect(JSON.stringify(where)).toContain("oi-1");
    });
  });

  describe("a reversal that cannot be booked is made visible (SA-835)", () => {
    const periodRe = /^[0-9]{4}-[0-9]{2}$/;

    it("return of an unresolvable SALE row: the return succeeds and a notice with the id-only meta is written", async () => {
      prisma.regulatedSalesLedger.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([staleSale({ orderItemId: "oi-gone" })])
        .mockResolvedValueOnce([]);
      prisma.invoiceItem.findMany.mockResolvedValue([]);
      prisma.orderItem.findMany.mockResolvedValue([]); // the order line is gone too
      prisma.product.findMany.mockResolvedValue([]);

      await expect(
        service.reverseReturnEntries({
          returnId: "ret-9",
          orderId: "ord-1",
          returnedByProduct: new Map([["p1", 10]]),
          returnedUnit: "PIECES",
          db: prisma,
        }),
      ).resolves.toBeUndefined();

      expect(prisma.regulatedSalesLedger.createMany).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
      const data = prisma.auditLog.create.mock.calls[0][0].data;
      expect(data.action).toBe("REGULATED_REVERSAL_UNBOOKED");
      expect(data.meta).toEqual({
        platformAdmin: true,
        message: expect.any(String),
        tenantId: "t1",
        returnId: "ret-9",
        creditNoteId: null,
        lineId: "oi-gone",
        saleEntryId: "sale-1",
        qty: 75,
        period: expect.stringMatching(periodRe),
      });
    });

    it("credit note on a line no sale entry can be tied to: the notice carries the credit note ids", async () => {
      prisma.creditNoteItem.findMany.mockResolvedValue([
        {
          id: "cni-1",
          tenantId: "t1",
          trackedCategoryId: "cat-A",
          invoiceItemId: "ii-new",
          amount: 11.67,
          qty: 10,
          categoryTax: 0,
        },
      ]);
      prisma.invoiceItem.findMany
        .mockResolvedValueOnce([{ id: "ii-new", orderItemId: null, invoiceId: "inv-1" }])
        .mockResolvedValue([]); // the dangling sale's old item is gone
      prisma.regulatedSalesLedger.findMany
        .mockResolvedValueOnce([]) // idempotency
        .mockResolvedValueOnce([]) // no sale row for the credited item
        .mockResolvedValueOnce([
          { id: "sale-1", invoiceId: "inv-1", invoiceItemId: "ii-old", orderItemId: null },
        ]);

      await service.reverseCreditNoteEntries({ creditNoteId: "cn-9", db: prisma });

      expect(prisma.regulatedSalesLedger.createMany).not.toHaveBeenCalled();
      const data = prisma.auditLog.create.mock.calls[0][0].data;
      expect(data.action).toBe("REGULATED_REVERSAL_UNBOOKED");
      expect(data.meta).toMatchObject({
        tenantId: "t1",
        returnId: null,
        creditNoteId: "cn-9",
        lineId: "cni-1",
        saleEntryId: "sale-1",
        qty: 10,
        period: expect.stringMatching(periodRe),
      });
    });
  });
});
