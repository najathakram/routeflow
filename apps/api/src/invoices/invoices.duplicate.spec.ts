/**
 * B644 — `InvoicesService.duplicate` is the ONLY correct way to copy an invoice (the web used to rebuild
 * each line from { qty, unitPrice }, which billed 6 boxes of 12 at $40 as 72 x $40 = $2,880). Pins what
 * the endpoint the Duplicate button now calls must do: copy a boxed line VERBATIM including the sale-time
 * box size, give the copy a due date derived from the copied terms (a null due date can never go OVERDUE
 * and never ages), and refuse an order-linked invoice and a unit line.
 */
jest.mock("./invoice-pdf.service", () => ({ InvoicePdfService: class InvoicePdfService {} }));
jest.mock("../storage/compress.util", () => ({ compressDocument: jest.fn() }));
jest.mock("../common/msrp", () => ({ loadMsrpMap: jest.fn().mockResolvedValue(new Map()) }));

import { Test } from "@nestjs/testing";
import { BadRequestException, ConflictException } from "@nestjs/common";
import { InvoiceStatus } from "@prisma/client";
import { InvoicesService } from "./invoices.service";
import { PrismaService } from "../prisma/prisma.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { createMockPrisma } from "../testing/prisma-mock";

const autoMock = () =>
  new Proxy({} as Record<string | symbol, jest.Mock>, {
    get: (t, k) =>
      k === "then" || typeof k === "symbol"
        ? undefined
        : (t[k] ??= jest.fn().mockResolvedValue(undefined)),
  });

// 6 boxes of a 12-piece product at $40 per BOX: stored qty is in BASE pieces (72), subtotal $240.
const boxedLine = {
  id: "li-1",
  description: "Widget",
  productId: "p1",
  qty: 72,
  unitPrice: 40,
  discount: 0,
  taxRate: 0,
  boxes: 6,
  pieces: 0,
  unitsPerBox: 12,
  subtotal: 240,
  promoFreeUnits: null,
  msrp: null,
  trackedCategoryId: null,
  trackedSubcategoryId: null,
  categoryTaxAmount: 0,
};
const source = (over: Record<string, unknown> = {}) => ({
  id: "inv-1",
  orderId: null,
  customerId: "cust-1",
  invoiceNumber: "INV-0001",
  status: InvoiceStatus.SENT,
  subtotal: 240,
  taxAmount: 0,
  discount: 0,
  shippingFee: 0,
  total: 240,
  notes: null,
  terms: null,
  paymentTermsLabel: null,
  referenceNumber: null,
  subject: null,
  items: [boxedLine],
  ...over,
});

describe("InvoicesService.duplicate — what the Duplicate button now depends on (B644)", () => {
  let service: InvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  const created = () => prisma.invoice.create.mock.calls[0][0].data;
  const ledger = { writeSaleEntries: jest.fn().mockResolvedValue(undefined) };

  beforeEach(async () => {
    ledger.writeSaleEntries.mockClear();
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
    jest.setSystemTime(new Date("2026-09-21T15:00:00.000Z"));
    prisma = createMockPrisma();
    const module = await Test.createTestingModule({ providers: [InvoicesService] })
      .useMocker((token) => {
        if (token === PrismaService) return prisma;
        if (token === EntitlementsService) return { hasFlag: jest.fn().mockResolvedValue(false) };
        if (token === RegulatedLedgerService) return ledger;
        return autoMock();
      })
      .compile();
    service = module.get(InvoicesService);
    prisma.customer.findFirst.mockResolvedValue({ isTaxExempt: false });
    prisma.invoice.create.mockResolvedValue({ id: "inv-2", items: [], customer: {}, payments: [] });
  });

  afterEach(() => jest.useRealTimers());

  it("MONEY: a boxed line is copied verbatim - 6 boxes, 72 pieces, $240 - never re-derived as qty x unitPrice", async () => {
    prisma.invoice.findUnique.mockResolvedValue(source());
    await service.duplicate("inv-1");
    expect(created().items.create[0]).toMatchObject({
      qty: 72,
      boxes: 6,
      pieces: 0,
      unitPrice: 40,
      subtotal: 240,
    });
    expect(created().subtotal).toBe(240);
    expect(created().total).toBe(240); // not 72 x 40 = 2,880
  });

  it("carries the SALE-TIME box size (unitsPerBox), so the copy never depends on the live pack", async () => {
    prisma.invoice.findUnique.mockResolvedValue(source());
    await service.duplicate("inv-1");
    expect(created().items.create[0].unitsPerBox).toBe(12);
  });

  it("carries the line's price markers and note (a copy must not reset DISCOUNTED to STANDARD or drop the note)", async () => {
    prisma.invoice.findUnique.mockResolvedValue(
      source({
        items: [{ ...boxedLine, originalPrice: 50, priceType: "DISCOUNTED", notes: "Blue label" }],
      }),
    );
    await service.duplicate("inv-1");
    expect(created().items.create[0]).toMatchObject({
      originalPrice: 50,
      priceType: "DISCOUNTED",
      notes: "Blue label",
    });
  });

  it("a plain line copies no price marker and no note (null / schema default), never garbage", async () => {
    prisma.invoice.findUnique.mockResolvedValue(source());
    await service.duplicate("inv-1");
    const line = created().items.create[0];
    expect(line.originalPrice).toBeNull();
    expect(line.priceType).toBeUndefined();
    expect(line.notes).toBeNull();
  });

  it("a line with no snapshot copies null, not undefined or the live product's size", async () => {
    prisma.invoice.findUnique.mockResolvedValue(
      source({ items: [{ ...boxedLine, unitsPerBox: null, boxes: null, pieces: null }] }),
    );
    await service.duplicate("inv-1");
    expect(created().items.create[0].unitsPerBox).toBeNull();
  });

  it("#2169 (SA-395, C2 copier contract): a duplicated NSF fee line carries systemKind verbatim", async () => {
    prisma.invoice.findUnique.mockResolvedValue(
      source({ items: [{ ...boxedLine, systemKind: "NSF_FEE" }] }),
    );
    await service.duplicate("inv-1");
    expect(created().items.create[0].systemKind).toBe("NSF_FEE");
  });

  it("#2169: a plain line (no systemKind) copies null, not undefined", async () => {
    prisma.invoice.findUnique.mockResolvedValue(source());
    await service.duplicate("inv-1");
    expect(created().items.create[0].systemKind).toBeNull();
  });

  describe("regulated LEVY - a subtotal-only assertion would pass while the levy is 12x wrong", () => {
    // A regulated boxed product: 12 pieces per box, EXCISE_PER_UNIT $0.10 per PIECE. 6 boxes = 72 pieces
    // at $40/box: subtotal $240 and levy 72 x $0.10 = $7.20 (a qty-only rebuild bases the levy on
    // qty x unitsPerBox = 864 pieces = $86.40, the 12x the old Duplicate button produced).
    const regulatedLine = { ...boxedLine, trackedCategoryId: "cat-excise", categoryTaxAmount: 7.2 };
    const regulated = (over: Record<string, unknown> = {}) =>
      source({ subtotal: 240, taxAmount: 7.2, total: 247.2, items: [regulatedLine], ...over });

    it("the copy carries the levy $7.20 (not $86.40) with the same 72 pieces / $240 it was priced on", async () => {
      prisma.invoice.findUnique.mockResolvedValue(regulated());
      await service.duplicate("inv-1");
      const line = created().items.create[0];
      expect(line.categoryTaxAmount).toBe(7.2);
      expect(line.categoryTaxAmount).not.toBe(86.4);
      // the triple the ledger's SALE row reads when the copy is issued: qty / subtotal / levy
      expect({ qty: line.qty, subtotal: line.subtotal, levy: line.categoryTaxAmount }).toEqual({
        qty: 72,
        subtotal: 240,
        levy: 7.2,
      });
      expect(line.trackedCategoryId).toBe("cat-excise");
    });

    it("the levy folds into the copy's tax and total: tax $7.20, total $247.20 (not $86.40 / $326.40)", async () => {
      prisma.invoice.findUnique.mockResolvedValue(regulated());
      await service.duplicate("inv-1");
      expect(created().subtotal).toBe(240);
      expect(created().taxAmount).toBe(7.2);
      expect(created().total).toBe(247.2);
    });

    it("several regulated lines sum their levies", async () => {
      prisma.invoice.findUnique.mockResolvedValue(
        regulated({
          items: [
            regulatedLine,
            {
              ...regulatedLine,
              id: "li-2",
              qty: 36,
              boxes: 3,
              subtotal: 120,
              categoryTaxAmount: 3.6,
            },
          ],
        }),
      );
      await service.duplicate("inv-1");
      expect(created().taxAmount).toBe(10.8);
      expect(created().total).toBe(370.8);
    });

    it("a tax-exempt customer's copy carries no levy on the line or the invoice", async () => {
      prisma.customer.findFirst.mockResolvedValue({ isTaxExempt: true });
      prisma.invoice.findUnique.mockResolvedValue(regulated());
      await service.duplicate("inv-1");
      expect(created().items.create[0].categoryTaxAmount).toBe(0);
      expect(created().taxAmount).toBe(0);
      expect(created().total).toBe(240);
    });
  });

  describe("due date - derived from the copied terms, so the copy can go OVERDUE and age", () => {
    it("Net 15 source: due 15 days after the COPY's issue date, label kept", async () => {
      prisma.invoice.findUnique.mockResolvedValue(source({ paymentTermsLabel: "Net 15" }));
      await service.duplicate("inv-1");
      expect(created().issueDate).toEqual(new Date("2026-09-21T00:00:00.000Z"));
      expect(created().dueDate).toEqual(new Date("2026-10-06T00:00:00.000Z"));
      expect(created().paymentTermsLabel).toBe("Net 15");
    });

    it("Net 60 is not flattened to Net 30 (the old client always sent today + 30)", async () => {
      prisma.invoice.findUnique.mockResolvedValue(source({ paymentTermsLabel: "Net 60" }));
      await service.duplicate("inv-1");
      expect(created().dueDate).toEqual(new Date("2026-11-20T00:00:00.000Z"));
    });

    it("Due on Receipt is due on the issue date itself", async () => {
      prisma.invoice.findUnique.mockResolvedValue(source({ paymentTermsLabel: "Due on Receipt" }));
      await service.duplicate("inv-1");
      expect(created().dueDate).toEqual(created().issueDate);
      expect(created().paymentTermsLabel).toBe("Due on Receipt");
    });

    it.each([
      ["no label", null],
      ["a blank label", "   "],
      ["a label with no day count (Net 21)", "Net 21"],
      ["an inherited object key that is not a term", "constructor"],
    ])("%s: dueDate AND label are both null, so they always agree", async (_n, label) => {
      prisma.invoice.findUnique.mockResolvedValue(source({ paymentTermsLabel: label }));
      await service.duplicate("inv-1");
      expect(created().dueDate).toBeNull();
      expect(created().paymentTermsLabel).toBeNull();
    });
  });

  describe("B680 - a duplicated regulated invoice gets its own ledger SALE footprint", () => {
    const regulatedLine = { ...boxedLine, trackedCategoryId: "cat-excise", categoryTaxAmount: 7.2 };
    const copyItems = [
      {
        id: "new-li",
        productId: "p1",
        qty: 72,
        boxes: 6,
        pieces: 0,
        unitsPerBox: 12,
        subtotal: 240,
        categoryTaxAmount: 7.2,
        trackedCategoryId: "cat-excise",
        trackedSubcategoryId: null,
        orderItemId: null,
      },
    ];
    beforeEach(() => {
      prisma.product.findMany.mockResolvedValue([{ id: "p1", unitsPerBox: 12 }]);
    });

    it("writes SALE rows for the COPY (its own invoice id and item ids), like create() does", async () => {
      prisma.invoice.findUnique.mockResolvedValue(source({ items: [regulatedLine] }));
      prisma.invoice.create.mockResolvedValue({
        id: "inv-2",
        items: copyItems,
        customer: {},
        payments: [],
      });
      await service.duplicate("inv-1");
      expect(ledger.writeSaleEntries).toHaveBeenCalledTimes(1);
      const arg = ledger.writeSaleEntries.mock.calls[0][0];
      expect(arg).toMatchObject({ invoiceId: "inv-2", orderId: null });
      expect(arg.lines).toHaveLength(1);
      expect(arg.lines[0]).toMatchObject({
        invoiceItemId: "new-li",
        trackedCategoryId: "cat-excise",
        packAtSale: 12,
      });
    });

    it("writes nothing for a copy with no regulated line", async () => {
      prisma.invoice.findUnique.mockResolvedValue(source());
      prisma.invoice.create.mockResolvedValue({
        id: "inv-2",
        items: [{ ...copyItems[0], trackedCategoryId: null }],
        customer: {},
        payments: [],
      });
      await service.duplicate("inv-1");
      expect(ledger.writeSaleEntries).not.toHaveBeenCalled();
    });

    it("the ledger write runs INSIDE the create transaction (a failed write leaves no copy)", async () => {
      prisma.invoice.findUnique.mockResolvedValue(source({ items: [regulatedLine] }));
      prisma.invoice.create.mockResolvedValue({
        id: "inv-2",
        items: copyItems,
        customer: {},
        payments: [],
      });
      // Capture the exact tx object the tenantTransaction callback receives.
      let seenTx: unknown;
      const passThrough = prisma.tenantTransaction.getMockImplementation()!;
      prisma.tenantTransaction.mockImplementationOnce((fn: any) =>
        passThrough((tx: unknown) => {
          seenTx = tx;
          return fn(tx);
        }),
      );
      await service.duplicate("inv-1");
      expect(seenTx).toBeDefined();
      expect(ledger.writeSaleEntries.mock.calls[0][0].db).toBe(seenTx);
      expect(prisma.tenantTransaction).toHaveBeenCalledTimes(1);
    });
  });

  describe("refusals - the two the UI must surface (via the global handler; no local toast)", () => {
    it("an ORDER-LINKED invoice is refused (400) and nothing is created", async () => {
      prisma.invoice.findUnique.mockResolvedValue(source({ orderId: "ord-1" }));
      await expect(service.duplicate("inv-1")).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.duplicate("inv-1")).rejects.toThrow(/order-linked/);
      expect(prisma.invoice.create).not.toHaveBeenCalled();
    });

    it("an invoice holding a UNIT line is refused (409 UNIT_AWARE_LINE) and nothing is created", async () => {
      prisma.invoice.findUnique.mockResolvedValue(
        source({ items: [{ ...boxedLine, unitLabel: "Case" }] }),
      );
      const err = await service.duplicate("inv-1").catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getResponse()).toMatchObject({ code: "UNIT_AWARE_LINE" });
      expect(prisma.invoice.create).not.toHaveBeenCalled();
    });

    it("a missing invoice is a 404", async () => {
      prisma.invoice.findUnique.mockResolvedValue(null);
      await expect(service.duplicate("nope")).rejects.toThrow(/not found/i);
    });
  });
});
