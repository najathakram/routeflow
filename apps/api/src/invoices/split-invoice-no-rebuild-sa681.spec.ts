/**
 * SA-681 (P0, live): an order split into partial invoices was DOUBLE-BILLED.
 *
 * createPartialFromOrder writes plain order-linked DRAFT partials (and bumps OrderItem.invoicedQty).
 * Every "re-sync the pending mirror to the order" caller — Mark Delivered (settleOrderInvoice), an
 * undelivered order edit, the merge winner, a change-request apply — then ran
 * reconcileOrderDraftInvoice, whose legacy branch rebuilt the OLDEST open draft to the FULL order
 * (every non-cancelled line at its whole qty) and reset invoicedQty, while the other partials kept
 * billing their share. A 10-box order split 6/4 ended up billed 10 + 4 = 14 boxes.
 *
 * The rule now: that rebuild runs only when the open draft is the order's SOLE non-void invoice;
 * otherwise reconcile returns "partials" and touches nothing, and Mark Delivered bills only what is
 * not yet invoiced (qty − invoicedQty) through createInvoiceFromOrderWithTenant.
 *
 * Every fixture is built by the real writers (createPartialFromOrder / createInvoiceFromOrder over
 * the stateful fake in ./testing/split-invoice-fake-db.ts); the assertions read money back out of
 * the rows those writers wrote. Bootstrap copied from split-invoice-cas-2612.spec.ts.
 */

jest.mock("./invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://example.com/invoice.pdf"),
  })),
}));
jest.mock("../storage/compress.util", () => ({
  compressDocument: jest.fn(),
}));

import { ConflictException, Logger } from "@nestjs/common";
import { InvoicesService } from "./invoices.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { settleOrderInvoice } from "../orders/order-status-invoicing";
import { SplitInvoiceFakeDb, fakeOrderLine } from "./testing/split-invoice-fake-db";
import { buildSplitInvoicesService } from "./testing/split-invoice-service";

describe("SA-681: partial invoices are never rebuilt to the full order", () => {
  let service: InvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let db: SplitInvoiceFakeDb;

  const mockLedger = {
    writeSaleEntries: jest.fn(),
    reverseInvoiceEntries: jest.fn(),
    syncInvoiceEntries: jest.fn(),
  };

  beforeEach(async () => {
    prisma = createMockPrisma();
    db = new SplitInvoiceFakeDb();
    db.install(prisma);
    service = await buildSplitInvoicesService(InvoicesService, prisma, mockLedger);
  });

  // 10 boxes × 12 pieces @ 2.35/piece = 282.00 (+ 8.25% tax 23.27) = 305.27. The line is stored
  // the way the order writer stores a boxed line: qty in PIECES, boxes = 10, unitsPerBox = 12.
  const ORDER_TOTAL = 305.27;
  const seedOrder = (lineOver: Record<string, unknown> = {}) =>
    db.addOrder(
      {
        id: "ord-1",
        customerId: "cust-1",
        orderNumber: "ORD-1",
        subtotal: 282,
        tax: 23.27,
        shippingFee: 0,
        total: ORDER_TOTAL,
      },
      [fakeOrderLine(lineOver)],
    );

  const splitSix = () =>
    service.createPartialFromOrder("ord-1", { items: [{ orderItemId: "oi-1", qty: 72 }] } as any);
  const splitFour = () =>
    service.createPartialFromOrder("ord-1", { items: [{ orderItemId: "oi-1", qty: 48 }] } as any);

  const markDelivered = () =>
    settleOrderInvoice(
      { invoicesService: service, prisma } as any,
      "ord-1",
      { error: jest.fn() } as unknown as Logger,
      "delivered",
    );
  const sum = (rows: any[]) =>
    Math.round(rows.reduce((s, i) => s + Number(i.total), 0) * 100) / 100;
  const shape = (rows: any[]) =>
    rows.map((i) => ({
      id: i.id,
      total: Number(i.total),
      subtotal: Number(i.subtotal),
      status: i.status,
      qty: i.items.map((it: any) => Number(it.qty)),
    }));

  describe("a 10-box order split 6 / 4", () => {
    beforeEach(async () => {
      seedOrder();
      await splitSix();
      await splitFour();
    });

    it("fixture sanity: the real writers produced two partials that sum to the order total", () => {
      const invs = db.invoicesOf("ord-1");
      expect(invs).toHaveLength(2);
      expect(invs.map((i) => i.items.map((it: any) => Number(it.qty)))).toEqual([[72], [48]]);
      expect(sum(invs)).toBe(ORDER_TOTAL);
      expect(db.line("oi-1").invoicedQty).toBe(120);
    });

    it("Mark Delivered leaves both partials unchanged and creates no third invoice", async () => {
      const before = shape(db.invoicesOf("ord-1"));
      expect(await markDelivered()).toBeUndefined(); // SA-687 S2: no false positive
      const after = db.invoicesOf("ord-1");
      expect(after).toHaveLength(2);
      expect(shape(after)).toEqual(before);
      expect(sum(after)).toBe(ORDER_TOTAL);
      expect(db.line("oi-1").invoicedQty).toBe(120);
      expect(db.invoiceUpdateCalls).toHaveLength(0);
    });

    it('reconcile on the ORDER basis is a no-op returning "partials"', async () => {
      const before = shape(db.invoicesOf("ord-1"));
      const res = await service.reconcileOrderDraftInvoice("ord-1", { basis: "order" });
      expect(res).toBe("partials");
      expect(shape(db.invoicesOf("ord-1"))).toEqual(before);
      expect(db.invoiceUpdateCalls).toHaveLength(0);
    });

    it('reconcile on the DELIVERED basis is a no-op returning "partials"', async () => {
      const before = shape(db.invoicesOf("ord-1"));
      const res = await service.reconcileOrderDraftInvoice("ord-1", { basis: "delivered" });
      expect(res).toBe("partials");
      expect(shape(db.invoicesOf("ord-1"))).toEqual(before);
      expect(db.line("oi-1").invoicedQty).toBe(120);
    });

    it("SA-687: invoices that bill more than the counter says (invoicedQty out of step) refuse to bill", async () => {
      db.line("oi-1").invoicedQty = 72; // the partials bill 120
      const before = shape(db.invoicesOf("ord-1"));
      const out = await markDelivered();
      expect(out).toBeInstanceOf(ConflictException);
      expect(shape(db.invoicesOf("ord-1"))).toEqual(before);
    });

    it("SA-687 SHOULD: a line cut below what is already invoiced (6/4, then 8 boxes) refuses to bill instead of silently billing 10", async () => {
      Object.assign(db.line("oi-1"), { qty: 96, boxes: 8, subtotal: 225.6 });
      db.orders.get("ord-1")!.subtotal = 225.6;
      const before = shape(db.invoicesOf("ord-1"));
      const out = await markDelivered();
      expect(out).toBeInstanceOf(ConflictException);
      expect(shape(db.invoicesOf("ord-1"))).toEqual(before);
    });

    it("an undelivered item edit (price change) rebuilds nothing", async () => {
      // The edit writers have already updated the order line + totals by the time they reconcile.
      db.line("oi-1").unitPrice = 2.4;
      db.line("oi-1").subtotal = 288;
      db.orders.get("ord-1")!.subtotal = 288;
      const before = shape(db.invoicesOf("ord-1"));
      await service.reconcileOrderDraftInvoice("ord-1", { basis: "order" });
      expect(shape(db.invoicesOf("ord-1"))).toEqual(before);
      expect(db.invoiceUpdateCalls).toHaveLength(0);
      expect(db.line("oi-1").invoicedQty).toBe(120);
    });
  });

  describe("a delivered-basis mirror (a driver short delivery, then a manual Mark Delivered) — deliberate decision", () => {
    it("bills the mirror (7 boxes) plus ONE remainder invoice (3 boxes): two invoices, the same 305.27 total", async () => {
      seedOrder();
      // The driver delivered 7 of 10 boxes (84 of 120 pieces): the mirror bills the delivered basis.
      prisma.deliveryMutation.findMany.mockResolvedValue([
        { orderItemId: "oi-1", type: "PARTIAL", quantityDelivered: 84 },
      ] as any);
      await service.createInvoiceFromOrder("ord-1");
      expect(db.invoicesOf("ord-1").map((i) => i.items.map((it: any) => Number(it.qty)))).toEqual([
        [84],
      ]);

      expect(await markDelivered()).toBeUndefined(); // pre-SA-681: ONE rebuilt invoice (305.27); now the mirror is "short"

      const after = db.invoicesOf("ord-1");
      expect(after.map((i) => i.items.map((it: any) => Number(it.qty)))).toEqual([[84], [36]]);
      expect(sum(after)).toBe(ORDER_TOTAL);
    });
  });

  describe("a 10-box order split 6 only", () => {
    beforeEach(async () => {
      seedOrder();
      await splitSix();
    });

    it("Mark Delivered keeps the 6-box partial and bills ONE remainder invoice for the other 4 boxes", async () => {
      const [p1Before] = shape(db.invoicesOf("ord-1"));
      expect(await markDelivered()).toBeUndefined();
      const after = db.invoicesOf("ord-1");
      expect(after).toHaveLength(2);
      expect(shape([after[0]])[0]).toEqual(p1Before);
      expect(after[1].items.map((it: any) => Number(it.qty))).toEqual([48]);
      expect(sum(after)).toBe(ORDER_TOTAL);
      expect(db.line("oi-1").invoicedQty).toBe(120);
    });
  });

  describe("a sole pending-mirror draft (no partials) reconciles exactly as before", () => {
    beforeEach(async () => {
      seedOrder();
      await service.createInvoiceFromOrder("ord-1");
    });

    it("fixture sanity: one full-order draft", () => {
      const invs = db.invoicesOf("ord-1");
      expect(invs).toHaveLength(1);
      expect(sum(invs)).toBe(ORDER_TOTAL);
      expect(db.line("oi-1").invoicedQty).toBe(120);
    });

    it("an order edit rebuilds the mirror to the edited order", async () => {
      db.line("oi-1").unitPrice = 2.4;
      db.line("oi-1").subtotal = 288;
      db.orders.get("ord-1")!.subtotal = 288;
      db.orders.get("ord-1")!.tax = 23.76;
      const res = await service.reconcileOrderDraftInvoice("ord-1", { basis: "order" });
      expect(res).not.toBe("partials");
      const [inv] = db.invoicesOf("ord-1");
      expect(Number(inv.subtotal)).toBe(288);
      expect(Number(inv.total)).toBe(311.76);
      expect(db.line("oi-1").invoicedQty).toBe(120);
    });

    it("an order edit that RAISES the qty (draft now bills less than the order) still rebuilds", async () => {
      const l = db.line("oi-1");
      Object.assign(l, { qty: 132, boxes: 11, subtotal: 310.2 });
      db.orders.get("ord-1")!.subtotal = 310.2;
      db.orders.get("ord-1")!.tax = 25.59;
      await service.reconcileOrderDraftInvoice("ord-1", { basis: "order" });
      const invs = db.invoicesOf("ord-1");
      expect(invs).toHaveLength(1);
      expect(Number(invs[0].subtotal)).toBe(310.2);
      expect(invs[0].items.map((it: any) => Number(it.qty))).toEqual([132]);
    });

    it("Mark Delivered reconciles the mirror in place and creates no second invoice", async () => {
      expect(await markDelivered()).toBeUndefined();
      const invs = db.invoicesOf("ord-1");
      expect(invs).toHaveLength(1);
      expect(sum(invs)).toBe(ORDER_TOTAL);
      expect(db.invoiceUpdateCalls).toHaveLength(1);
    });
  });

  describe("SA-687b: the review guard has no false positives on normal orders", () => {
    const addFeeLine = () =>
      db.invoiceItems.push({
        id: "ii-fee",
        invoiceId: db.invoices[0].id,
        orderItemId: null,
        productId: null,
        description: "Fuel surcharge",
        qty: 1,
        subtotal: 5,
      });

    it("a 6/4 order with a freeform fee line: Mark Delivered with nothing left creates nothing and is not refused", async () => {
      seedOrder();
      await splitSix();
      await splitFour();
      addFeeLine();
      expect(await markDelivered()).toBeUndefined();
      expect(db.invoicesOf("ord-1")).toHaveLength(2);
    });

    it("6 only + a freeform fee line: the remainder is still billed (the fee line is not an orphan)", async () => {
      seedOrder();
      await splitSix();
      addFeeLine();
      expect(await markDelivered()).toBeUndefined();
      expect(db.invoicesOf("ord-1")).toHaveLength(2);
    });

    it("createInvoiceFromOrder on an order with NO invoice is not refused (createSale / delivered-reconcile only create then)", async () => {
      seedOrder();
      await expect(service.createInvoiceFromOrder("ord-1")).resolves.toHaveLength(1);
    });

    it("a SENT 6-only partial, then 'Generate Invoice (full order)': bills the other 4 boxes (counter in step, not refused)", async () => {
      seedOrder();
      await splitSix();
      db.invoices[0].status = "SENT";
      const out: any = await service.createInvoiceFromOrder("ord-1");
      expect(out).toHaveLength(1);
      expect(db.invoicesOf("ord-1").map((i) => i.items.map((it: any) => Number(it.qty)))).toEqual([
        [72],
        [48],
      ]);
      expect(sum(db.invoicesOf("ord-1"))).toBe(ORDER_TOTAL);
    });
  });

  describe("a draft beside a FINALIZED invoice of the same order is not rebuilt either", () => {
    it("an open draft + a SENT partial: no rebuild", async () => {
      seedOrder();
      await splitSix();
      await splitFour();
      db.invoices[0].status = "SENT"; // P1 issued; P2 is still an open DRAFT
      const before = shape(db.invoicesOf("ord-1"));
      await service.reconcileOrderDraftInvoice("ord-1", { basis: "order" });
      expect(shape(db.invoicesOf("ord-1"))).toEqual(before);
      expect(db.invoiceUpdateCalls).toHaveLength(0);
    });
  });

  describe("a regulated SEPARATE_INVOICE split is unchanged (sibling-aware path)", () => {
    it("base + R1 are each rebuilt from their own group; they sum to the edited order", async () => {
      db.trackedCategories = [
        {
          id: "cat-reg",
          name: "Tobacco",
          invoiceTreatment: "SEPARATE_INVOICE",
          taxType: "NONE",
          rate: 0,
        },
      ];
      db.addOrder(
        {
          id: "ord-1",
          customerId: "cust-1",
          orderNumber: "ORD-1",
          subtotal: 90,
          tax: 0,
          shippingFee: 0,
          total: 90,
        },
        [
          fakeOrderLine({
            id: "oi-std",
            qty: 10,
            boxes: null,
            pieces: null,
            unitsPerBox: null,
            unitPrice: 5,
            subtotal: 50,
          }),
          fakeOrderLine({
            id: "oi-reg",
            productId: "p-reg",
            qty: 4,
            boxes: null,
            pieces: null,
            unitsPerBox: null,
            unitPrice: 10,
            subtotal: 40,
            trackedCategoryId: "cat-reg",
            product: {
              name: "Cigarettes",
              unitsPerBox: null,
              trackedCategoryId: "cat-reg",
              trackedSubcategoryId: null,
            },
          }),
        ],
      );
      await service.createInvoiceFromOrder("ord-1");
      expect(db.invoicesOf("ord-1")).toHaveLength(2);

      db.line("oi-std").qty = 12;
      db.line("oi-std").subtotal = 60;
      db.orders.get("ord-1")!.subtotal = 100;
      db.orders.get("ord-1")!.total = 100;
      const res = await service.reconcileOrderDraftInvoice("ord-1", { basis: "order" });

      expect(res).not.toBe("partials");
      const invs = db.invoicesOf("ord-1");
      expect(invs.map((i) => Number(i.total))).toEqual([60, 40]);
      expect(sum(invs)).toBe(100);
      expect(mockLedger.writeSaleEntries).toHaveBeenCalled();
    });
  });
});
