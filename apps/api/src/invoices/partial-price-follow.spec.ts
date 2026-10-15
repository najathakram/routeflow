/**
 * SA-760 Q-760-1 (OWNER answer 10-10), red rows: when a staff order edit changes the PRICE of a line that a
 * partial invoice bills,
 *   - a DRAFT partial FOLLOWS: unit price, the line's money and the tax snapshot are rebuilt through the
 *     invoice-line builder with roundMoney, the invoice total is recomputed;
 *   - an ISSUED partial never changes and is listed (`issuedPartialsUnchanged`);
 *   - price only: quantities never change, and the partial never gains the order's un-billed lines.
 * The partials are cut by the REAL writer (createPartialFromOrder) over the stateful fake.
 */

jest.mock("./invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://example.com/invoice.pdf"),
  })),
}));
jest.mock("../storage/compress.util", () => ({
  compressDocument: jest.fn(),
}));

import { BadRequestException, Logger } from "@nestjs/common";
import { componentUnitPrice4 } from "@routeflow/pricing";
import { InvoicesService } from "./invoices.service";
import { planPartialPriceFollow } from "./partial-price-follow";
import { createMockPrisma } from "../testing/prisma-mock";
import { SplitInvoiceFakeDb, fakeOrderLine } from "./testing/split-invoice-fake-db";
import { buildSplitInvoicesService } from "./testing/split-invoice-service";

describe("SA-760 Q-760-1: a DRAFT partial follows order price edits (price only); issued partials never change", () => {
  let service: InvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let db: SplitInvoiceFakeDb;
  const mockLedger = { writeSaleEntries: jest.fn(), reverseInvoiceEntries: jest.fn() };

  beforeEach(async () => {
    prisma = createMockPrisma();
    db = new SplitInvoiceFakeDb();
    db.install(prisma);
    service = await buildSplitInvoicesService(InvoicesService, prisma, mockLedger);
    // two lines: A (10 boxes x 12 @ 2.35 = 282.00) and B (5 boxes x 12 @ 1.00 = 60.00); nothing taxed
    db.addOrder(
      {
        id: "ord-1",
        customerId: "cust-1",
        orderNumber: "ORD-1",
        subtotal: 342,
        tax: 0,
        shippingFee: 0,
        total: 342,
      },
      [
        fakeOrderLine({
          id: "oi-A",
          productId: "p-A",
          qty: 120,
          boxes: 10,
          unitPrice: 2.35,
          subtotal: 282,
        }),
        fakeOrderLine({
          id: "oi-B",
          productId: "p-B",
          qty: 60,
          boxes: 5,
          unitPrice: 1,
          subtotal: 60,
        }),
      ],
    );
  });

  const partialA = (qty = 72) =>
    service.createPartialFromOrder("ord-1", { items: [{ orderItemId: "oi-A", qty }] } as any);
  /** The order edit: line A's unit price 2.35 -> 2.50 (qty unchanged), the order totals restated. */
  const repriceA = () => {
    Object.assign(db.line("oi-A"), { unitPrice: 2.5, subtotal: 300 });
    Object.assign(db.orders.get("ord-1")!, { subtotal: 360, total: 360 });
  };

  it("a DRAFT partial of line A is re-priced; its qty is unchanged and it never gains line B", async () => {
    const created = await partialA(72);
    expect(Number(created.total)).toBe(169.2); // 72/120 of 282
    repriceA();

    const out = await service.followPartialPrices("ord-1");

    const inv = db.invoicesOf("ord-1")[0];
    expect(inv.items).toHaveLength(1); // price only: no line gained
    expect(inv.items[0]).toMatchObject({ orderItemId: "oi-A" });
    expect(Number(inv.items[0].qty)).toBe(72); // the partition stands
    expect(Number(inv.items[0].unitPrice)).toBe(2.5);
    expect(Number(inv.items[0].subtotal)).toBe(180); // 72/120 of the new 300
    expect(Number(inv.subtotal)).toBe(180);
    expect(Number(inv.total)).toBe(180); // master today: still 169.20
    expect(out.issuedPartialsUnchanged).toEqual([]);
    expect(db.line("oi-A").invoicedQty).toBe(72); // the counter is untouched by a price follow
    expect(db.line("oi-B").invoicedQty).toBe(0);
  });

  it("an ISSUED partial is unchanged and listed in issuedPartialsUnchanged", async () => {
    const created = await partialA(72);
    db.invoices.find((i) => i.id === created.id)!.status = "SENT";
    repriceA();

    const out = await service.followPartialPrices("ord-1");

    expect(out.issuedPartialsUnchanged).toEqual([
      { invoiceId: created.id, invoiceNumber: created.invoiceNumber },
    ]);
    const inv = db.invoicesOf("ord-1")[0];
    expect(Number(inv.items[0].unitPrice)).toBe(2.35);
    expect(Number(inv.total)).toBe(169.2);
    expect(db.invoiceUpdateCalls).toHaveLength(0);
  });

  it("two partials of one line: the DRAFT follows, the issued one stays, and Σ the line is consistent", async () => {
    const first = await partialA(72);
    await partialA(48);
    db.invoices.find((i) => i.id === first.id)!.status = "SENT";
    repriceA();

    const out = await service.followPartialPrices("ord-1");

    expect(out.issuedPartialsUnchanged.map((x) => x.invoiceId)).toEqual([first.id]);
    const [issued, draft] = db.invoicesOf("ord-1");
    expect(Number(issued.total)).toBe(169.2);
    // telescoped over what the line already billed: round(300 * 120/120) - round(300 * 72/120) = 120
    expect(Number(draft.items[0].subtotal)).toBe(120);
    expect(Number(draft.items[0].qty)).toBe(48);
    expect(Number(draft.total)).toBe(120);
  });

  it("a qty-only edit (price unchanged) changes nothing", async () => {
    await partialA(72);
    Object.assign(db.line("oi-A"), { qty: 132, boxes: 11, subtotal: 310.2 }); // 11 boxes at the same 2.35
    const out = await service.followPartialPrices("ord-1");
    expect(out.issuedPartialsUnchanged).toEqual([]);
    expect(db.invoiceUpdateCalls).toHaveLength(0);
  });

  it("a line-discount-only change (unit price untouched, the order line's money lower) is followed by the DRAFT partial", async () => {
    const created = await partialA(72);
    Object.assign(db.line("oi-A"), { subtotal: 270 }); // a promo / line discount: 282 -> 270, unitPrice stays 2.35
    Object.assign(db.orders.get("ord-1")!, { subtotal: 330, total: 330 });
    await service.followPartialPrices("ord-1");
    const inv = db.invoicesOf("ord-1")[0];
    expect(inv.id).toBe(created.id);
    expect(Number(inv.items[0].subtotal)).toBe(162); // 72/120 of 270
    expect(Number(inv.total)).toBe(162);
    expect(Number(inv.items[0].qty)).toBe(72);
  });

  it("the rebuilt lines get their MSRP snapshot like every other builder (applyMsrpSnapshots)", async () => {
    await partialA(72);
    const spy = jest.spyOn(service as any, "applyMsrpSnapshots");
    repriceA();
    await service.followPartialPrices("ord-1");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][2]).toHaveLength(1); // the one stale line
  });

  it("the follow's tax equals the creator's order.tax x subtotal share (summed at the order-derived rate)", async () => {
    Object.assign(db.orders.get("ord-1")!, { tax: 28.215, total: 370.215 }); // 8.25% of 342
    const created = await partialA(72); // 169.2 + 169.2/342*28.215 (= 13.96)
    expect(Number(created.taxAmount)).toBe(13.96);
    // the follow sums its lines through sumInvoiceTotalsStrict (order-derived rate); the creator uses regularTaxShare: same figure
    repriceA(); // line A 300 -> order subtotal 360; the order's tax restated at the same 8.25%: 29.7
    Object.assign(db.orders.get("ord-1")!, { tax: 29.7, total: 389.7 });
    await service.followPartialPrices("ord-1");
    const inv = db.invoicesOf("ord-1")[0];
    expect(Number(inv.subtotal)).toBe(180);
    expect(Number(inv.taxAmount)).toBe(14.85); // 29.7 x 180/360: the order-derived rate summed by sumInvoiceTotalsStrict, the creator's figure
    expect(Number(inv.total)).toBe(194.85);
  });

  describe("a BOGO partial is not stale just because the select forgot promoFreeUnits", () => {
    // 10 boxes with 2 free (BUY_N_GET_M): paid 8 boxes = 225.60; line B is an unrelated plain line.
    const seedBogo = () => {
      db.honorItemSelect = true; // read items through the planner's own select, like Prisma
      Object.assign(db.line("oi-A"), { promoFreeUnits: 2, subtotal: 225.6 });
      Object.assign(db.orders.get("ord-1")!, { subtotal: 285.6, total: 285.6 });
    };
    const editLineB = () => {
      // an unrelated qty edit on line B: 5 -> 6 boxes at the same 1.00
      Object.assign(db.line("oi-B"), { qty: 72, boxes: 6, subtotal: 72 });
      Object.assign(db.orders.get("ord-1")!, { subtotal: 297.6, total: 297.6 });
    };

    it("a DRAFT BOGO partial: [] listed and ZERO writes (no pdfUrl null-out)", async () => {
      seedBogo();
      const created = await partialA(72);
      expect(db.invoiceItems.find((i) => i.invoiceId === created.id)!.promoFreeUnits).toBe(1);
      editLineB();
      const out = await service.followPartialPrices("ord-1");
      expect(out.issuedPartialsUnchanged).toEqual([]);
      expect(out.followed).toEqual([]);
      expect(db.invoiceUpdateCalls).toHaveLength(0);
      expect((prisma as any).invoiceItem.update).not.toHaveBeenCalled();
    });

    it("an ISSUED BOGO partial is not listed in issuedPartialsUnchanged", async () => {
      seedBogo();
      const created = await partialA(72);
      db.invoices.find((i) => i.id === created.id)!.status = "SENT";
      editLineB();
      const out = await service.followPartialPrices("ord-1");
      expect(out.issuedPartialsUnchanged).toEqual([]);
    });

    it("the planner reads promoFreeUnits (the staleness rule compares it)", async () => {
      seedBogo();
      await partialA(72);
      const spy = (prisma as any).invoice.findMany;
      spy.mockClear();
      await planPartialPriceFollow(
        (service as any).followDeps(),
        (prisma as any).forTenant(),
        "ord-1",
      );
      expect(spy.mock.calls[0][0].select.items.select.promoFreeUnits).toBe(true);
    });
  });

  describe("a line the builder cannot rebuild", () => {
    const planWith = async (buildItem: () => never) => {
      await partialA(72);
      repriceA();
      const deps = { ...(service as any).followDeps(), buildItem };
      return planPartialPriceFollow(deps, (prisma as any).forTenant(), "ord-1");
    };

    it("its refusal (BadRequest) skips the line and is logged", async () => {
      const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
      const plan = await planWith(() => {
        throw new BadRequestException("not a whole number of pieces");
      });
      expect(plan.drafts).toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("not a whole number of pieces"));
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/invoice .+ item ii-/));
      warn.mockRestore();
    });

    it("anything else is a real fault and is rethrown, not swallowed", async () => {
      await expect(
        planWith(() => {
          throw new TypeError("cannot read properties of undefined");
        }),
      ).rejects.toThrow(TypeError);
    });
  });

  it("a FIXED composed line: the follow re-stamps its component rows' display price on the new net (same path as a DRAFT edit)", async () => {
    db.honorItemSelect = true; // read items through the planner's own select: dropping compositionMode turns this red
    const created = await partialA(72);
    db.invoiceItems.find((i) => i.invoiceId === created.id)!.compositionMode = "FIXED";
    repriceA(); // 72 pieces of the line are now worth 180.00 (was 169.20)
    await service.followPartialPrices("ord-1");
    const upd = (prisma as any).invoiceItemComponent.updateMany;
    expect(upd).toHaveBeenCalledTimes(1);
    expect(upd).toHaveBeenCalledWith({
      where: { invoiceItemId: expect.any(String), tenantId: "test-tenant" },
      data: { displayUnitPrice4: componentUnitPrice4(180, 72) },
    });
  });

  it("a plain line writes no component row", async () => {
    await partialA(72);
    repriceA();
    await service.followPartialPrices("ord-1");
    expect((prisma as any).invoiceItemComponent.updateMany).not.toHaveBeenCalled();
  });

  it("the sole invoice that bills the whole order is the MIRROR, not a partial: left to the re-sync", async () => {
    await service.createInvoiceFromOrder("ord-1");
    expect(db.invoicesOf("ord-1")).toHaveLength(1);
    Object.assign(db.line("oi-A"), { unitPrice: 2.5, subtotal: 300 });
    const out = await service.followPartialPrices("ord-1");
    expect(out.issuedPartialsUnchanged).toEqual([]);
    expect(db.invoiceUpdateCalls).toHaveLength(0);
  });

  it("projectEditedInvoiceTotals({partials}) reports exactly the total the follow then writes", async () => {
    await partialA(72);
    repriceA();
    const projected = await service.projectEditedInvoiceTotals(
      { ...(prisma as any).forTenant(), $executeRaw: jest.fn() },
      "ord-1",
      { resync: false, partials: true },
    );
    expect(projected).toEqual([{ invoiceId: db.invoicesOf("ord-1")[0].id, projectedTotal: 180 }]);
    expect(db.invoiceUpdateCalls).toHaveLength(0); // projecting writes nothing
    await service.followPartialPrices("ord-1");
    expect(Number(db.invoicesOf("ord-1")[0].total)).toBe(projected[0].projectedTotal);
  });
});
