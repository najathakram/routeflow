/**
 * B659 (stage 1) — an accepted estimate converts through the SAME invoice line path as an interactive
 * invoice: the QUOTED price is honoured, the regulated category is read from the product NOW and its levy
 * computed through computeCategoryTax at the sale-date rate, the SALE ledger rows are written in the convert
 * transaction, and a box-split line keeps the pack it was QUOTED with (never the live product's).
 */
import { BadRequestException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { EstimatesService } from "./estimates.service";
import { estimateLinePack } from "./estimate-convert-lines";
import { PrismaService } from "../prisma/prisma.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { NumberingService } from "../import/numbering.service";
import { createMockPrisma } from "../testing/prisma-mock";

const category = (rate: number) => ({
  id: "cat-1",
  taxType: "PERCENT_OF_SALE",
  rate,
  priceIncludesTax: false,
});
const regulatedProduct = (over: Record<string, unknown> = {}) => ({
  id: "p-reg",
  unit: "pack",
  unitsPerBox: null,
  trackedCategoryId: "cat-1",
  trackedSubcategoryId: null,
  ...over,
});
const line = (over: Record<string, unknown> = {}) => ({
  description: "Widget",
  productId: "p-reg",
  qty: 2,
  unitPrice: 50,
  subtotal: 100,
  boxes: null,
  pieces: null,
  unitLabel: null,
  unitsPerBox: null,
  ...over,
});

describe("EstimatesService.convertToInvoice — regulated levy and quoted pack (B659)", () => {
  let service: EstimatesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  const numbering = { reserveNext: jest.fn().mockResolvedValue("INV-2026-0001") };
  const ledger = { writeSaleEntries: jest.fn().mockResolvedValue(undefined) };

  beforeEach(async () => {
    prisma = createMockPrisma();
    numbering.reserveNext.mockClear();
    ledger.writeSaleEntries.mockClear();
    const mod = await Test.createTestingModule({
      providers: [
        EstimatesService,
        { provide: PrismaService, useValue: prisma },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        { provide: NumberingService, useValue: numbering },
        { provide: RegulatedLedgerService, useValue: ledger },
      ],
    }).compile();
    service = mod.get(EstimatesService);
    prisma.estimate.updateMany.mockResolvedValue({ count: 1 });
    prisma.invoice.create.mockImplementation((args: any) =>
      Promise.resolve({
        id: "inv-1",
        ...args.data,
        issueDate: new Date("2026-09-21T00:00:00Z"),
        items: (args.data.items.create as any[]).map((c, i) => ({ id: `ii-${i}`, ...c })),
        customer: {},
      }),
    );
  });

  /** Arm the estimate (read for pre-flight AND inside the tx), the live product and its category. */
  const arm = (opts: {
    items: any[];
    exempt?: boolean;
    subtotal?: number;
    taxAmount?: number;
    products?: any[];
    rate?: number;
  }) => {
    const subtotal = opts.subtotal ?? 100;
    prisma.estimate.findUnique.mockResolvedValue({
      id: "est-1",
      status: "ACCEPTED",
      customerId: "cust-1",
      customer: { isTaxExempt: !!opts.exempt },
      subtotal,
      taxAmount: opts.taxAmount ?? 0,
      discount: 0,
      total: subtotal + (opts.taxAmount ?? 0),
      notes: null,
      terms: null,
      items: opts.items,
    });
    prisma.product.findMany.mockResolvedValue(opts.products ?? [regulatedProduct()]);
    prisma.trackedCategory.findMany.mockResolvedValue([category(opts.rate ?? 0.1)]);
  };
  const created = () => prisma.invoice.create.mock.calls[0][0].data;

  it("a regulated line gets its category + levy computed NOW, is added to the invoice tax and total, and books ONE SALE row", async () => {
    arm({ items: [line()] });
    await service.convertToInvoice("est-1");
    const [item] = created().items.create;
    expect(item).toMatchObject({
      trackedCategoryId: "cat-1",
      subtotal: 100, // the QUOTED price, honoured
      categoryTaxAmount: 10, // 10% of the 100 sale
    });
    expect(created()).toMatchObject({ subtotal: 100, taxAmount: 10, total: 110 });
    expect(ledger.writeSaleEntries).toHaveBeenCalledTimes(1);
    expect(ledger.writeSaleEntries.mock.calls[0][0]).toMatchObject({
      invoiceId: "inv-1",
      orderId: null,
      lines: [
        { invoiceItemId: "ii-0", trackedCategoryId: "cat-1", netSales: 100, categoryTax: 10 },
      ],
    });
  });

  it("the levy is at the SALE-DATE rate: the category now says 20%, so the invoice carries 20 (no quote-date rate exists to copy)", async () => {
    arm({ items: [line()], rate: 0.2 });
    await service.convertToInvoice("est-1");
    expect(created().items.create[0].categoryTaxAmount).toBe(20);
    expect(created().taxAmount).toBe(20);
    expect(ledger.writeSaleEntries.mock.calls[0][0].lines[0].categoryTax).toBe(20);
  });

  it("B294 one source: the regular tax is recovered from the quote's regular tax ONLY, and the fresh levy is added, never subtracted", async () => {
    // est.taxAmount = 10 is REGULAR tax on a 100 subtotal (rate 0.10); the levy is 10% = 10 on top.
    arm({ items: [line()], taxAmount: 10 });
    await service.convertToInvoice("est-1");
    expect(created().items.create[0]).toMatchObject({ taxRate: 0.1, categoryTaxAmount: 10 });
    expect(created().taxAmount).toBe(20); // regular 10 + levy 10
    expect(created().total).toBe(120);
  });

  it("an exempt customer owes $0 of BOTH, and the ledger row records the $0 that was billed", async () => {
    arm({ items: [line()], exempt: true, taxAmount: 10 });
    await service.convertToInvoice("est-1");
    expect(created().items.create[0]).toMatchObject({ taxRate: 0, categoryTaxAmount: 0 });
    expect(created().taxAmount).toBe(0);
    expect(ledger.writeSaleEntries.mock.calls[0][0].lines[0].categoryTax).toBe(0);
  });

  it("a non-regulated estimate writes no ledger row and keeps its quoted totals", async () => {
    arm({
      items: [line({ productId: "p-plain" })],
      products: [regulatedProduct({ id: "p-plain", trackedCategoryId: null })],
      taxAmount: 10,
    });
    await service.convertToInvoice("est-1");
    expect(ledger.writeSaleEntries).not.toHaveBeenCalled();
    expect(created()).toMatchObject({ subtotal: 100, taxAmount: 10, total: 110 });
  });

  it("the ledger write happens inside the convert transaction, after the invoice exists and before the estimate link", async () => {
    arm({ items: [line()] });
    await service.convertToInvoice("est-1");
    const order = (m: jest.Mock, i = 0) => m.mock.invocationCallOrder[i];
    expect(order(prisma.invoice.create as any)).toBeLessThan(order(ledger.writeSaleEntries));
    expect(order(ledger.writeSaleEntries)).toBeLessThan(
      order(prisma.estimate.updateMany as any, 1),
    );
    expect(ledger.writeSaleEntries.mock.calls[0][0].db).toBeDefined(); // the tx client
  });

  describe("pack: the estimate line's OWN, never the live product's", () => {
    // Quote written with a 12-pack: 2 boxes + 6 pieces = 30 pieces at $24/box = 2.5 x 24 = 60.
    const split = (over: Record<string, unknown> = {}) =>
      line({ qty: 30, unitPrice: 24, subtotal: 60, boxes: 2, pieces: 6, ...over });

    it("(1) the line's stored unitsPerBox wins, and a live pack change (12 -> 6) does NOT move the quoted subtotal", async () => {
      arm({
        items: [split({ unitsPerBox: 12 })],
        subtotal: 60,
        products: [regulatedProduct({ unitsPerBox: 6 })],
      });
      await service.convertToInvoice("est-1");
      expect(created().items.create[0]).toMatchObject({
        boxes: 2,
        pieces: 6,
        unitsPerBox: 12,
        qty: 30,
        subtotal: 60,
        categoryTaxAmount: 6, // levy computed fresh on the honoured price
      });
      expect(created().subtotal).toBe(60);
    });

    it("(2) an OLD estimate (boxes but no pack) derives it EXACTLY from its own split: (30 - 6) / 2 = 12", async () => {
      arm({ items: [split()], subtotal: 60, products: [regulatedProduct({ unitsPerBox: 6 })] });
      await service.convertToInvoice("est-1");
      expect(created().items.create[0]).toMatchObject({ unitsPerBox: 12, subtotal: 60 });
    });

    it("(3) an unrecoverable pack refuses with a 4xx naming the line, BEFORE a number is reserved or the claim is made", async () => {
      // pieces-only split, no stored pack: there is nothing to derive it from
      arm({
        items: [line(), split({ boxes: null, pieces: 6, qty: 6 })],
        products: [regulatedProduct({ unitsPerBox: 12 })],
      });
      await expect(service.convertToInvoice("est-1")).rejects.toThrow(BadRequestException);
      await expect(service.convertToInvoice("est-1")).rejects.toThrow(
        "pack unknown for line 2: re-save the estimate",
      );
      expect(numbering.reserveNext).not.toHaveBeenCalled();
      expect(prisma.estimate.updateMany).not.toHaveBeenCalled();
      expect(prisma.invoice.create).not.toHaveBeenCalled();
    });

    it("estimateLinePack: stored > 1 wins; derivation needs an integer > 1; never the live pack", () => {
      const it = (o: Record<string, unknown>) =>
        ({
          description: "x",
          productId: "p",
          qty: 30,
          unitPrice: 1,
          boxes: 2,
          pieces: 6,
          ...o,
        }) as any;
      expect(estimateLinePack(it({ unitsPerBox: 12 }))).toBe(12);
      expect(estimateLinePack(it({ unitsPerBox: 1 }))).toBe(12); // 1 is not a pack: derive
      expect(estimateLinePack(it({}))).toBe(12);
      expect(estimateLinePack(it({ qty: 31 }))).toBeNull(); // (31 - 6) / 2 = 12.5
      expect(estimateLinePack(it({ qty: 8 }))).toBeNull(); // (8 - 6) / 2 = 1: not a pack
      expect(estimateLinePack(it({ boxes: null }))).toBeNull();
      expect(estimateLinePack(it({ boxes: 0 }))).toBeNull();
    });

    it("a freeform line (no product) and a line with no split never need a pack", async () => {
      arm({ items: [line({ productId: null, description: "Fee" })], products: [] });
      await expect(service.convertToInvoice("est-1")).resolves.toBeDefined();
      expect(created().items.create[0]).toMatchObject({ subtotal: 100, trackedCategoryId: null });
    });
  });
});
