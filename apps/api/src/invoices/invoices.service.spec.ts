/**
 * Unit tests for InvoicesService — covers RF-011, RF-012, RF-079.
 *
 * Tests use the standard createMockPrisma() helper so no real DB is needed.
 */

// Prevent Jest from traversing ESM-only dependencies
jest.mock("./invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://example.com/invoice.pdf"),
  })),
}));

import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, ConflictException } from "@nestjs/common";
import { InvoicesService } from "./invoices.service";
import { InvoicePdfService } from "./invoice-pdf.service";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { EmailService } from "../email/email.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { MessagingService } from "../messaging/messaging.service";
import { CheckStatus, InvoiceStatus, NotificationEvent } from "@prisma/client";

describe("InvoicesService", () => {
  let service: InvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;

  const mockGateway = {
    emitInvoiceUpdated: jest.fn(),
    emitOrderCreated: jest.fn(),
    emitOrderStatusChanged: jest.fn(),
    emitLowStock: jest.fn(),
    emitStopCompleted: jest.fn(),
    emitUrgentOrder: jest.fn(),
  };

  const mockEmailService = {
    sendInvoice: jest.fn().mockResolvedValue(undefined),
  };

  const mockSystemConfig = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
  };

  const mockMessaging = {
    notify: jest.fn().mockResolvedValue([]),
    notifyEvent: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    prisma = createMockPrisma();
    mockMessaging.notify.mockClear();
    mockMessaging.notifyEvent.mockClear();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvoicesService,
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: mockGateway },
        { provide: EmailService, useValue: mockEmailService },
        { provide: InvoicePdfService, useValue: { getOrGenerate: jest.fn() } },
        { provide: SystemConfigService, useValue: mockSystemConfig },
        {
          provide: RegulatedLedgerService,
          useValue: { writeSaleEntries: jest.fn(), reverseInvoiceEntries: jest.fn() },
        },
        {
          provide: AuthorizationGuardService,
          useValue: {
            assertAuthorizedOrThrow: jest.fn().mockResolvedValue(undefined),
            checkAuthorized: jest.fn().mockResolvedValue({ blocked: [] }),
          },
        },
        {
          provide: CreditNotesService,
          useValue: {
            autoApplyOldestCreditsInTx: jest
              .fn()
              .mockResolvedValue({ applied: 0, invoiceStatus: null }),
          },
        },
        { provide: MessagingService, useValue: mockMessaging },
      ],
    }).compile();

    service = module.get<InvoicesService>(InvoicesService);
  });

  // ─── RF-011: duplicate() must reject order-linked invoices ─────────────────

  describe("RF-011 — duplicate()", () => {
    it("should throw BadRequestException when invoice is linked to an order", async () => {
      prisma.invoice.findUnique.mockResolvedValue({
        id: "inv-1",
        orderId: "ord-1", // linked to an order
        customerId: "cust-1",
        invoiceNumber: "INV-2026-0001",
        status: InvoiceStatus.SENT,
        subtotal: 100,
        taxAmount: 10,
        discount: 0,
        shippingFee: 0,
        total: 110,
        notes: null,
        terms: null,
        items: [],
      });

      await expect(service.duplicate("inv-1")).rejects.toThrow(BadRequestException);
      await expect(service.duplicate("inv-1")).rejects.toThrow(/order-linked/i);
    });

    it("should succeed when invoice is NOT linked to an order", async () => {
      const baseInv = {
        id: "inv-2",
        orderId: null, // no order link — duplication is allowed
        customerId: "cust-1",
        invoiceNumber: "INV-2026-0002",
        status: InvoiceStatus.SENT,
        subtotal: 50,
        taxAmount: 5,
        discount: 0,
        shippingFee: 0,
        total: 55,
        notes: null,
        terms: null,
        items: [],
      };
      prisma.invoice.findUnique.mockResolvedValue(baseInv);
      prisma.invoice.findFirst.mockResolvedValue(null); // for nextInvoiceNumber
      prisma.invoice.create.mockResolvedValue({ ...baseInv, id: "inv-3" });

      const result = await service.duplicate("inv-2");
      expect(prisma.invoice.create).toHaveBeenCalled();
      expect(result.id).toBe("inv-3");
    });
  });

  // ─── RF-012: update() must recalculate total when discount/shippingFee change

  describe("RF-012 — update() total recalculation", () => {
    const draftInvoice = {
      id: "inv-10",
      orderId: null,
      customerId: "cust-1",
      invoiceNumber: "INV-2026-0010",
      status: InvoiceStatus.DRAFT,
      subtotal: 100,
      taxAmount: 10,
      discount: 0,
      shippingFee: 0,
      total: 110,
      notes: null,
      terms: null,
      dueDate: null,
      issueDate: new Date(),
    };

    const existingItems = [
      { subtotal: 60, taxRate: 0.1 },
      { subtotal: 40, taxRate: 0.1 },
    ];

    it("should recalculate total when discount changes", async () => {
      prisma.invoice.findUnique.mockResolvedValue(draftInvoice);
      prisma.invoiceItem.findMany.mockResolvedValue(existingItems);
      prisma.invoice.update.mockResolvedValue({
        ...draftInvoice,
        discount: 20,
        total: 100 - 20 + 0 + 10, // subtotal - discount + shipping + tax = 90
      });

      await service.update("inv-10", { discount: 20 });

      expect(prisma.invoice.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            discount: 20,
            total: expect.any(Number),
          }),
        }),
      );

      // Extract the total from the actual call and verify it
      const callData = prisma.invoice.update.mock.calls[0][0].data;
      // subtotal=100, discount=20, shippingFee=0, tax=10 → total = 90
      expect(callData.total).toBeCloseTo(90, 2);
    });

    it("should recalculate total when shippingFee changes", async () => {
      prisma.invoice.findUnique.mockResolvedValue(draftInvoice);
      prisma.invoiceItem.findMany.mockResolvedValue(existingItems);
      prisma.invoice.update.mockResolvedValue({ ...draftInvoice, shippingFee: 15, total: 125 });

      await service.update("inv-10", { shippingFee: 15 });

      const callData = prisma.invoice.update.mock.calls[0][0].data;
      // subtotal=100, discount=0, shippingFee=15, tax=10 → total = 125
      expect(callData.total).toBeCloseTo(125, 2);
    });

    it("should NOT recalculate when only notes change", async () => {
      prisma.invoice.findUnique.mockResolvedValue(draftInvoice);
      prisma.invoice.update.mockResolvedValue({ ...draftInvoice, notes: "Updated note" });

      await service.update("inv-10", { notes: "Updated note" });

      // invoiceItem.findMany should NOT be called (no recalc needed)
      expect(prisma.invoiceItem.findMany).not.toHaveBeenCalled();
      const callData = prisma.invoice.update.mock.calls[0][0].data;
      expect(callData.total).toBeUndefined();
    });
  });

  // ─── Boxed-line proration on update() — the invoice-edit over-charge fix ───
  // When the invoice EDIT page saves a boxed line it now forwards boxes/pieces so
  // update() prorates (unitPrice is the BOX price). Regression guard against the
  // old bug where dropping boxes/pieces made the server charge unitPrice * qty
  // (qty being the piece count → a unitsPerBox-fold over-charge).

  describe("update() — boxed line proration", () => {
    const draftInvoice = {
      id: "inv-box",
      orderId: null,
      deliveryBatchId: null,
      customerId: "cust-1",
      invoiceNumber: "INV-2026-0099",
      status: InvoiceStatus.DRAFT,
      subtotal: 0,
      taxAmount: 0,
      discount: 0,
      shippingFee: 0,
      total: 0,
      notes: null,
      terms: null,
      dueDate: null,
      issueDate: new Date(),
    };

    it("prorates a boxed line by unitsPerBox instead of charging unitPrice*qty", async () => {
      prisma.invoice.findUnique.mockResolvedValue(draftInvoice);
      prisma.product.findMany.mockResolvedValue([{ id: "prod-box", unitsPerBox: 12 }]);
      prisma.customer.findUnique.mockResolvedValue({ isTaxExempt: false });
      prisma.invoice.update.mockResolvedValue(draftInvoice);

      // 2 boxes + 3 loose pieces of a 12-per-box product at $28.35 per BOX.
      await service.update("inv-box", {
        items: [
          {
            productId: "prod-box",
            description: "Boxed chips",
            qty: 27, // total pieces = 2*12 + 3
            unitPrice: 28.35,
            boxes: 2,
            pieces: 3,
          },
        ],
      });

      const created = prisma.invoice.update.mock.calls[0][0].data.items.create[0];
      // Correct proration: 28.35 * (2 + 3/12) = 28.35 * 2.25 = 63.7875 → 63.79
      expect(created.subtotal).toBeCloseTo(63.79, 2);
      // Regression guard: NOT the qty*unitPrice over-charge (28.35 * 27 = 765.45).
      expect(created.subtotal).not.toBeCloseTo(765.45, 2);
      expect(created.boxes).toBe(2);
      expect(created.pieces).toBe(3);
      expect(created.qty).toBe(27);
    });

    it("charges unitPrice*qty for a non-boxed line (no boxes/pieces sent)", async () => {
      prisma.invoice.findUnique.mockResolvedValue(draftInvoice);
      prisma.product.findMany.mockResolvedValue([]);
      prisma.customer.findUnique.mockResolvedValue({ isTaxExempt: false });
      prisma.invoice.update.mockResolvedValue(draftInvoice);

      await service.update("inv-box", {
        items: [{ productId: "prod-plain", description: "Loose", qty: 5, unitPrice: 3.5 }],
      });

      const created = prisma.invoice.update.mock.calls[0][0].data.items.create[0];
      expect(created.subtotal).toBeCloseTo(17.5, 2); // 3.5 * 5
      expect(created.boxes).toBeNull();
      expect(created.pieces).toBeNull();
    });

    it("round-trips per-line notes through the delete-and-recreate edit (no silent wipe)", async () => {
      prisma.invoice.findUnique.mockResolvedValue(draftInvoice);
      prisma.product.findMany.mockResolvedValue([]);
      prisma.customer.findUnique.mockResolvedValue({ isTaxExempt: false });
      prisma.invoice.update.mockResolvedValue(draftInvoice);

      await service.update("inv-box", {
        items: [
          {
            productId: "prod-plain",
            description: "Loose",
            qty: 5,
            unitPrice: 3.5,
            notes: "No ice, deliver chilled",
          },
          { productId: "prod-2", description: "Other", qty: 1, unitPrice: 1 },
        ],
      });

      const created = prisma.invoice.update.mock.calls[0][0].data.items.create;
      expect(created[0].notes).toBe("No ice, deliver chilled");
      expect(created[1].notes).toBeNull();
    });
  });

  // ─── RF-079: tax-exempt customer → invoice tax = 0 ────────────────────────

  describe("RF-079 — tax-exempt customer", () => {
    it("should set taxAmount to 0 for a tax-exempt customer in create()", async () => {
      const taxExemptCustomer = {
        id: "cust-exempt",
        businessName: "Exempt Corp",
        isTaxExempt: true,
      };
      prisma.customer.findUnique.mockResolvedValue(taxExemptCustomer);
      prisma.product.findMany.mockResolvedValue([]);
      prisma.invoice.findFirst.mockResolvedValue(null); // for invoice number generation
      // tenantConfig is not in mock — mock resolveTenantInvoiceDefaults directly
      jest.spyOn(service as any, "resolveTenantInvoiceDefaults").mockResolvedValue({
        notes: null,
        terms: null,
      });
      prisma.invoice.create.mockResolvedValue({
        id: "inv-exempt",
        taxAmount: 0,
        total: 100,
        customer: taxExemptCustomer,
        items: [],
        payments: [],
      });

      const result = await service.create({
        customerId: "cust-exempt",
        items: [
          {
            description: "Widget",
            qty: 10,
            unitPrice: 10,
            taxRate: 0.1, // normally 10% tax, but customer is exempt
          },
        ],
      } as any);

      // Invoice create must have been called with taxAmount = 0
      const createCall = prisma.invoice.create.mock.calls[0][0];
      expect(createCall.data.taxAmount).toBe(0);
    });
  });

  // ─── Pending-mirror reconcile ──────────────────────────────────────────────

  describe("reconcileOrderDraftInvoice", () => {
    const order = {
      id: "o1",
      customerId: "c1",
      subtotal: 50,
      tax: 5,
      lineItems: [
        {
          id: "li1",
          productId: "p1",
          qty: 10,
          deliveredQty: 8,
          unitPrice: 5,
          originalPrice: null,
          priceType: "STANDARD",
          product: { name: "P1" },
          status: "PENDING",
        },
      ],
    };

    function armReconcile() {
      prisma.invoice.findFirst.mockResolvedValue({ id: "d1", discount: 0, shippingFee: 0 });
      prisma.order.findUnique.mockResolvedValue(order);
      prisma.customer.findUnique.mockResolvedValue({ isTaxExempt: false });
      prisma.invoiceItem.deleteMany.mockResolvedValue({});
      prisma.invoice.update.mockResolvedValue({ id: "d1", status: InvoiceStatus.DRAFT });
      prisma.orderItem.findMany.mockResolvedValue([{ id: "li1" }]);
      prisma.orderItem.update.mockResolvedValue({});
    }

    it("returns null and does nothing when there is no open draft", async () => {
      prisma.invoice.findFirst.mockResolvedValue(null);
      const res = await service.reconcileOrderDraftInvoice("o1", { basis: "order" });
      expect(res).toBeNull();
      expect(prisma.invoice.update).not.toHaveBeenCalled();
    });

    it("basis=order bills full qty, stays DRAFT, sets invoicedQty to full qty", async () => {
      armReconcile();
      await service.reconcileOrderDraftInvoice("o1", { basis: "order" });
      const data = prisma.invoice.update.mock.calls[0][0].data;
      expect(data.status).toBe(InvoiceStatus.DRAFT);
      expect(data.items.create[0].qty).toBe(10);
      expect(data.subtotal).toBeCloseTo(50, 2);
      expect(prisma.orderItem.update).toHaveBeenCalledWith({
        where: { id: "li1" },
        data: { invoicedQty: 10 },
      });
    });

    it("basis=delivered bills delivered qty and sets invoicedQty to delivered", async () => {
      armReconcile();
      await service.reconcileOrderDraftInvoice("o1", { basis: "delivered" });
      const data = prisma.invoice.update.mock.calls[0][0].data;
      expect(data.items.create[0].qty).toBe(8);
      expect(data.subtotal).toBeCloseTo(40, 2);
      expect(prisma.orderItem.update).toHaveBeenCalledWith({
        where: { id: "li1" },
        data: { invoicedQty: 8 },
      });
    });

    it("carries the order line's per-line note onto the invoice line verbatim", async () => {
      armReconcile();
      prisma.order.findUnique.mockResolvedValue({
        ...order,
        lineItems: [
          { ...order.lineItems[0], notes: "No ice, deliver chilled" },
          { ...order.lineItems[0], id: "li-plain", notes: null },
        ],
      });
      prisma.orderItem.findMany.mockResolvedValue([{ id: "li1" }, { id: "li-plain" }]);

      await service.reconcileOrderDraftInvoice("o1", { basis: "order" });
      const created = prisma.invoice.update.mock.calls[0][0].data.items.create;
      expect(created[0].notes).toBe("No ice, deliver chilled");
      expect(created[1].notes).toBeNull();
    });

    // Regression: a one-time price override (list 100 → net 90) is stored on the
    // order line as unitPrice=90 + originalPrice=100. The invoice line must NOT
    // re-encode that as a discount, or the override double-counts to bill 80×qty.
    it("does NOT double-count a price override: net unitPrice, discount 0, subtotal = net×qty", async () => {
      const overridden = {
        id: "o2",
        customerId: "c1",
        subtotal: 450,
        tax: 0,
        lineItems: [
          {
            id: "li2",
            productId: "p2",
            qty: 5,
            deliveredQty: 5,
            unitPrice: 90, // net (post-override) price
            originalPrice: 100, // list price — drives the strikethrough only
            priceType: "DISCOUNTED",
            product: { name: "P2", unitsPerBox: 0 },
            status: "PENDING",
          },
        ],
      };
      prisma.invoice.findFirst.mockResolvedValue({ id: "d2", discount: 0, shippingFee: 0 });
      prisma.order.findUnique.mockResolvedValue(overridden);
      prisma.customer.findUnique.mockResolvedValue({ isTaxExempt: false });
      prisma.invoiceItem.deleteMany.mockResolvedValue({});
      prisma.invoice.update.mockResolvedValue({ id: "d2", status: InvoiceStatus.DRAFT });
      prisma.orderItem.findMany.mockResolvedValue([{ id: "li2" }]);
      prisma.orderItem.update.mockResolvedValue({});

      await service.reconcileOrderDraftInvoice("o2", { basis: "order" });

      const line = prisma.invoice.update.mock.calls[0][0].data.items.create[0];
      expect(line.unitPrice).toBe(90);
      expect(line.discount).toBe(0); // not 10 — the override is already in unitPrice
      expect(line.originalPrice).toBe(100);
      expect(line.subtotal).toBeCloseTo(450, 2); // 90 × 5, NOT (90 − 10) × 5 = 400
    });

    // Symmetric guard for the UPSELL direction (list 100 → net 110). The invoice
    // must bill the higher net verbatim with discount 0 — an upsell is not a
    // "negative discount", and the base rides only as display metadata.
    it("does NOT double-count an UPSELL: net unitPrice above list, discount 0, subtotal = net×qty", async () => {
      const upsold = {
        id: "o3",
        customerId: "c1",
        subtotal: 550,
        tax: 0,
        lineItems: [
          {
            id: "li3",
            productId: "p3",
            qty: 5,
            deliveredQty: 5,
            unitPrice: 110, // net (post-upsell) price, ABOVE list
            originalPrice: 100, // list base — hidden from the customer downstream
            priceType: "MANUAL",
            product: { name: "P3", unitsPerBox: 0 },
            status: "PENDING",
          },
        ],
      };
      prisma.invoice.findFirst.mockResolvedValue({ id: "d3", discount: 0, shippingFee: 0 });
      prisma.order.findUnique.mockResolvedValue(upsold);
      prisma.customer.findUnique.mockResolvedValue({ isTaxExempt: false });
      prisma.invoiceItem.deleteMany.mockResolvedValue({});
      prisma.invoice.update.mockResolvedValue({ id: "d3", status: InvoiceStatus.DRAFT });
      prisma.orderItem.findMany.mockResolvedValue([{ id: "li3" }]);
      prisma.orderItem.update.mockResolvedValue({});

      await service.reconcileOrderDraftInvoice("o3", { basis: "order" });

      const line = prisma.invoice.update.mock.calls[0][0].data.items.create[0];
      expect(line.unitPrice).toBe(110);
      expect(line.discount).toBe(0); // an upsell is NOT a negative discount
      expect(line.originalPrice).toBe(100);
      expect(line.subtotal).toBeCloseTo(550, 2); // 110 × 5
    });
  });

  // ─── send(): invoice-after-delivery gating ─────────────────────────────────

  describe("send() — pending-mirror gating", () => {
    it("blocks an order-linked DRAFT before the order is delivered", async () => {
      prisma.invoice.findUnique.mockResolvedValue({
        id: "i1",
        orderId: "o1",
        status: InvoiceStatus.DRAFT,
        deliveryBatchId: null,
      });
      prisma.order.findUnique.mockResolvedValue({ status: "PENDING", orderNumber: "O1" });
      await expect(service.send("i1")).rejects.toThrow(BadRequestException);
      expect(prisma.invoice.update).not.toHaveBeenCalled();
    });

    it("allows sending once the order is delivered", async () => {
      prisma.invoice.findUnique.mockResolvedValue({
        id: "i1",
        orderId: "o1",
        status: InvoiceStatus.DRAFT,
        deliveryBatchId: null,
      });
      prisma.order.findUnique.mockResolvedValue({ status: "DELIVERED", orderNumber: "O1" });
      prisma.invoice.update.mockResolvedValue({
        id: "i1",
        invoiceNumber: "INV-1",
        customerId: "c1",
        status: InvoiceStatus.SENT,
        total: 10,
      });
      await expect(service.send("i1")).resolves.toBeDefined();
    });

    it("allows a standalone (no-order) invoice without checking an order", async () => {
      prisma.invoice.findUnique.mockResolvedValue({
        id: "i1",
        orderId: null,
        status: InvoiceStatus.DRAFT,
        deliveryBatchId: null,
      });
      prisma.invoice.update.mockResolvedValue({
        id: "i1",
        invoiceNumber: "INV-1",
        customerId: "c1",
        status: InvoiceStatus.SENT,
        total: 10,
      });
      await expect(service.send("i1")).resolves.toBeDefined();
      expect(prisma.order.findUnique).not.toHaveBeenCalled();
    });

    it("fires INVOICE_SENT once on the DRAFT→SENT flip", async () => {
      prisma.invoice.findUnique.mockResolvedValue({
        id: "i1",
        orderId: null,
        status: InvoiceStatus.DRAFT,
        deliveryBatchId: null,
      });
      prisma.invoice.update.mockResolvedValue({
        id: "i1",
        invoiceNumber: "INV-1",
        customerId: "c1",
        status: InvoiceStatus.SENT,
        total: 10,
        dueDate: null,
      });
      await service.send("i1");
      expect(mockMessaging.notifyEvent).toHaveBeenCalledTimes(1);
      expect(mockMessaging.notifyEvent).toHaveBeenCalledWith(NotificationEvent.INVOICE_SENT, {
        customerId: "c1",
        senderId: null,
        vars: { invoiceNumber: "INV-1", invoiceTotal: "$10.00", dueDate: "" },
      });
    });

    it("does not re-fire INVOICE_SENT when the invoice is already SENT", async () => {
      prisma.invoice.findUnique.mockResolvedValue({
        id: "i1",
        orderId: null,
        status: InvoiceStatus.SENT,
        deliveryBatchId: null,
      });
      prisma.invoice.update.mockResolvedValue({
        id: "i1",
        invoiceNumber: "INV-1",
        customerId: "c1",
        status: InvoiceStatus.SENT,
        total: 10,
        dueDate: null,
      });
      await service.send("i1");
      expect(mockMessaging.notifyEvent).not.toHaveBeenCalled();
    });
  });

  // ─── Backward sync: recomputeOrderFromInvoices ─────────────────────────────

  describe("recomputeOrderFromInvoices — backward sync (issue 2)", () => {
    it("rebuilds the order from the SUM of all its non-void invoices", async () => {
      // Two invoices each bill 1 unit of p1 @ 220 → order should show qty 2, $440.
      prisma.order.findUnique.mockResolvedValue({
        id: "o1",
        subtotal: 100, // prior values — used to derive effective tax rate (10%)
        tax: 10,
        lineItems: [{ id: "li1", productId: "p1" }],
      });
      prisma.invoice.findMany.mockResolvedValue([
        {
          id: "a",
          status: InvoiceStatus.SENT,
          items: [{ productId: "p1", qty: 1, subtotal: 220, unitPrice: 220 }],
        },
        {
          id: "b",
          status: InvoiceStatus.DRAFT,
          items: [{ productId: "p1", qty: 1, subtotal: 220, unitPrice: 220 }],
        },
      ]);
      prisma.product.findMany.mockResolvedValue([{ id: "p1", unitsPerBox: 0 }]);
      prisma.orderItem.update.mockResolvedValue({});
      prisma.order.update.mockResolvedValue({});

      const res = await service.recomputeOrderFromInvoices("o1");

      // Order line synced to the aggregate.
      expect(prisma.orderItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "li1" },
          data: expect.objectContaining({ qty: 2, subtotal: 440, invoicedQty: 2 }),
        }),
      );
      // Order totals: subtotal 440, tax = 440 * (10/100) = 44, total 484.
      const data = prisma.order.update.mock.calls[0][0].data;
      expect(data.subtotal).toBeCloseTo(440, 2);
      expect(data.tax).toBeCloseTo(44, 2);
      expect(data.total).toBeCloseTo(484, 2);
      expect(res).toMatchObject({ subtotal: 440, total: 484 });
    });

    it("re-derives a box-split line's split from the SNAPSHOT upb (never the live product)", async () => {
      // The order line is genuinely box-split and carries its own unitsPerBox
      // snapshot (11). Recompute preserves that denomination and re-derives the
      // split from the aggregated billed qty — it does NOT consult the live product.
      prisma.order.findUnique.mockResolvedValue({
        id: "o1",
        subtotal: 100,
        tax: 0,
        lineItems: [{ id: "li1", productId: "p1", boxes: 2, pieces: 0, unitsPerBox: 11 }],
      });
      prisma.invoice.findMany.mockResolvedValue([
        {
          id: "a",
          status: InvoiceStatus.SENT,
          items: [{ productId: "p1", orderItemId: "li1", qty: 22, subtotal: 440, unitPrice: 220 }],
        },
      ]);
      prisma.orderItem.update.mockResolvedValue({});
      prisma.order.update.mockResolvedValue({});

      await service.recomputeOrderFromInvoices("o1");

      expect(prisma.orderItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            qty: 22,
            boxes: 2,
            pieces: 0,
            unitsPerBox: 11,
            subtotal: 440,
          }),
        }),
      );
    });

    it("preserves a selling-unit line's denomination (never manufactures a phantom split)", async () => {
      // Order line is selling-unit (boxes null). Even though the invoice item's qty
      // could be re-split by some live upb, recompute must keep boxes null.
      prisma.order.findUnique.mockResolvedValue({
        id: "o1",
        subtotal: 100,
        tax: 0,
        lineItems: [{ id: "li1", productId: "p1", boxes: null, pieces: null }],
      });
      prisma.invoice.findMany.mockResolvedValue([
        {
          id: "a",
          status: InvoiceStatus.SENT,
          items: [{ productId: "p1", orderItemId: "li1", qty: 4, subtotal: 80, unitPrice: 20 }],
        },
      ]);
      prisma.orderItem.update.mockResolvedValue({});
      prisma.order.update.mockResolvedValue({});

      await service.recomputeOrderFromInvoices("o1");

      expect(prisma.orderItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ qty: 4, boxes: null, pieces: null, subtotal: 80 }),
        }),
      );
    });

    it("is a no-op when the order has no surviving (non-void) invoices", async () => {
      prisma.order.findUnique.mockResolvedValue({
        id: "o1",
        subtotal: 100,
        tax: 10,
        lineItems: [{ id: "li1", productId: "p1" }],
      });
      prisma.invoice.findMany.mockResolvedValue([]);

      const res = await service.recomputeOrderFromInvoices("o1");
      expect(res).toBeNull();
      expect(prisma.order.update).not.toHaveBeenCalled();
      expect(prisma.orderItem.update).not.toHaveBeenCalled();
    });
  });

  // ─── Unlisted lines + carrier shipment ──────────────────────────────────────

  describe("createInvoiceFromOrder — unlisted lines + shipment copy", () => {
    it("uses the line name as description for unlisted items and copies order shipment", async () => {
      jest
        .spyOn(service as any, "resolveDefaultTerms")
        .mockResolvedValue({ terms: "Net 30", dueDays: 30 });
      jest
        .spyOn(service as any, "resolveTenantInvoiceDefaults")
        .mockResolvedValue({ notes: null, terms: null });
      jest.spyOn(service as any, "generateInvoiceNumber").mockResolvedValue("INV-1");

      prisma.order.findUnique.mockResolvedValue({
        id: "ord-1",
        customerId: "cust-1",
        orderNumber: "ORD-9",
        subtotal: 30,
        tax: 0,
        shippingCarrier: "UPS",
        shippingTrackingNumber: "1Z999",
        shippedAt: new Date("2026-06-20"),
        lineItems: [
          {
            id: "li-cat",
            productId: "p1",
            name: null,
            qty: 2,
            invoicedQty: 0,
            unitPrice: 10,
            originalPrice: null,
            priceType: "STANDARD",
            product: { name: "Widget", unitsPerBox: 0 },
          },
          {
            id: "li-unl",
            productId: null,
            name: "Rush fee",
            qty: 1,
            invoicedQty: 0,
            unitPrice: 10,
            originalPrice: null,
            priceType: "MANUAL",
            product: null,
          },
        ],
      });
      prisma.customer.findUnique.mockResolvedValue({ isTaxExempt: false });
      prisma.invoice.create.mockResolvedValue({
        id: "inv-1",
        items: [],
        payments: [],
        customer: {},
      });

      await service.createInvoiceFromOrder("ord-1");

      const createCall = prisma.invoice.create.mock.calls[0][0] as any;
      // Shipment is carried from the order onto the invoice.
      expect(createCall.data.shippingCarrier).toBe("UPS");
      expect(createCall.data.shippingTrackingNumber).toBe("1Z999");
      // Unlisted line uses its free-text name as the invoice line description.
      const descriptions = createCall.data.items.create.map((i: any) => i.description);
      expect(descriptions).toContain("Rush fee");
      expect(descriptions).toContain("Widget");
    });
  });

  describe("createInvoiceFromOrder — regulated category split (W4)", () => {
    const setupSplitSpies = () => {
      jest
        .spyOn(service as any, "resolveDefaultTerms")
        .mockResolvedValue({ terms: "Net 30", dueDays: 30 });
      jest
        .spyOn(service as any, "resolveTenantInvoiceDefaults")
        .mockResolvedValue({ notes: null, terms: null });
      jest.spyOn(service as any, "generateInvoiceNumber").mockResolvedValue("INV-2026-0042");
      prisma.customer.findUnique.mockResolvedValue({ isTaxExempt: false });
      // Echo the create data back so we can assert numbers / numbering / groupId.
      prisma.invoice.create.mockImplementation((args: any) =>
        Promise.resolve({ ...args.data, items: [], payments: [], customer: {} }),
      );
    };
    const line = (id: string, catId: string | null, name: string) => ({
      id,
      productId: `p-${id}`,
      qty: id === "std" ? 2 : 1,
      invoicedQty: 0,
      unitPrice: 10,
      priceType: "STANDARD",
      trackedCategoryId: catId,
      categoryTaxAmount: 0,
      product: { name, unitsPerBox: 0, trackedCategoryId: catId },
    });

    it("splits a standard + tobacco order into two siblings sharing invoiceGroupId, tax preserved", async () => {
      setupSplitSpies();
      prisma.trackedCategory.findMany.mockResolvedValue([
        {
          id: "cat-tob",
          name: "Tobacco",
          invoiceTreatment: "SEPARATE_INVOICE",
          taxType: "NONE",
          rate: 0,
        },
      ]);
      prisma.order.findUnique.mockResolvedValue({
        id: "ord-1",
        customerId: "cust-1",
        orderNumber: "ORD-9",
        subtotal: 30,
        tax: 3,
        lineItems: [line("std", null, "Widget"), line("tob", "cat-tob", "Cigarillos")],
      });

      const result = await service.createInvoiceFromOrder("ord-1");
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(2);
      const [primary, sibling] = result as any[];
      expect(primary.invoiceNumber).toBe("INV-2026-0042");
      expect(sibling.invoiceNumber).toBe("INV-2026-0042-R1");
      expect(primary.invoiceGroupId).toBeTruthy();
      expect(primary.invoiceGroupId).toBe(sibling.invoiceGroupId);
      // Standard group $20, tobacco group $10; siblings partition the subtotal.
      expect(Number(primary.subtotal)).toBe(20);
      expect(Number(sibling.subtotal)).toBe(10);
      // INVARIANT: siblings' totals sum == single-invoice total ($30 + $3 tax = $33).
      expect(Number(primary.total) + Number(sibling.total)).toBe(33);
      // Regular tax $3 allocated proportionally 20:10 → $2 + $1.
      expect(Number(primary.taxAmount) + Number(sibling.taxAmount)).toBe(3);
      expect(Number(primary.taxAmount)).toBe(2);
      expect(Number(sibling.taxAmount)).toBe(1);
      // invoicedQty bumped exactly once per line.
      expect(prisma.orderItem.update).toHaveBeenCalledTimes(2);
    });

    it("produces a single invoice with no groupId for a non-regulated order (byte-identical path)", async () => {
      setupSplitSpies();
      prisma.trackedCategory.findMany.mockResolvedValue([]);
      prisma.order.findUnique.mockResolvedValue({
        id: "ord-2",
        customerId: "cust-1",
        orderNumber: "ORD-10",
        subtotal: 20,
        tax: 2,
        lineItems: [line("std", null, "Widget")],
      });

      const result = (await service.createInvoiceFromOrder("ord-2")) as any[];
      expect(result).toHaveLength(1);
      expect(result[0].invoiceNumber).toBe("INV-2026-0042");
      expect(result[0].invoiceGroupId ?? null).toBeNull();
      expect(Number(result[0].total)).toBe(22);
    });

    it("never produces a negative sibling tax when a tiny group trails (3 groups)", async () => {
      setupSplitSpies();
      prisma.trackedCategory.findMany.mockResolvedValue([
        {
          id: "cat-a",
          name: "Alcohol",
          invoiceTreatment: "SEPARATE_INVOICE",
          taxType: "NONE",
          rate: 0,
        },
        {
          id: "cat-b",
          name: "CRV",
          invoiceTreatment: "SEPARATE_INVOICE",
          taxType: "NONE",
          rate: 0,
        },
      ]);
      const mkLine = (id: string, catId: string | null, unitPrice: number) => ({
        id,
        productId: `p-${id}`,
        qty: 1,
        invoicedQty: 0,
        unitPrice,
        priceType: "STANDARD",
        trackedCategoryId: catId,
        categoryTaxAmount: 0,
        product: { name: id, unitsPerBox: 0, trackedCategoryId: catId },
      });
      // Partial invoicing (remaining 362.75 < order subtotal 391.10) + a $0.02
      // trailing group: the old "last group absorbs the remainder" made its tax -0.01.
      prisma.order.findUnique.mockResolvedValue({
        id: "ord-4",
        customerId: "cust-1",
        orderNumber: "ORD-12",
        subtotal: 391.1,
        tax: 19.56,
        lineItems: [
          mkLine("std", null, 219.25),
          mkLine("a", "cat-a", 143.48),
          mkLine("b", "cat-b", 0.02),
        ],
      });

      const result = (await service.createInvoiceFromOrder("ord-4")) as any[];
      expect(result).toHaveLength(3);
      for (const inv of result) expect(Number(inv.taxAmount)).toBeGreaterThanOrEqual(0);
      // Σ sibling tax == the single-invoice regular tax (19.56 × 362.75/391.10 = 18.14).
      const taxSum = result.reduce((s, inv) => s + Number(inv.taxAmount), 0);
      expect(Number(taxSum.toFixed(2))).toBe(18.14);
    });

    it("blocks invoicing a category with a non-zero rate (interim guard)", async () => {
      setupSplitSpies();
      prisma.trackedCategory.findMany.mockResolvedValue([
        {
          id: "cat-alc",
          name: "Alcohol",
          invoiceTreatment: "SEPARATE_INVOICE",
          taxType: "EXCISE_PER_UNIT",
          rate: 2.5,
        },
      ]);
      prisma.order.findUnique.mockResolvedValue({
        id: "ord-3",
        customerId: "cust-1",
        orderNumber: "ORD-11",
        subtotal: 10,
        tax: 0,
        lineItems: [line("alc", "cat-alc", "Beer")],
      });

      await expect(service.createInvoiceFromOrder("ord-3")).rejects.toThrow(/non-zero tax rate/);
    });

    it("W6b backstop: blocks invoicing when the customer's license guard rejects", async () => {
      setupSplitSpies();
      prisma.trackedCategory.findMany.mockResolvedValue([
        {
          id: "cat-tob",
          name: "Tobacco",
          invoiceTreatment: "SEPARATE_INVOICE",
          taxType: "NONE",
          rate: 0,
        },
      ]);
      prisma.order.findUnique.mockResolvedValue({
        id: "ord-5",
        customerId: "cust-1",
        orderNumber: "ORD-13",
        subtotal: 10,
        tax: 0,
        lineItems: [line("tob", "cat-tob", "Cigarillos")],
      });
      // License expired between order and invoice → guard rejects at invoice time.
      (service as any).authGuard.assertAuthorizedOrThrow.mockRejectedValueOnce(
        new ConflictException({ code: "REGULATED_AUTH_REQUIRED", blockedCategories: [] }),
      );

      await expect(service.createInvoiceFromOrder("ord-5")).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.invoice.create).not.toHaveBeenCalled(); // blocked before any invoice row
    });
  });

  describe("updateInvoiceShipment", () => {
    it("sets carrier + tracking + shippedAt on a non-void invoice", async () => {
      prisma.invoice.findUnique.mockResolvedValue({ id: "inv-1", status: "SENT", shippedAt: null });
      prisma.invoice.update.mockResolvedValue({ id: "inv-1" });

      await service.updateInvoiceShipment("inv-1", {
        shippingCarrier: "FedEx",
        shippingTrackingNumber: "123456789012",
      });

      expect(prisma.invoice.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "inv-1" },
          data: expect.objectContaining({
            shippingCarrier: "FedEx",
            shippingTrackingNumber: "123456789012",
            shippedAt: expect.any(Date),
          }),
        }),
      );
    });

    it("refuses to update a voided invoice", async () => {
      prisma.invoice.findUnique.mockResolvedValue({ id: "inv-1", status: "VOID", shippedAt: null });
      await expect(
        service.updateInvoiceShipment("inv-1", { shippingTrackingNumber: "X" }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ── buildInvoiceItemData: copy-don't-recompute (order↔invoice divergence) ──────
  // Regression guard for the prod bug where an invoice line showed the per-unit
  // (box) price as the whole line total: the builder re-derived the box/piece split
  // from the billed qty and the LIVE product.unitsPerBox instead of copying the
  // order line's stored money + denomination. buildInvoiceItemData is pure, so we
  // exercise it directly.
  describe("buildInvoiceItemData (order line → invoice line)", () => {
    const build = (li: any, billQty: number, opts?: { priorBilledQty?: number }) =>
      (service as any).buildInvoiceItemData(li, billQty, "test-tenant", opts);

    it("copies a selling-unit line verbatim even when the live product is now boxed (the 246-vs-426 bug)", () => {
      // Order line: 4 selling units @ $20 = $80, boxes=null (box-UNAWARE create).
      // Live product later became unitsPerBox=4. The OLD code re-split qty=4 with
      // upb=4 → 1 box → $20 (per-box price as the whole line). We must copy $80.
      const li = {
        id: "oi-1",
        productId: "p-1",
        qty: 4,
        boxes: null,
        pieces: null,
        unitsPerBox: null, // no snapshot (selling-unit line)
        unitPrice: 20,
        subtotal: 80,
        product: { name: "Astro Eight Kit", unitsPerBox: 4 }, // live upb changed
      };
      const line = build(li, 4);
      expect(line.subtotal).toBe(80);
      expect(line.boxes).toBeNull();
      expect(line.pieces).toBeNull();
      expect(line.qty).toBe(4);
      expect(line.orderItemId).toBe("oi-1");
    });

    it("copies a box-split line verbatim and carries its split + snapshot upb", () => {
      // 2 boxes of 6 @ $43.75/box = $87.50, stored as boxes=2/pieces=0/qty=12.
      const li = {
        id: "oi-2",
        productId: "p-2",
        qty: 12,
        boxes: 2,
        pieces: 0,
        unitsPerBox: 6,
        unitPrice: 43.75,
        subtotal: 87.5,
        product: { name: "Boxed", unitsPerBox: 6 },
      };
      const line = build(li, 12);
      expect(line.subtotal).toBe(87.5);
      expect(line.boxes).toBe(2);
      expect(line.pieces).toBe(0);
      expect(line.unitsPerBox).toBe(6);
    });

    it("copies the stored subtotal exactly on a full bill instead of re-deriving qty×unitPrice (rounding drift)", () => {
      // 24 pieces, true price $35.00 total (unitPrice rounds to $1.46). OLD code
      // billed 24 × 1.46 = 35.04. Copy the stored 35.00.
      const li = {
        id: "oi-3",
        productId: "p-3",
        qty: 24,
        boxes: null,
        pieces: null,
        unitsPerBox: null,
        unitPrice: 1.46,
        subtotal: 35.0,
        product: { name: "Pills", unitsPerBox: null },
      };
      expect(build(li, 24).subtotal).toBe(35.0);
    });

    it("prorates a partial bill and telescopes to exactly the stored subtotal across partials", () => {
      // qty 3 @ stored $10.00, billed 1 + 1 + 1. Naive round(10/3) three times = 9.99.
      const li = {
        id: "oi-4",
        productId: "p-4",
        qty: 3,
        boxes: null,
        pieces: null,
        unitsPerBox: null,
        unitPrice: 3.33,
        subtotal: 10.0,
        product: { name: "Thirds", unitsPerBox: null },
      };
      const b1 = build(li, 1, { priorBilledQty: 0 }).subtotal;
      const b2 = build(li, 1, { priorBilledQty: 1 }).subtotal;
      const b3 = build(li, 1, { priorBilledQty: 2 }).subtotal;
      expect(b1 + b2 + b3).toBeCloseTo(10.0, 5);
      expect(b1).toBe(3.33);
      expect(b2).toBe(3.34);
      expect(b3).toBe(3.33);
    });

    it("falls back to the shared helper (using the STORED split) when the order line has no stored subtotal", () => {
      // 2 boxes of 6 = 12 pieces, $40/box, no stored subtotal (legacy row).
      const li = {
        id: "oi-5",
        productId: "p-5",
        qty: 12,
        boxes: 2,
        pieces: 0,
        unitsPerBox: 6,
        unitPrice: 40,
        subtotal: null, // legacy row, no money
        product: { name: "Legacy", unitsPerBox: 6 },
      };
      // billing all 12 pieces → 2 boxes @ $40 = $80 via computeLineSubtotal.
      expect(build(li, 12).subtotal).toBe(80);
    });
  });

  // ── Auto-revert a SENT pending-mirror invoice when its order is edited ──────────
  describe("revertLinkedInvoicesForOrderEdit", () => {
    it("reverts an unpaid SENT pending-mirror invoice to DRAFT (auto-revert on edit)", async () => {
      prisma.invoice.findMany.mockResolvedValue([
        { id: "inv-1", invoiceNumber: "INV-1", internalNotes: null },
      ]);
      prisma.invoicePayment.count.mockResolvedValue(0);
      prisma.invoice.update.mockResolvedValue({ id: "inv-1", status: "DRAFT" });

      const reverted = await service.revertLinkedInvoicesForOrderEdit("ord-1");

      expect(reverted).toEqual(["inv-1"]);
      expect(prisma.invoice.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "inv-1" },
          data: expect.objectContaining({ status: "DRAFT", sentAt: null, pdfUrl: null }),
        }),
      );
    });

    it("blocks the edit (throws) when a linked invoice has payments — money never detaches", async () => {
      prisma.invoice.findMany.mockResolvedValue([
        { id: "inv-1", invoiceNumber: "INV-1", internalNotes: null },
      ]);
      prisma.invoicePayment.count.mockResolvedValue(1);

      await expect(service.revertLinkedInvoicesForOrderEdit("ord-1")).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.invoice.update).not.toHaveBeenCalled();
    });

    it("is a no-op when the order has no SENT pending-mirror invoice", async () => {
      prisma.invoice.findMany.mockResolvedValue([]);
      const reverted = await service.revertLinkedInvoicesForOrderEdit("ord-1");
      expect(reverted).toEqual([]);
      expect(prisma.invoice.update).not.toHaveBeenCalled();
    });
  });

  describe("unvoidInvoice restores invoicedQty", () => {
    it("re-claims each line's invoicedQty (capped at line qty) when unvoiding", async () => {
      prisma.invoice.findUnique.mockResolvedValue({
        id: "inv-1",
        status: "VOID",
        orderId: "ord-1",
      });
      prisma.invoice.update.mockResolvedValue({ id: "inv-1", status: "DRAFT" });
      prisma.invoiceItem.findMany.mockResolvedValue([
        { productId: "p1", qty: 4, orderItemId: "oi-1" },
      ]);
      prisma.orderItem.findMany.mockResolvedValue([
        { id: "oi-1", productId: "p1", qty: 10, invoicedQty: 0 },
      ]);
      prisma.orderItem.update.mockResolvedValue({});

      await service.unvoidInvoice("inv-1");

      expect(prisma.orderItem.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "oi-1" }, data: { invoicedQty: 4 } }),
      );
    });
  });

  // ─── P5-12: check lifecycle (Recorded→Deposited→Cleared→Bounced) ───────────

  describe("P5-12 — setCheckStatus", () => {
    const basePayment = {
      id: "pay-1",
      invoiceId: "inv-1",
      method: "CHECK",
      status: "PAID",
      checkStatus: CheckStatus.RECORDED,
      amount: 100,
      paymentNumber: "PAY-0001",
      reference: null,
    };

    it("DEPOSITED stamps checkStatus+depositedAt, keeps status PAID, no invoice.update", async () => {
      prisma.invoicePayment.findFirst.mockResolvedValue(basePayment);
      prisma.invoice.findUnique.mockResolvedValue({
        invoiceNumber: "INV-0001",
        customerId: "cust-1",
        status: InvoiceStatus.PAID,
        total: 100,
      });

      const result = await service.setCheckStatus("inv-1", "pay-1", {
        status: CheckStatus.DEPOSITED,
      });

      expect(prisma.invoicePayment.update).toHaveBeenCalledWith({
        where: { id: "pay-1" },
        data: { checkStatus: CheckStatus.DEPOSITED, depositedAt: expect.any(Date) },
      });
      expect(prisma.invoice.update).not.toHaveBeenCalled();
      expect(result).toEqual({ success: true, checkStatus: CheckStatus.DEPOSITED });
    });

    it("CLEARED (from DEPOSITED) stamps clearedAt, no invoice change", async () => {
      prisma.invoicePayment.findFirst.mockResolvedValue({
        ...basePayment,
        checkStatus: CheckStatus.DEPOSITED,
      });
      prisma.invoice.findUnique.mockResolvedValue({
        invoiceNumber: "INV-0001",
        customerId: "cust-1",
        status: InvoiceStatus.PAID,
        total: 100,
      });

      const result = await service.setCheckStatus("inv-1", "pay-1", {
        status: CheckStatus.CLEARED,
      });

      expect(prisma.invoicePayment.update).toHaveBeenCalledWith({
        where: { id: "pay-1" },
        data: { checkStatus: CheckStatus.CLEARED, clearedAt: expect.any(Date) },
      });
      expect(prisma.invoice.update).not.toHaveBeenCalled();
      expect(result).toEqual({ success: true, checkStatus: CheckStatus.CLEARED });
    });

    it("BOUNCED with fee=25 flips status VOID, creates a non-taxable NSF line, bumps subtotal/total", async () => {
      prisma.invoicePayment.findFirst.mockResolvedValue({
        ...basePayment,
        checkStatus: CheckStatus.DEPOSITED,
      });
      prisma.invoicePayment.updateMany.mockResolvedValue({ count: 1 });
      prisma.invoice.findUnique.mockResolvedValue({
        id: "inv-1",
        invoiceNumber: "INV-0001",
        customerId: "cust-1",
        status: InvoiceStatus.PAID,
        subtotal: 100,
        total: 100,
        dueDate: null,
        payments: [], // no other surviving (non-VOID) payments
      });

      const result = await service.setCheckStatus("inv-1", "pay-1", {
        status: CheckStatus.BOUNCED,
        nsfFeeAmount: 25,
      });

      expect(prisma.invoicePayment.updateMany).toHaveBeenCalledWith({
        where: { id: "pay-1", status: { not: "VOID" } },
        data: {
          checkStatus: CheckStatus.BOUNCED,
          bouncedAt: expect.any(Date),
          nsfFeeAmount: 25,
          status: "VOID",
        },
      });
      expect(prisma.invoiceItem.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          invoiceId: "inv-1",
          qty: 1,
          unitPrice: 25,
          discount: 0,
          taxRate: 0,
          subtotal: 25,
        }),
      });
      expect(prisma.invoice.update).toHaveBeenCalledWith({
        where: { id: "inv-1" },
        data: {
          status: InvoiceStatus.SENT,
          paidAt: null,
          subtotal: 125,
          total: 125,
        },
      });
      expect(result).toEqual({ success: true, checkStatus: "BOUNCED" });
    });

    it("BOUNCED without a fee: no NSF line, survivors of 40 -> PARTIAL, no subtotal/total bump", async () => {
      prisma.invoicePayment.findFirst.mockResolvedValue({
        ...basePayment,
        checkStatus: CheckStatus.RECORDED,
      });
      prisma.invoicePayment.updateMany.mockResolvedValue({ count: 1 });
      prisma.invoice.findUnique.mockResolvedValue({
        id: "inv-1",
        invoiceNumber: "INV-0001",
        customerId: "cust-1",
        status: InvoiceStatus.PARTIAL,
        subtotal: 140,
        total: 140,
        dueDate: null,
        payments: [{ id: "pay-2", amount: 40 }],
      });

      const result = await service.setCheckStatus("inv-1", "pay-1", {
        status: CheckStatus.BOUNCED,
      });

      expect(prisma.invoiceItem.create).not.toHaveBeenCalled();
      expect(prisma.invoice.update).toHaveBeenCalledWith({
        where: { id: "inv-1" },
        data: {
          status: InvoiceStatus.PARTIAL,
          paidAt: null,
        },
      });
      expect(result).toEqual({ success: true, checkStatus: "BOUNCED" });
    });

    it("aborts a concurrent double-bounce without re-billing the NSF fee (CAS matches 0 rows)", async () => {
      // findFirst reads a stale PAID snapshot, but a racing request already
      // voided the payment, so the conditional updateMany matches 0 rows.
      prisma.invoicePayment.findFirst.mockResolvedValue({
        ...basePayment,
        checkStatus: CheckStatus.DEPOSITED,
      });
      prisma.invoicePayment.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.setCheckStatus("inv-1", "pay-1", {
          status: CheckStatus.BOUNCED,
          nsfFeeAmount: 25,
        }),
      ).rejects.toThrow(BadRequestException);

      expect(prisma.invoiceItem.create).not.toHaveBeenCalled();
      expect(prisma.invoice.update).not.toHaveBeenCalled();
    });

    it("rejects illegal transition CLEARED -> DEPOSITED", async () => {
      prisma.invoicePayment.findFirst.mockResolvedValue({
        ...basePayment,
        checkStatus: CheckStatus.CLEARED,
      });

      await expect(
        service.setCheckStatus("inv-1", "pay-1", { status: CheckStatus.DEPOSITED }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.invoicePayment.update).not.toHaveBeenCalled();
    });

    it("rejects illegal transition RECORDED -> CLEARED (must go through DEPOSITED)", async () => {
      prisma.invoicePayment.findFirst.mockResolvedValue({
        ...basePayment,
        checkStatus: CheckStatus.RECORDED,
      });

      await expect(
        service.setCheckStatus("inv-1", "pay-1", { status: CheckStatus.CLEARED }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.invoicePayment.update).not.toHaveBeenCalled();
    });

    it("rejects check-status changes on a non-CHECK payment", async () => {
      prisma.invoicePayment.findFirst.mockResolvedValue({ ...basePayment, method: "CASH" });

      await expect(
        service.setCheckStatus("inv-1", "pay-1", { status: CheckStatus.DEPOSITED }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.invoicePayment.update).not.toHaveBeenCalled();
    });

    it("rejects check-status changes on an already-voided payment", async () => {
      prisma.invoicePayment.findFirst.mockResolvedValue({ ...basePayment, status: "VOID" });

      await expect(
        service.setCheckStatus("inv-1", "pay-1", { status: CheckStatus.DEPOSITED }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.invoicePayment.update).not.toHaveBeenCalled();
    });

    it("treats a legacy null checkStatus as RECORDED (RECORDED -> DEPOSITED is legal)", async () => {
      prisma.invoicePayment.findFirst.mockResolvedValue({ ...basePayment, checkStatus: null });
      prisma.invoice.findUnique.mockResolvedValue({
        invoiceNumber: "INV-0001",
        customerId: "cust-1",
        status: InvoiceStatus.PAID,
        total: 100,
      });

      const result = await service.setCheckStatus("inv-1", "pay-1", {
        status: CheckStatus.DEPOSITED,
      });

      expect(result).toEqual({ success: true, checkStatus: CheckStatus.DEPOSITED });
    });
  });

  describe("P5-12 — recordPayment stamps checkStatus", () => {
    const baseInvoice = {
      id: "inv-1",
      status: InvoiceStatus.SENT,
      total: 100,
      dueDate: null,
      payments: [],
    };

    beforeEach(() => {
      prisma.invoice.findUnique.mockResolvedValue(baseInvoice);
      prisma.paymentCounter.upsert.mockResolvedValue({ id: "test-tenant", next: 2 });
      prisma.invoice.update.mockResolvedValue({
        id: "inv-1",
        invoiceNumber: "INV-0001",
        customerId: "cust-1",
        total: 100,
        payments: [],
      });
    });

    it("stamps checkStatus RECORDED when method is CHECK", async () => {
      await service.recordPayment("inv-1", { amount: 100, method: "CHECK" } as any);

      expect(prisma.invoicePayment.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ checkStatus: CheckStatus.RECORDED }),
      });
    });

    it("leaves checkStatus null when method is not CHECK", async () => {
      await service.recordPayment("inv-1", { amount: 100, method: "CASH" } as any);

      expect(prisma.invoicePayment.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ checkStatus: null }),
      });
    });
  });

  // ─── P5-12 fallout — VOID payments excluded from balance math ────────────────
  // A bounced check flips its InvoicePayment.status to VOID and reverts the invoice
  // to OPEN/PARTIAL. Any sum of payment amounts that ignored VOID under-states the
  // balance; these lock in the payment-level filter that findOne already had.
  describe("P5-12 — VOID payments excluded from balance math", () => {
    it("findAll: a VOID (bounced) payment does not reduce balanceDue or clear isOverdue", async () => {
      const pastDue = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
      prisma.invoice.findMany.mockResolvedValue([
        {
          id: "inv-1",
          invoiceNumber: "INV-1",
          status: InvoiceStatus.PARTIAL,
          total: 100,
          dueDate: pastDue,
          payments: [
            { id: "p1", amount: 100, status: "VOID" }, // bounced — must NOT count
            { id: "p2", amount: 30, status: "PAID" },
          ],
        },
      ]);
      prisma.invoice.count.mockResolvedValue(1);

      const result = await service.findAll({} as any);
      const inv = result.data[0] as any;

      expect(inv.paidAmount).toBe(30); // VOID's 100 excluded
      expect(inv.balanceDue).toBe(70);
      expect(inv.isOverdue).toBe(true); // 70 still owed and past due
    });

    it("deletePayment: a VOID payment is not counted when recomputing status", async () => {
      prisma.invoice.findUnique.mockResolvedValue({
        id: "inv-1",
        invoiceNumber: "INV-1",
        customerId: "cust-1",
        status: InvoiceStatus.PARTIAL,
        total: 100,
        dueDate: null,
        payments: [
          { id: "pay-A", amount: 30, status: "PAID" }, // real, being deleted
          { id: "pay-B", amount: 100, status: "VOID" }, // bounced — must NOT count
        ],
      });
      prisma.invoice.update.mockResolvedValue({
        id: "inv-1",
        invoiceNumber: "INV-1",
        customerId: "cust-1",
        total: 100,
      });

      await service.deletePayment("inv-1", "pay-A");

      // Remaining real paid = 0 (pay-A deleted, VOID pay-B ignored) → NOT PAID.
      // Without the fix, VOID's 100 would recompute to PAID and hide a $100 debt.
      const updateArg = prisma.invoice.update.mock.calls[0][0];
      expect(updateArg.data.status).not.toBe(InvoiceStatus.PAID);
      expect(updateArg.data.paidAt).toBeNull();
    });
  });

  // ─── Driver at-door payment — server resolves the invoice by orderId ─────────
  // The mobile client cannot supply an invoiceId (Order has no such scalar), so
  // recordDeliveryPaymentInTx resolves/ensures the invoice server-side and records
  // the payment the canonical way (InvoicePayment + recomputeStatus, never a
  // non-existent `balance`).
  describe("recordDeliveryPaymentInTx (driver Collect payment)", () => {
    const inv = (over: any = {}) => ({
      id: "inv-1",
      total: 100,
      status: InvoiceStatus.SENT,
      dueDate: null,
      invoiceNumber: "INV-1",
      customerId: "cust-1",
      payments: [],
      ...over,
    });

    beforeEach(() => {
      // Isolate the method's own logic: stub the ensure-invoice helpers.
      jest.spyOn(service, "findOpenOrderDraft").mockResolvedValue(null as any);
      jest.spyOn(service, "reconcileOrderDraftInvoice").mockResolvedValue(undefined as any);
      jest.spyOn(service, "createInvoiceFromOrder").mockResolvedValue([] as any);
      prisma.paymentCounter.upsert.mockResolvedValue({ next: 2 } as any);
      prisma.invoice.update.mockResolvedValue({} as any);
    });

    it("records an InvoicePayment against the order's existing invoice and marks it PAID", async () => {
      prisma.invoice.findFirst.mockResolvedValue({ id: "inv-1" }); // ensure-step: invoice exists
      prisma.invoice.findMany.mockResolvedValue([inv()]);

      const res = await service.recordDeliveryPaymentInTx(prisma as any, ["ord-1"], 100, "CASH");

      expect(res.applied).toBe(100);
      expect(prisma.invoicePayment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            invoiceId: "inv-1",
            amount: 100,
            method: "CASH",
            status: "PAID",
          }),
        }),
      );
      expect(prisma.invoice.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "inv-1" },
          data: expect.objectContaining({ status: InvoiceStatus.PAID }),
        }),
      );
      // createInvoiceFromOrder NOT called (an invoice already existed).
      expect(service.createInvoiceFromOrder).not.toHaveBeenCalled();
    });

    it("finalizes a DRAFT pending-mirror (→SENT baseline) so a partial payment lands PARTIAL, not stuck DRAFT", async () => {
      prisma.invoice.findFirst.mockResolvedValue({ id: "inv-1" });
      prisma.invoice.findMany.mockResolvedValue([inv({ status: InvoiceStatus.DRAFT })]);

      await service.recordDeliveryPaymentInTx(prisma as any, ["ord-1"], 40, "CASH");

      const upd = prisma.invoice.update.mock.calls[0][0];
      // recomputeStatus(40, 100, …, SENT) → PARTIAL (would be DRAFT if not finalized)
      expect(upd.data.status).toBe(InvoiceStatus.PARTIAL);
      expect(upd.data.sentAt).toBeInstanceOf(Date); // DRAFT was finalized
    });

    it("creates a DRAFT when the order has none, then reconciles it on the DELIVERED basis", async () => {
      // No draft initially; one exists after createInvoiceFromOrder.
      (service.findOpenOrderDraft as jest.Mock)
        .mockReset()
        .mockResolvedValueOnce(null)
        .mockResolvedValue({ id: "inv-1" });
      prisma.invoice.findFirst.mockResolvedValue(null); // no live invoice at all
      prisma.invoice.count.mockResolvedValue(1); // single-invoice order
      prisma.invoice.findMany.mockResolvedValue([inv({ status: InvoiceStatus.DRAFT })]);

      await service.recordDeliveryPaymentInTx(prisma as any, ["ord-1"], 100, "CASH");

      expect(service.createInvoiceFromOrder).toHaveBeenCalledWith("ord-1", prisma);
      // Delivered-basis reconcile is what makes a short-pick bill what was delivered.
      expect(service.reconcileOrderDraftInvoice).toHaveBeenCalledWith(
        "ord-1",
        expect.objectContaining({ basis: "delivered" }),
      );
      expect(prisma.invoicePayment.create).toHaveBeenCalledTimes(1);
    });

    it("reconciles an EXISTING draft on the delivered basis (no re-create)", async () => {
      (service.findOpenOrderDraft as jest.Mock).mockReset().mockResolvedValue({ id: "inv-1" });
      prisma.invoice.count.mockResolvedValue(1); // single-invoice order
      prisma.invoice.findMany.mockResolvedValue([inv({ status: InvoiceStatus.DRAFT })]);

      await service.recordDeliveryPaymentInTx(prisma as any, ["ord-1"], 100, "CASH");

      expect(service.reconcileOrderDraftInvoice).toHaveBeenCalledWith(
        "ord-1",
        expect.objectContaining({ basis: "delivered" }),
      );
      expect(service.createInvoiceFromOrder).not.toHaveBeenCalled(); // a draft already existed
    });

    it("does NOT reconcile a split-invoice order (regulated siblings) — avoids a group-unaware double-bill", async () => {
      // A SEPARATE_INVOICE regulated order has base + -R# sibling drafts. The
      // delivered-basis reconcile rebuilds the base from EVERY line, so folding the
      // regulated line onto the base while -R1 still bills it would double-bill.
      (service.findOpenOrderDraft as jest.Mock).mockReset().mockResolvedValue({ id: "inv-base" });
      prisma.invoice.count.mockResolvedValue(2); // base + -R1 siblings
      prisma.invoice.findMany.mockResolvedValue([
        inv({ id: "inv-base", invoiceNumber: "INV-9", total: 60 }),
        inv({ id: "inv-r1", invoiceNumber: "INV-9-R1", total: 40 }),
      ]);

      const res = await service.recordDeliveryPaymentInTx(prisma as any, ["ord-1"], 100, "CASH");

      expect(service.reconcileOrderDraftInvoice).not.toHaveBeenCalled();
      // Both siblings still get paid — each billed once at full qty (no double).
      expect(res.applied).toBe(100);
      expect(prisma.invoicePayment.create).toHaveBeenCalledTimes(2);
    });

    it("does NOT reconcile an order absent from reconcileOrderIds (not delivered this completion)", async () => {
      // An order merely linked to the stop but delivered elsewhere has deliveredQty
      // 0; reconciling it would zero its open draft. It must still be PAID, just not
      // reconciled.
      (service.findOpenOrderDraft as jest.Mock).mockReset().mockResolvedValue({ id: "inv-1" });
      prisma.invoice.count.mockResolvedValue(1);
      prisma.invoice.findMany.mockResolvedValue([inv({ status: InvoiceStatus.DRAFT })]);

      await service.recordDeliveryPaymentInTx(prisma as any, ["ord-1"], 100, "CASH", []);

      expect(service.reconcileOrderDraftInvoice).not.toHaveBeenCalled();
      expect(prisma.invoicePayment.create).toHaveBeenCalledTimes(1); // still paid
    });

    it("spreads a lump-sum oldest-first across regulated split siblings, capped at each remaining", async () => {
      prisma.invoice.findFirst.mockResolvedValue({ id: "inv-base" });
      prisma.invoice.findMany.mockResolvedValue([
        inv({ id: "inv-base", invoiceNumber: "INV-9", total: 60 }),
        inv({ id: "inv-r1", invoiceNumber: "INV-9-R1", total: 40 }),
      ]);

      const res = await service.recordDeliveryPaymentInTx(prisma as any, ["ord-1"], 100, "CASH");

      expect(res.applied).toBe(100);
      const amounts = prisma.invoicePayment.create.mock.calls.map((c: any) => ({
        invoiceId: c[0].data.invoiceId,
        amount: c[0].data.amount,
      }));
      expect(amounts).toEqual([
        { invoiceId: "inv-base", amount: 60 },
        { invoiceId: "inv-r1", amount: 40 },
      ]);
    });

    it("caps at the invoice's remaining (over-collection leaves a reported residual)", async () => {
      prisma.invoice.findFirst.mockResolvedValue({ id: "inv-1" });
      prisma.invoice.findMany.mockResolvedValue([inv()]);
      prisma.invoicePayment.findMany.mockResolvedValue([{ amount: 30 }]); // prior paid → remaining 70

      const res = await service.recordDeliveryPaymentInTx(prisma as any, ["ord-1"], 100, "CASH");

      expect(res.applied).toBe(70); // 30 residual not applied
      expect(prisma.invoicePayment.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ amount: 70 }) }),
      );
    });

    it("row-locks the invoice and reads prior paid with VOID excluded", async () => {
      prisma.invoice.findFirst.mockResolvedValue({ id: "inv-1" });
      prisma.invoice.findMany.mockResolvedValue([inv()]);
      prisma.invoicePayment.findMany.mockResolvedValue([]);

      const res = await service.recordDeliveryPaymentInTx(prisma as any, ["ord-1"], 100, "CASH");

      expect(res.applied).toBe(100);
      // FOR UPDATE lock taken (serializes a concurrent back-office payment).
      expect(prisma.$executeRaw).toHaveBeenCalled();
      // prior-paid read excludes bounced (VOID) payments.
      expect(prisma.invoicePayment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ status: { not: "VOID" } }) }),
      );
    });

    it("only touches PAYABLE invoices — a written-off/void invoice can't swallow the cash", async () => {
      prisma.invoice.findFirst.mockResolvedValue({ id: "inv-1" });
      prisma.invoice.findMany.mockResolvedValue([inv()]);

      await service.recordDeliveryPaymentInTx(prisma as any, ["ord-1"], 100, "CASH");

      expect(prisma.invoice.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: {
              in: [
                InvoiceStatus.DRAFT,
                InvoiceStatus.SENT,
                InvoiceStatus.PARTIAL,
                InvoiceStatus.OVERDUE,
              ],
            },
          }),
        }),
      );
    });

    it("refuses CREDIT_NOTE / ADVANCE (they must debit a source balance, not book a payment)", async () => {
      const res = await service.recordDeliveryPaymentInTx(prisma as any, ["ord-1"], 50, "ADVANCE");
      expect(res.applied).toBe(0);
      expect(prisma.invoicePayment.create).not.toHaveBeenCalled();
    });

    it("is a no-op for a zero amount or no orders", async () => {
      const a = await service.recordDeliveryPaymentInTx(prisma as any, ["ord-1"], 0, "CASH");
      const b = await service.recordDeliveryPaymentInTx(prisma as any, [], 50, "CASH");
      expect(a.applied).toBe(0);
      expect(b.applied).toBe(0);
      expect(prisma.invoicePayment.create).not.toHaveBeenCalled();
    });
  });
});
