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
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { NumberingService } from "../import/numbering.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";

const category = (rate: number) => ({
  id: "cat-1",
  taxType: "PERCENT_OF_SALE",
  rate,
  priceIncludesTax: false,
});
// EXCISE_PER_UNIT: rate x unitBasisQty (the piece count) — orthogonal to how the
// price is prorated across boxes (B659 review finding 2).
const perUnitCategory = (rate: number) => ({
  id: "cat-1",
  taxType: "EXCISE_PER_UNIT",
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
        {
          provide: SellingRestrictionsService,
          useValue: { assertLinesSellable: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: PrismaService, useValue: prisma },
        {
          provide: EntitlementAuthority,
          inject: [EntitlementsService],
          useFactory: (e: { hasFlag?: (t: string, k: string) => Promise<boolean> }) => ({
            can: (t: string, k: string) => e.hasFlag?.(t, k) ?? Promise.resolve(false),
          }),
        },
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
    discount?: number;
    total?: number;
    products?: any[];
    rate?: number;
    category?: Record<string, unknown>;
  }) => {
    const subtotal = opts.subtotal ?? 100;
    const taxAmount = opts.taxAmount ?? 0;
    const discount = opts.discount ?? 0;
    // H5: a convert re-takes TODAY's tenant rate (settings.taxRate, a percent). A quote that carries regular tax
    // (taxAmount 10 on 100) is the 10% tenant; one that carries none is a tenant with no rate (the levy alone).
    (prisma as any).systemConfig.findFirst.mockResolvedValue({ value: taxAmount > 0 ? "10" : "0" });
    prisma.estimate.findUnique.mockResolvedValue({
      id: "est-1",
      status: "ACCEPTED",
      customerId: "cust-1",
      customer: { isTaxExempt: !!opts.exempt },
      subtotal,
      taxAmount,
      discount,
      total: opts.total ?? subtotal - discount + taxAmount,
      notes: null,
      terms: null,
      items: opts.items,
    });
    prisma.product.findMany.mockResolvedValue(opts.products ?? [regulatedProduct()]);
    prisma.trackedCategory.findMany.mockResolvedValue([
      opts.category ?? category(opts.rate ?? 0.1),
    ]);
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

  it("B294 one source: the regular tax is today's rate on the subtotal ONLY, and the fresh levy is added, never subtracted", async () => {
    // H5: today's rate is 10%, so the regular tax on a 100 subtotal is 10; the levy is 10% = 10 on top.
    arm({ items: [line()], taxAmount: 10 });
    await service.convertToInvoice("est-1");
    expect(created().items.create[0]).toMatchObject({ taxRate: 0.1, categoryTaxAmount: 10 });
    expect(created().taxAmount).toBe(20); // regular 10 + levy 10
    expect(created().total).toBe(120);
  });

  it("H5 (SA must 2): the levy the quote never carried is REPORTED - taxBasis names it and changed is true even when the regular tax did not move", async () => {
    // quoted at 10% regular tax (10 on 100); today's rate is still 10%; the regulated line adds a 10% levy = 10
    arm({ items: [line()], taxAmount: 10 });
    const inv: any = await service.convertToInvoice("est-1");
    expect(created().taxAmount).toBe(20);
    expect(inv.taxBasis).toMatchObject({
      quotedTax: 10,
      currentTax: 10,
      delta: 0,
      currentLevy: 10,
      invoiceTax: 20,
      changed: true,
    });
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

    it("(3) a GENUINE positive box count with no recoverable pack still refuses, naming the line and a remedy it can act on, BEFORE a number is reserved or the claim is made", async () => {
      // 2 boxes + 6 pieces, no stored pack, and qty doesn't derive one either: (13 - 6) / 2 = 3.5.
      // Unlike a 0-boxes line (Senior Architect ruling, option b — see the describe block below),
      // there ARE real boxes here whose worth cannot be safely reinterpreted as pure pieces.
      arm({
        items: [line(), split({ boxes: 2, pieces: 6, qty: 13 })],
        products: [regulatedProduct({ unitsPerBox: 12 })],
      });
      await expect(service.convertToInvoice("est-1")).rejects.toThrow(BadRequestException);
      // There is no estimate-update endpoint to fix a line in place — the only real remedy.
      await expect(service.convertToInvoice("est-1")).rejects.toThrow(
        "pack unknown for line 2: void this estimate and create a new one",
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
      // SA-095: a recorded value is a KNOWN fact, even when degenerate — never re-derived from
      // boxes/qty math just because it's <= 1. "1" genuinely means "no packaging".
      expect(estimateLinePack(it({ unitsPerBox: 1 }))).toBe(1);
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

  describe("PER_UNIT levy basis follows the QUOTED pack, never a live repack (B659 review finding 2)", () => {
    const split = (over: Record<string, unknown> = {}) =>
      line({ qty: 30, unitPrice: 24, subtotal: 60, boxes: 2, pieces: 6, ...over });

    it("(a) a split line's basis stays the quoted 30 pieces (2 boxes + 6 @ pack 12), even though the live pack repacked to 6", async () => {
      arm({
        items: [split({ unitsPerBox: 12 })],
        subtotal: 60,
        products: [regulatedProduct({ unitsPerBox: 6 })],
        category: perUnitCategory(1), // $1/piece
      });
      await service.convertToInvoice("est-1");
      expect(created().items.create[0]).toMatchObject({
        boxes: 2,
        pieces: 6,
        unitsPerBox: 12,
        categoryTaxAmount: 30, // 30 pieces x $1 — the QUOTED pack, not the live 6
      });
    });

    it("(b) a NO-SPLIT line's basis is qty x the quoted pack (12), never qty x the live pack (6)", async () => {
      // No boxes/pieces recorded — a plain qty line on a product quoted at a 12-pack.
      arm({
        items: [line({ qty: 5, unitPrice: 24, subtotal: 120, unitsPerBox: 12 })],
        subtotal: 120,
        products: [regulatedProduct({ unitsPerBox: 6 })], // live repack to 6
        category: perUnitCategory(1), // $1/piece
      });
      await service.convertToInvoice("est-1");
      expect(created().items.create[0]).toMatchObject({
        boxes: null,
        unitsPerBox: 12, // SA-095(b): stored on the line even though there's no box split
        categoryTaxAmount: 60, // 5 x 12 = 60 pieces x $1 — never 5 x 6 = 30
      });
      // SA-095(b) parity: the ledger row must read the SAME quoted pack, never the live one — a
      // no-split line's stored unitsPerBox is exactly what toSaleLedgerLines/applyPriceAdjustment
      // read later, so if THIS drifts from the invoice levy above, a re-price or the filing itself
      // would silently re-base off the live pack even though the levy above got it right.
      expect(ledger.writeSaleEntries.mock.calls[0][0].lines[0]).toMatchObject({
        packAtSale: 12,
        unitsPerBox: 12,
      });
    });

    it("(c) SA-095: a NO-SPLIT line RECORDED at pack 1 (no packaging) bases the levy on qty, never qty x a live repack to 12", async () => {
      // Recorded 1 is a KNOWN fact ("no packaging"), never conflated with "nothing recorded" —
      // that conflation was the actual bug: estimateLinePack used to return null for any recorded
      // value <= 1, indistinguishable from "unknown", so this line fell through to the LIVE pack.
      arm({
        items: [line({ qty: 5, unitPrice: 3, subtotal: 15, unitsPerBox: 1 })],
        subtotal: 15,
        products: [regulatedProduct({ unitsPerBox: 12 })], // live repack to 12 AFTER the quote
        category: perUnitCategory(1), // $1/piece
      });
      await service.convertToInvoice("est-1");
      expect(created().items.create[0]).toMatchObject({
        boxes: null,
        unitsPerBox: 1, // stored verbatim — SA-095(b) parity, same as any other recorded pack
        categoryTaxAmount: 5, // qty(5) x $1 — NEVER qty x live pack (5 x 12 x $1 = 60)
      });
      expect(ledger.writeSaleEntries.mock.calls[0][0].lines[0]).toMatchObject({
        packAtSale: 1,
        unitsPerBox: 1,
      });
    });

    it("(d) SA-095: a SPLIT line RECORDED at pack 1 (case 1: not really boxed) bases the levy on qty, never a live repack to 12", async () => {
      arm({
        items: [line({ qty: 5, unitPrice: 3, subtotal: 15, boxes: 5, pieces: 0, unitsPerBox: 1 })],
        subtotal: 15,
        products: [regulatedProduct({ unitsPerBox: 12 })], // live repack to 12 AFTER the quote
        category: perUnitCategory(1), // $1/piece
      });
      await service.convertToInvoice("est-1");
      // Case 1 forwards packSnapshot but no boxes/pieces (so SA-077(2)'s unconditional refusal
      // in buildManualInvoiceLines never sees a split to refuse) — the line converts as plain qty.
      expect(created().items.create[0]).toMatchObject({
        boxes: null,
        pieces: null,
        unitsPerBox: 1,
        categoryTaxAmount: 5, // qty(5) x $1 — never 5 x 12 x $1 = 60
      });
      expect(ledger.writeSaleEntries.mock.calls[0][0].lines[0]).toMatchObject({
        packAtSale: 1,
        unitsPerBox: 1,
      });
    });

    it("(e) SA-095d: a recorded pack <= 1 WITH a split PASSES THROUGH the stored qty — the split is informational on conversion, never recomputed", async () => {
      // Deliberately inconsistent: boxes(3) + pieces(2) = 5, but the stored qty is 2. If case 1
      // ever recomputed qty from the split (SA-077a, ruled OUT by SA-095d for a stored document —
      // that rule applies to incoming payloads, never to what was already quoted), this would
      // silently change the qty the customer agreed to. unitsPerBox: 0 is a RECORDED (not missing)
      // degenerate pack, so this still hits case 1, not case 2/3.
      arm({
        items: [line({ qty: 2, unitPrice: 3, subtotal: 6, boxes: 3, pieces: 2, unitsPerBox: 0 })],
        subtotal: 6,
        products: [regulatedProduct({ unitsPerBox: 12 })],
        category: perUnitCategory(1),
      });
      await service.convertToInvoice("est-1");
      expect(created().items.create[0]).toMatchObject({
        qty: 2, // the estimate's own recorded qty — never boxes + pieces (5)
        boxes: null,
        pieces: null,
        categoryTaxAmount: 2, // qty(2) x $1 — never 5 x $1
      });
    });

    it("(e-sibling) a recorded pack of 1 with a CONSISTENT split (qty already equals boxes + pieces) passes through unchanged", async () => {
      // qty(5) happens to equal boxes(3) + pieces(2) here, but that's coincidence, not recomputation
      // — same passthrough rule as (e), just with a stored qty that doesn't expose the difference.
      arm({
        items: [line({ qty: 5, unitPrice: 3, subtotal: 15, boxes: 3, pieces: 2, unitsPerBox: 1 })],
        subtotal: 15,
        products: [regulatedProduct({ unitsPerBox: 12 })],
        category: perUnitCategory(1),
      });
      await service.convertToInvoice("est-1");
      expect(created().items.create[0]).toMatchObject({
        qty: 5,
        boxes: null,
        pieces: null,
        categoryTaxAmount: 5,
      });
    });
  });

  describe("unit-aware estimate lines are refused pre-flight, before reserveNext (B659 review finding 3)", () => {
    it("a line with unitLabel set is refused (409) and no number/claim/invoice is ever made", async () => {
      arm({ items: [line({ unitLabel: "Case" })] });
      await expect(service.convertToInvoice("est-1")).rejects.toMatchObject({
        status: 409,
        response: { code: "UNIT_AWARE_LINE" },
      });
      expect(numbering.reserveNext).not.toHaveBeenCalled();
      expect(prisma.estimate.updateMany).not.toHaveBeenCalled();
      expect(prisma.invoice.create).not.toHaveBeenCalled();
    });
  });

  describe("both estimate item reads are ordered, so 'line N' names the same line the tx builds (B659 review finding 4)", () => {
    it("pins orderBy: { id: 'asc' } on the pre-flight read AND the tx read", async () => {
      arm({ items: [line()] });
      await service.convertToInvoice("est-1");
      const preFlightArgs = prisma.estimate.findUnique.mock.calls[0][0];
      expect(preFlightArgs.select.items.orderBy).toEqual({ id: "asc" });
      const txArgs = prisma.estimate.findUnique.mock.calls[1][0];
      expect(txArgs.include.items.orderBy).toEqual({ id: "asc" });
    });
  });

  describe("money guards run pre-flight, from the estimate's own totals, before reserveNext (B659 review finding 5)", () => {
    it("a line with a negative subtotal (discount > line total) refuses before a number is reserved", async () => {
      arm({ items: [line({ subtotal: -5 })] });
      await expect(service.convertToInvoice("est-1")).rejects.toThrow(BadRequestException);
      await expect(service.convertToInvoice("est-1")).rejects.toThrow(/negative subtotal/);
      expect(numbering.reserveNext).not.toHaveBeenCalled();
      expect(prisma.estimate.updateMany).not.toHaveBeenCalled();
      expect(prisma.invoice.create).not.toHaveBeenCalled();
    });

    it("a discount over the estimate's own subtotal (-> a negative total) refuses before a number is reserved", async () => {
      arm({ items: [line()], subtotal: 100, discount: 500, total: -400 });
      await expect(service.convertToInvoice("est-1")).rejects.toMatchObject({
        status: 400,
        response: { code: "MONEY_INVARIANT" },
      });
      expect(numbering.reserveNext).not.toHaveBeenCalled();
      expect(prisma.estimate.updateMany).not.toHaveBeenCalled();
      expect(prisma.invoice.create).not.toHaveBeenCalled();
    });
  });

  describe("a 0/0 split is NO split (B659 review finding 6)", () => {
    it("boxes 0, pieces 0 on a boxed product converts as a plain qty line — never collapsed to 0 via normalizeBoxesPieces", async () => {
      arm({
        items: [
          line({ qty: 10, unitPrice: 5, subtotal: 50, boxes: 0, pieces: 0, unitsPerBox: null }),
        ],
        subtotal: 50,
        products: [regulatedProduct({ unitsPerBox: 12 })], // a boxed product
      });
      await service.convertToInvoice("est-1");
      expect(created().items.create[0]).toMatchObject({
        qty: 10,
        subtotal: 50,
        boxes: null,
      });
    });
  });

  describe("a pack of 1 is not a real box split — converts, never refuses forever (B659 HIGH finding, review round 2)", () => {
    it("qty 3 / boxes 3, pieces 0, unitsPerBox 1 — the web estimate form's shape whenever a pack is set, including 1 (estimates/page.tsx) — converts as a plain qty line", async () => {
      arm({
        items: [line({ qty: 3, unitPrice: 10, subtotal: 30, boxes: 3, pieces: 0, unitsPerBox: 1 })],
        subtotal: 30,
      });
      await service.convertToInvoice("est-1");
      expect(created().items.create[0]).toMatchObject({
        qty: 3,
        boxes: null,
        pieces: null,
        unitsPerBox: 1, // SA-095(b): stored verbatim — same parity fix as any other recorded pack
        subtotal: 30,
      });
      expect(numbering.reserveNext).toHaveBeenCalled();
      expect(prisma.invoice.create).toHaveBeenCalled();
    });
  });

  describe("a legacy split with NO derivable pack converts WITHOUT one — money copied verbatim, never recomputed (B659 review round 2, Senior Architect ruling option b)", () => {
    it("(i) 0 boxes + 6 pieces at a quoted subtotal converts to a 6-piece line at that subtotal, books unitBasisQty 6, and carries no pack", async () => {
      arm({
        items: [
          line({ qty: 6, unitPrice: 10, subtotal: 60, boxes: 0, pieces: 6, unitsPerBox: null }),
        ],
        subtotal: 60,
        products: [regulatedProduct({ unitsPerBox: 12 })], // a boxed product — still never consulted
        category: perUnitCategory(1), // $1/piece, so categoryTaxAmount pins the basis unambiguously
      });
      await service.convertToInvoice("est-1");
      expect(created().items.create[0]).toMatchObject({
        qty: 6,
        boxes: 0,
        pieces: 6,
        unitsPerBox: null,
        subtotal: 60,
        categoryTaxAmount: 6, // unitBasisQty 6 x $1 — pieces, never a live-pack multiple
      });
      // The title's own claim ("books unitBasisQty 6") was previously unasserted. boxes:0 (not
      // null) is what makes the ledger's own basis computation read qty directly as the piece
      // count, regardless of packAtSale — never a pack-multiplied figure.
      expect(ledger.writeSaleEntries.mock.calls[0][0].lines[0]).toMatchObject({
        qty: 6,
        boxes: 0,
        pieces: 6,
      });
    });

    it("(ii) the same shape at a DISCOUNTED subtotal (qty x unitPrice would recompute to a different, wrong figure) still converts at the stored figure — the case a derivation would have failed", async () => {
      // 6 x $10 = $60, but the agreed quote was $45 (a discount already folded in): proves the
      // money is COPIED verbatim, never recomputed through qty x unitPrice or any box math.
      arm({
        items: [
          line({ qty: 6, unitPrice: 10, subtotal: 45, boxes: null, pieces: 6, unitsPerBox: null }),
        ],
        subtotal: 45,
      });
      await service.convertToInvoice("est-1");
      expect(created().items.create[0]).toMatchObject({
        subtotal: 45, // never recomputed to 60
        boxes: 0,
        pieces: 6,
        unitsPerBox: null,
      });
      expect(created().subtotal).toBe(45);
    });
  });
});
