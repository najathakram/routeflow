/**
 * B1031: applyPriceAdjustment re-prices a line as `newPrice * multiplier - lineDiscount`, so a low new price
 * against a stored line discount wrote a NEGATIVE line subtotal (1 x $50 with a $10 discount re-priced to
 * $5 stored -5 and lowered the invoice total), on DRAFT, SENT, PARTIAL and OVERDUE invoices. create() and
 * (since B1026) update() refuse that through assertNoNegativeLineSubtotal; the re-price now runs the SAME
 * guard over the lines it re-prices (only those: a stored line it leaves alone is not re-judged, SA-640),
 * with create()'s code and message, before any write. The bulk scope (ALL_CUSTOMER_SINCE) pre-flights every
 * target invoice first, so a bad line on invoice N never leaves invoices 1..N-1 already re-priced.
 */
jest.mock("./invoice-pdf.service", () => ({ InvoicePdfService: class InvoicePdfService {} }));
jest.mock("../storage/compress.util", () => ({ compressDocument: jest.fn() }));
jest.mock("../common/msrp", () => ({ loadMsrpMap: jest.fn().mockResolvedValue(new Map()) }));

import { Test } from "@nestjs/testing";
import { InvoiceStatus } from "@prisma/client";
import { ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { InvoicesService } from "./invoices.service";
import { buildPriceAdjustmentUpdates } from "./price-adjustment-ledger";
import { PrismaService } from "../prisma/prisma.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { createMockPrisma } from "../testing/prisma-mock";

const NEG = (d: string, s: number) =>
  `Line item "${d}" has a negative subtotal (${s}). Discount cannot exceed line total.`;

const autoMock = () =>
  new Proxy({} as Record<string | symbol, jest.Mock>, {
    get: (t, k) =>
      k === "then" || typeof k === "symbol"
        ? undefined
        : (t[k] ??= jest.fn().mockResolvedValue(undefined)),
  });

/** 1 x $50 with a $10 line discount: stored subtotal 40, so a re-price to $5 gives 5 - 10 = -5. */
const line = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  invoiceId: "inv-1",
  productId: `p-${id}`,
  description: "Widget",
  trackedCategoryId: null,
  trackedSubcategoryId: null,
  unitPrice: 50,
  discount: 10,
  subtotal: 40,
  qty: 1,
  taxRate: 0,
  categoryTaxAmount: 0,
  boxes: null,
  pieces: null,
  unitsPerBox: null,
  unitLabel: null,
  promoFreeUnits: null,
  orderItemId: null,
  ...over,
});

const build = (items: any[], prices: Record<string, number>) =>
  buildPriceAdjustmentUpdates({
    items,
    localPriceMap: new Map(Object.entries(prices)),
    categoriesById: new Map(),
    unitsPerBoxByProduct: new Map(),
    isTaxExempt: false,
  });

describe("buildPriceAdjustmentUpdates — negative line subtotal (B1031)", () => {
  it("(a) re-pricing 1 x $50 with a $10 line discount down to $5 is refused with create()'s message", () => {
    expect(() => build([line("i1")], { i1: 5 })).toThrow(NEG("Widget", -5));
  });

  it("(b) controls: a re-price that lands exactly on 0 or above saves ($10 -> 0, $20 -> 10)", () => {
    expect(build([line("i1")], { i1: 10 })[0].data.subtotal).toBe(0);
    expect(build([line("i1")], { i1: 20 })[0].data.subtotal).toBe(10);
  });

  it("(c) only the lines being RE-PRICED are judged: a stored legacy negative line left alone does not block the rest", () => {
    const legacy = line("legacy", { subtotal: -45, discount: 50, unitPrice: 5 });
    const out = build([legacy, line("i1")], { i1: 20 });
    expect(out.map((u) => u.id)).toEqual(["i1"]);
  });

  it("(d) the refusal names the offending line even when other re-priced lines are fine", () => {
    const fine = line("i2", { description: "Gadget" });
    expect(() => build([fine, line("i1")], { i2: 30, i1: 5 })).toThrow(NEG("Widget", -5));
  });
});

describe("InvoicesService.applyPriceAdjustment — the guard runs before any write (B1031)", () => {
  let service: InvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let ledger: Record<string, jest.Mock>;
  let commission: Record<string, jest.Mock>;

  const invoice = (id: string, status: InvoiceStatus, items: any[], over: any = {}) => ({
    id,
    invoiceNumber: `INV-${id}`,
    customerId: "cust-1",
    orderId: null,
    status,
    discount: 0,
    shippingFee: 0,
    internalNotes: null,
    payments: [],
    items,
    ...over,
  });
  const arrange = (invoices: Record<string, any>) => {
    prisma.invoice.findUnique.mockImplementation(
      async ({ where }: any) => invoices[where.id] ?? null,
    );
    prisma.customer.findFirst.mockResolvedValue({ isTaxExempt: false });
    prisma.trackedCategory.findMany.mockResolvedValue([]);
    prisma.product.findMany.mockResolvedValue([]);
    prisma.invoiceItem.update.mockResolvedValue({});
    prisma.invoice.update.mockResolvedValue({});
    prisma.invoiceItem.findMany.mockResolvedValue([]);
  };
  const noWrites = () => {
    expect(prisma.invoiceItem.update).not.toHaveBeenCalled();
    expect(prisma.invoiceItem.updateMany).not.toHaveBeenCalled();
    expect(prisma.invoice.update).not.toHaveBeenCalled();
    expect(ledger.correctSaleForPriceChange).not.toHaveBeenCalled();
    expect(commission.syncInvoiceCommissionSafe).not.toHaveBeenCalled();
  };

  beforeEach(async () => {
    prisma = createMockPrisma();
    const module = await Test.createTestingModule({ providers: [InvoicesService] })
      .useMocker((token) => {
        if (token === PrismaService) return prisma;
        if (token === EntitlementsService) return { hasFlag: jest.fn().mockResolvedValue(false) };
        return autoMock();
      })
      .compile();
    service = module.get(InvoicesService);
    ledger = (service as any).ledger;
    commission = (service as any).commissionEngine;
  });

  it.each([InvoiceStatus.DRAFT, InvoiceStatus.SENT, InvoiceStatus.PARTIAL, InvoiceStatus.OVERDUE])(
    "(e) SINGLE on a %s invoice: a re-price that would store -5 is refused 400 and writes nothing",
    async (status) => {
      arrange({ "inv-1": invoice("inv-1", status, [line("i1")]) });
      const run = service.applyPriceAdjustment("inv-1", {
        items: [{ itemId: "i1", newUnitPrice: 5 }],
        scope: "SINGLE",
      });
      await expect(run).rejects.toThrow(NEG("Widget", -5));
      await expect(run).rejects.toMatchObject({ status: 400 });
      noWrites();
    },
  );

  it("(f) control: a re-price that stays positive still writes (the line and the invoice totals)", async () => {
    arrange({ "inv-1": invoice("inv-1", InvoiceStatus.SENT, [line("i1")]) });
    prisma.invoiceItem.findMany.mockResolvedValue([line("i1", { unitPrice: 20, subtotal: 10 })]);
    await service.applyPriceAdjustment("inv-1", {
      items: [{ itemId: "i1", newUnitPrice: 20 }],
      scope: "SINGLE",
    });
    expect(prisma.invoiceItem.update).toHaveBeenCalledTimes(1);
    expect(prisma.invoiceItem.update.mock.calls[0][0].data.subtotal).toBe(10);
    expect(prisma.invoice.update).toHaveBeenCalledTimes(1);
  });

  it("(g) BULK: a bad line on the SECOND target invoice refuses the whole run before the first is written", async () => {
    const ok = invoice("inv-1", InvoiceStatus.SENT, [
      line("a1", { discount: 0, subtotal: 50, productId: "prod-x" }),
    ]);
    const bad = invoice("inv-2", InvoiceStatus.SENT, [
      line("b1", { discount: 10, subtotal: 40, productId: "prod-x" }),
    ]);
    arrange({ "inv-1": ok, "inv-2": bad });
    prisma.invoice.findMany.mockResolvedValue([ok, bad]);
    const run = service.applyPriceAdjustment("inv-1", {
      items: [{ itemId: "a1", newUnitPrice: 5 }],
      scope: "ALL_CUSTOMER_SINCE",
      sinceDate: "2026-01-01",
    });
    await expect(run).rejects.toThrow(/INV-inv-2/);
    await expect(run).rejects.toThrow(NEG("Widget", -5));
    noWrites();
  });

  // SA ruling on B1031: the re-price must also keep each invoice's TOTALS sane (B1030's assertInvoiceTotalsSane),
  // in the same pass as the line guard, so a bulk re-price is all-or-nothing on both.
  const plain = (id: string, over: Record<string, unknown> = {}) =>
    line(id, { unitPrice: 50, discount: 0, subtotal: 50, productId: "prod-x", ...over });

  it("(h) BULK: a re-price that would leave ONE invoice with discount > subtotal refuses the whole batch and writes nothing", async () => {
    const ok = invoice("inv-1", InvoiceStatus.SENT, [plain("a1")], { discount: 0 });
    const bad = invoice("inv-2", InvoiceStatus.SENT, [plain("b1")], { discount: 30 });
    arrange({ "inv-1": ok, "inv-2": bad });
    prisma.invoice.findMany.mockResolvedValue([ok, bad]);
    const run = service.applyPriceAdjustment("inv-1", {
      items: [{ itemId: "a1", newUnitPrice: 20 }],
      scope: "ALL_CUSTOMER_SINCE",
      sinceDate: "2026-01-01",
    });
    await expect(run).rejects.toThrow(
      "Invoice INV-inv-2: Invoice discount ($30.00) cannot exceed subtotal ($20.00).",
    );
    await expect(run).rejects.toMatchObject({ status: 400 });
    noWrites();
  });

  it("(i) BULK control: the same batch with discounts the new subtotals still cover saves BOTH invoices", async () => {
    const one = invoice("inv-1", InvoiceStatus.SENT, [plain("a1")], { discount: 0 });
    const two = invoice("inv-2", InvoiceStatus.SENT, [plain("b1")], { discount: 5 });
    arrange({ "inv-1": one, "inv-2": two });
    prisma.invoice.findMany.mockResolvedValue([one, two]);
    await service.applyPriceAdjustment("inv-1", {
      items: [{ itemId: "a1", newUnitPrice: 20 }],
      scope: "ALL_CUSTOMER_SINCE",
      sinceDate: "2026-01-01",
    });
    expect(prisma.invoiceItem.update).toHaveBeenCalledTimes(2);
    expect(prisma.invoice.update).toHaveBeenCalledTimes(2);
  });

  it("(j) SINGLE: a re-price that leaves discount > subtotal is refused with create()'s message and writes nothing", async () => {
    arrange({ "inv-1": invoice("inv-1", InvoiceStatus.SENT, [plain("a1")], { discount: 30 }) });
    const run = service.applyPriceAdjustment("inv-1", {
      items: [{ itemId: "a1", newUnitPrice: 20 }],
      scope: "SINGLE",
    });
    await expect(run).rejects.toThrow("Invoice discount ($30.00) cannot exceed subtotal ($20.00).");
    noWrites();
  });

  it("(k) SINGLE control: discount equal to the new subtotal is allowed (total 0 plus shipping and tax only)", async () => {
    arrange({ "inv-1": invoice("inv-1", InvoiceStatus.SENT, [plain("a1")], { discount: 20 }) });
    await service.applyPriceAdjustment("inv-1", {
      items: [{ itemId: "a1", newUnitPrice: 20 }],
      scope: "SINGLE",
    });
    expect(prisma.invoiceItem.update).toHaveBeenCalledTimes(1);
  });

  // SA-651 (Opus MED2 for B1031): NOT-WORSE on legacy data. A stored invoice that is ALREADY insane may be
  // re-priced when the re-price does not make it worse; only sane -> insane or insane -> worse is refused.
  const LEGACY = { discount: 80, subtotal: 10, total: -70 };
  const legacyLine = (over: Record<string, unknown> = {}) =>
    plain("a1", { unitPrice: 10, subtotal: 10, ...over });

  it("(l) SINGLE: a price RAISE on a legacy invoice (discount 80 over $10, total -70) saves: it improves", async () => {
    arrange({
      "inv-1": invoice("inv-1", InvoiceStatus.SENT, [legacyLine()], LEGACY),
    });
    await service.applyPriceAdjustment("inv-1", {
      items: [{ itemId: "a1", newUnitPrice: 20 }],
      scope: "SINGLE",
    });
    expect(prisma.invoiceItem.update).toHaveBeenCalledTimes(1);
  });

  it("(m) SINGLE: a price CUT on that legacy invoice is refused: discount minus subtotal goes up and the total goes down", async () => {
    arrange({
      "inv-1": invoice("inv-1", InvoiceStatus.SENT, [legacyLine()], LEGACY),
    });
    const run = service.applyPriceAdjustment("inv-1", {
      items: [{ itemId: "a1", newUnitPrice: 5 }],
      scope: "SINGLE",
    });
    await expect(run).rejects.toThrow("Invoice discount ($80.00) cannot exceed subtotal ($5.00).");
    noWrites();
  });

  it("(n) BULK: a legacy invoice in the batch no longer blocks it when the raise improves that invoice", async () => {
    const one = invoice(
      "inv-1",
      InvoiceStatus.SENT,
      [plain("a1", { unitPrice: 10, subtotal: 10 })],
      LEGACY,
    );
    const two = invoice(
      "inv-2",
      InvoiceStatus.SENT,
      [plain("b1", { unitPrice: 10, subtotal: 10 })],
      {},
    );
    arrange({ "inv-1": one, "inv-2": two });
    prisma.invoice.findMany.mockResolvedValue([one, two]);
    await service.applyPriceAdjustment("inv-1", {
      items: [{ itemId: "a1", newUnitPrice: 20 }],
      scope: "ALL_CUSTOMER_SINCE",
      sinceDate: "2026-01-01",
    });
    expect(prisma.invoiceItem.update).toHaveBeenCalledTimes(2);
  });

  // SA-651 MED-1 (B1031): all-or-nothing is judged at PRE-FLIGHT; each invoice's tx RE-JUDGES under its own
  // locks. A race between the two can refuse invoice N after 1..N-1 committed. That must name the invoice
  // ("Invoice X:") and return a STRUCTURED partial result (what committed, what was refused, what was never
  // attempted), never a bare error that hides what committed. Semantics: STOP at the first tx refusal.
  describe("bulk race between the pre-flight and the per-invoice tx (SA-651 MED-1)", () => {
    const batch = () => {
      const mk = (n: number, over: any = {}) =>
        invoice(`inv-${n}`, InvoiceStatus.SENT, [plain(`l${n}`, { productId: "prod-x" })], over);
      return [mk(1), mk(2, { discount: 5 }), mk(3)];
    };
    const run = () =>
      service.applyPriceAdjustment("inv-1", {
        items: [{ itemId: "l1", newUnitPrice: 20 }],
        scope: "ALL_CUSTOMER_SINCE",
        sinceDate: "2026-01-01",
      });
    /** The pre-flight reads `batch()` (findMany); invoice 2's tx re-read returns `live2` instead. */
    const arrangeRace = (live2: any) => {
      const [one, two, three] = batch();
      arrange({ "inv-1": one, "inv-2": live2(two), "inv-3": three });
      prisma.invoice.findMany.mockResolvedValue([one, two, three]);
    };
    const caught = async () => {
      const err: any = await run().then(
        () => null,
        (e) => e,
      );
      expect(err).not.toBeNull();
      return err;
    };

    it("(o) invoice 2 of 3 became PAID before its tx: 409 PARTIAL lists applied [1], refused 2 with its prefix, skipped [3]", async () => {
      arrangeRace((two: any) => ({ ...two, status: InvoiceStatus.PAID }));
      const err = await caught();
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getStatus()).toBe(409);
      expect(err.getResponse()).toEqual({
        code: API_ERROR_CODES.PRICE_ADJUSTMENT_PARTIAL,
        message: "1 of 3 invoices were updated; invoice INV-inv-2 changed while saving — review it",
        applied: ["inv-1"],
        refused: {
          invoiceId: "inv-2",
          invoiceNumber: "INV-inv-2",
          code: API_ERROR_CODES.INVOICE_CHANGED_CONCURRENTLY,
          message:
            "Invoice INV-inv-2: The invoice became PAID while the price was being adjusted. Issue a credit note instead.",
        },
        skipped: ["inv-3"],
      });
      // STOP semantics: invoice 1 committed (its line + totals + commission sync), nothing for 2 or 3.
      expect(prisma.invoiceItem.update).toHaveBeenCalledTimes(1);
      expect(prisma.invoice.update).toHaveBeenCalledTimes(1);
      expect(prisma.invoice.update.mock.calls[0][0].where).toEqual({ id: "inv-1" });
      expect(commission.syncInvoiceCommissionSafe).toHaveBeenCalledTimes(1);
      expect(commission.syncInvoiceCommissionSafe).toHaveBeenCalledWith("inv-1");
    });

    it("(p) the tx re-judge of the totals refuses invoice 2 (its discount grew after the pre-flight): partial, code MONEY_INVARIANT, prefixed copy", async () => {
      arrangeRace((two: any) => ({ ...two, discount: 30 }));
      const err = await caught();
      expect(err.getStatus()).toBe(409);
      const body = err.getResponse();
      expect(body.code).toBe(API_ERROR_CODES.PRICE_ADJUSTMENT_PARTIAL);
      expect(body.applied).toEqual(["inv-1"]);
      expect(body.refused).toEqual({
        invoiceId: "inv-2",
        invoiceNumber: "INV-inv-2",
        code: API_ERROR_CODES.MONEY_INVARIANT,
        message: "Invoice INV-inv-2: Invoice discount ($30.00) cannot exceed subtotal ($20.00).",
      });
      expect(body.skipped).toEqual(["inv-3"]);
      expect(prisma.invoice.update).toHaveBeenCalledTimes(1);
    });

    it("(q) the LAST invoice refusing lists nothing as skipped", async () => {
      const [one, two, three] = batch();
      arrange({ "inv-1": one, "inv-2": two, "inv-3": { ...three, status: InvoiceStatus.PAID } });
      prisma.invoice.findMany.mockResolvedValue([one, two, three]);
      const body = (await caught()).getResponse();
      expect(body.applied).toEqual(["inv-1", "inv-2"]);
      expect(body.refused.invoiceId).toBe("inv-3");
      expect(body.skipped).toEqual([]);
      expect(body.message).toBe(
        "2 of 3 invoices were updated; invoice INV-inv-3 changed while saving — review it",
      );
    });

    it("(r) the FIRST invoice of the run refusing in its tx committed nothing: a plain prefixed 409, no partial body", async () => {
      const [one, two, three] = batch();
      arrange({ "inv-1": one, "inv-2": { ...two, status: InvoiceStatus.PAID }, "inv-3": three });
      prisma.invoice.findMany.mockResolvedValue([two, one, three]); // inv-2 runs first
      const err = await caught();
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.message).toBe(
        "Invoice INV-inv-2: The invoice became PAID while the price was being adjusted. Issue a credit note instead.",
      );
      expect(err.getResponse()).not.toHaveProperty("applied");
      noWrites();
    });

    it("(s) a fault that is not a refusal (the database failing) is rethrown as is, never rewritten as a refusal", async () => {
      const [one, two, three] = batch();
      arrange({ "inv-1": one, "inv-2": two, "inv-3": three });
      prisma.invoice.findMany.mockResolvedValue([one, two, three]);
      const boom = new Error("connection reset");
      prisma.invoiceItem.update.mockResolvedValueOnce({}).mockRejectedValueOnce(boom);
      await expect(run()).rejects.toBe(boom);
    });

    it("(t) SINGLE scope keeps its plain, unprefixed refusal (the prefix and the partial body are bulk-only)", async () => {
      arrange({
        "inv-1": invoice("inv-1", InvoiceStatus.SENT, [plain("a1")], { discount: 30 }),
      });
      await expect(
        service.applyPriceAdjustment("inv-1", {
          items: [{ itemId: "a1", newUnitPrice: 20 }],
          scope: "SINGLE",
        }),
      ).rejects.toMatchObject({
        message: "Invoice discount ($30.00) cannot exceed subtotal ($20.00).",
        status: 400,
      });
    });
  });
});
