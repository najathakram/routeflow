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
import { BadRequestException } from "@nestjs/common";
import { InvoicesService } from "./invoices.service";
import { InvoicePdfService } from "./invoice-pdf.service";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { EmailService } from "../email/email.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { InvoiceStatus } from "@prisma/client";

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

  beforeEach(async () => {
    prisma = createMockPrisma();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvoicesService,
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: mockGateway },
        { provide: EmailService, useValue: mockEmailService },
        { provide: InvoicePdfService, useValue: { getOrGenerate: jest.fn() } },
        { provide: SystemConfigService, useValue: mockSystemConfig },
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

    it("re-derives the boxes/pieces split for boxed products", async () => {
      prisma.order.findUnique.mockResolvedValue({
        id: "o1",
        subtotal: 100,
        tax: 0,
        lineItems: [{ id: "li1", productId: "p1" }],
      });
      prisma.invoice.findMany.mockResolvedValue([
        {
          id: "a",
          status: InvoiceStatus.SENT,
          items: [{ productId: "p1", qty: 22, subtotal: 440, unitPrice: 220 }],
        },
      ]);
      prisma.product.findMany.mockResolvedValue([{ id: "p1", unitsPerBox: 11 }]);
      prisma.orderItem.update.mockResolvedValue({});
      prisma.order.update.mockResolvedValue({});

      await service.recomputeOrderFromInvoices("o1");

      expect(prisma.orderItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ qty: 22, boxes: 2, pieces: 0, subtotal: 440 }),
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
});
