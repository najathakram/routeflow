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

// Payment-image attachment (clone of the expense-receipt pattern): mock
// compressDocument so these tests never touch real sharp/image bytes.
jest.mock("../storage/compress.util", () => ({
  compressDocument: jest.fn(),
}));

import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { InvoicesService, addCalendarDays } from "./invoices.service";
import { startOfCalendarDay } from "../common/calendar-date";
import { InvoicePdfService } from "./invoice-pdf.service";
import { PrismaService } from "../prisma/prisma.service";
import { NumberingService } from "../import/numbering.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { EmailService } from "../email/email.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { StorageService } from "../storage/storage.service";
import { compressDocument } from "../storage/compress.util";
import { createMockPrisma } from "../testing/prisma-mock";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { MessagingService } from "../messaging/messaging.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { CheckStatus, InvoiceStatus, NotificationEvent, UserRole } from "@prisma/client";
import { computeLineSubtotal, roundMoney } from "@routeflow/pricing";

const mockCompressDocument = compressDocument as jest.Mock;

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
    sendInvoice: jest.fn().mockResolvedValue({ delivered: true, transport: "resend" }),
    isEmailConfigured: jest.fn().mockResolvedValue(true),
  };

  const mockSystemConfig = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
  };

  const mockMessaging = {
    notify: jest.fn().mockResolvedValue([]),
    notifyEvent: jest.fn().mockResolvedValue(undefined),
  };

  const mockCreditNotes = {
    autoApplyOldestCreditsInTx: jest.fn().mockResolvedValue({ applied: 0, invoiceStatus: null }),
    settleOrderCreditsInTx: jest.fn().mockResolvedValue({ applied: 0, unapplied: 0 }),
    // F03/T-B84: voidInvoice's releaseWalletPaymentsInTx calls this unconditionally —
    // without a stub here, voidInvoice tests crash on "not a function" instead of
    // failing on their actual assertion.
    releaseInvoiceCreditsInTx: jest.fn().mockResolvedValue([]),
  };

  const mockStorage = {
    upload: jest.fn().mockResolvedValue("stored"),
    presignedUrl: jest.fn().mockResolvedValue("https://signed/url"),
    delete: jest.fn().mockResolvedValue(undefined),
  };

  // flag.msrp — reset to OFF in beforeEach; MSRP snapshot tests flip it ON.
  const mockEntitlements = {
    hasFlag: jest.fn().mockResolvedValue(false),
  };

  const mockCommissionEngine = {
    syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined),
    syncOrderInvoices: jest.fn().mockResolvedValue(undefined),
    removeInvoiceCommission: jest.fn().mockResolvedValue(undefined),
  };

  // B100/F16b harness note: the five invoice-number mint sites route through
  // NumberingService once P1/P2 land — InvoicesService does not inject it yet, so
  // this provider is unused by today's code and only backs the new REG-B100/pin
  // tests below (see cause-ruling.md §2 D2). Default resolves to the same
  // "INV-2026-0001" the pre-B100 findFirst-null mocks produced, so it is a safe
  // module-wide default for the many unrelated tests that never assert on the
  // minted invoiceNumber.
  const mockNumbering = {
    reserveNext: jest.fn().mockResolvedValue("INV-2026-0001"),
  };

  beforeEach(async () => {
    prisma = createMockPrisma();
    mockNumbering.reserveNext.mockClear();
    mockNumbering.reserveNext.mockResolvedValue("INV-2026-0001");
    mockEntitlements.hasFlag.mockReset();
    mockEntitlements.hasFlag.mockResolvedValue(false);
    mockCommissionEngine.syncInvoiceCommissionSafe.mockClear();
    mockCommissionEngine.syncOrderInvoices.mockClear();
    mockCommissionEngine.removeInvoiceCommission.mockClear();
    mockMessaging.notify.mockClear();
    mockMessaging.notifyEvent.mockClear();
    mockCreditNotes.autoApplyOldestCreditsInTx.mockClear();
    mockCreditNotes.autoApplyOldestCreditsInTx.mockResolvedValue({
      applied: 0,
      invoiceStatus: null,
    });
    mockCreditNotes.settleOrderCreditsInTx.mockClear();
    mockCreditNotes.settleOrderCreditsInTx.mockResolvedValue({ applied: 0, unapplied: 0 });
    mockCreditNotes.releaseInvoiceCreditsInTx.mockClear();
    mockCreditNotes.releaseInvoiceCreditsInTx.mockResolvedValue([]);
    mockStorage.upload.mockClear();
    mockStorage.upload.mockResolvedValue("stored");
    mockStorage.presignedUrl.mockClear();
    mockStorage.presignedUrl.mockResolvedValue("https://signed/url");
    mockStorage.delete.mockClear();
    mockStorage.delete.mockResolvedValue(undefined);
    mockCompressDocument.mockReset();
    mockCompressDocument.mockResolvedValue({
      buffer: Buffer.from("compressed-bytes"),
      mimeType: "image/jpeg",
      ext: "jpg",
    });

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
        { provide: CreditNotesService, useValue: mockCreditNotes },
        { provide: MessagingService, useValue: mockMessaging },
        { provide: StorageService, useValue: mockStorage },
        // flag.msrp defaults OFF so applyMsrpSnapshots is a no-op — the
        // pre-MSRP tests keep their exact write shapes (msrp stays null).
        { provide: EntitlementsService, useValue: mockEntitlements },
        { provide: CommissionEngineService, useValue: mockCommissionEngine },
        { provide: NumberingService, useValue: mockNumbering },
      ],
    }).compile();

    service = module.get<InvoicesService>(InvoicesService);
  });

  // ─── MSRP snapshots — applyMsrpSnapshots stamps lines at creation time ─────

  describe("MSRP snapshots (applyMsrpSnapshots)", () => {
    const stamp = (items: Array<{ productId?: string | null; msrp?: number | null }>) =>
      (service as any).applyMsrpSnapshots(prisma.forTenant(), "cust-1", items);

    it("no-ops (never even queries) when the tenant lacks flag.msrp", async () => {
      mockEntitlements.hasFlag.mockResolvedValue(false);
      const items = [{ productId: "p1", msrp: null }];

      await stamp(items);

      expect(items[0].msrp).toBeNull();
      expect(prisma.product.findMany).not.toHaveBeenCalled();
      expect(prisma.customerPrice.findMany).not.toHaveBeenCalled();
    });

    it("stamps the resolved MSRP per line when flag.msrp is on — customer override beats product default, productless lines untouched", async () => {
      mockEntitlements.hasFlag.mockResolvedValue(true);
      prisma.product.findMany.mockResolvedValue([
        { id: "p1", msrp: 7.5 }, // product default only
        { id: "p2", msrp: 4 }, // overridden per-customer below
        { id: "p3", msrp: null }, // no MSRP anywhere
      ]);
      prisma.customerPrice.findMany.mockResolvedValue([{ productId: "p2", msrp: 3.25 }]);
      const items = [
        { productId: "p1", msrp: null },
        { productId: "p2", msrp: null },
        { productId: "p3", msrp: null },
        { productId: null, msrp: null }, // NSF-style productless line
      ];

      await stamp(items);

      expect(items[0].msrp).toBe(7.5);
      expect(items[1].msrp).toBe(3.25);
      expect(items[2].msrp).toBeNull();
      expect(items[3].msrp).toBeNull();
      expect(mockEntitlements.hasFlag).toHaveBeenCalledWith("test-tenant", "flag.msrp");
    });
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
      prisma.invoice.create.mockResolvedValue({ ...baseInv, id: "inv-3" });

      const result = await service.duplicate("inv-2");
      expect(prisma.invoice.create).toHaveBeenCalled();
      expect(result.id).toBe("inv-3");
    });

    // REG-B100-E (cause-ruling.md §3, cause-refutation.md §7.4): duplicate() has no
    // P2002 catch today — a concurrent duplicate's unique-constraint hit propagates
    // as a raw 500. TODAY this rejects with the plain `{ code: "P2002" }` object,
    // not a ConflictException, so the assertion below fails on the type.
    it("REG-B100-E: maps a concurrent duplicate's P2002 into ConflictException (409), not a raw 500", async () => {
      const baseInv = {
        id: "inv-race",
        orderId: null,
        customerId: "cust-1",
        invoiceNumber: "INV-2026-0004",
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
      prisma.invoice.create.mockRejectedValue({
        code: "P2002",
        message: "Unique constraint failed on the fields: (`invoiceNumber`)",
      });

      await expect(service.duplicate("inv-race")).rejects.toBeInstanceOf(ConflictException);
    });
  });

  // ─── B100/F16b pins (cause-ruling.md §2/§3) ────────────────────────────────

  describe("REG-B100 pin P5 — generateInvoiceNumber delegates to NumberingService", () => {
    it("calls numbering.reserveNext('INVOICE', { year }) instead of scanning prisma.invoice.findFirst", async () => {
      mockNumbering.reserveNext.mockResolvedValueOnce("INV-2026-0038");

      // generateInvoiceNumber is private — every one of the five mint sites (P5,
      // cause-refutation.md §7.6) reduces through this one primitive or (for
      // estimates convertToInvoice) the equivalent direct call, so pinning it here
      // covers create(), createSplitInvoices(), createPartialFromOrder() and
      // duplicate() at once.
      const result = await (service as any).generateInvoiceNumber();

      // TODAY generateInvoiceNumber never touches NumberingService at all — it
      // scans prisma.invoice.findFirst — so this fails on "was not called".
      expect(mockNumbering.reserveNext).toHaveBeenCalledWith(
        "INVOICE",
        expect.objectContaining({ year: new Date().getFullYear() }),
      );
      expect(result).toBe("INV-2026-0038");
      expect(prisma.invoice.findFirst).not.toHaveBeenCalled();
    });
  });

  // D7 pin (fix-round-2b.md): WHERE the number is reserved follows the caller.
  //  - Delivery path — routes stop completion → recordDeliveryPaymentInTx →
  //    createInvoiceFromOrder(orderId, tx): the reservation must run ON that tx.
  //    Opening one here (the standalone shape, or a nested $transaction) needs a
  //    second pooled connection while the routes tx holds OrderItem locks and
  //    starves the pool under concurrent stop completions (REG-B100-C, 7/10).
  //  - Office path — no caller tx: the reservation must be standalone (NO `tx` in
  //    the opts) and commit BEFORE the invoice transaction opens, so that
  //    transaction never holds the NumberingSequence row lock (fix-round-2.md D1).
  // Asserted on the opts NumberingService actually receives and on the transaction
  // mocks, never on source text (L-087).
  describe("B100/F16b pin D7 — the reservation boundary follows the caller's transaction", () => {
    const orderFixture = (id: string) => ({
      id,
      customerId: "cust-1",
      orderNumber: `ORD-${id}`,
      subtotal: 20,
      tax: 0,
      lineItems: [
        {
          id: "li-1",
          productId: "p-1",
          qty: 2,
          invoicedQty: 0,
          unitPrice: 10,
          priceType: "STANDARD",
          trackedCategoryId: null,
          categoryTaxAmount: 0,
          product: { name: "Widget", unitsPerBox: 0, trackedCategoryId: null },
        },
      ],
    });

    beforeEach(() => {
      jest
        .spyOn(service as any, "resolveDefaultTerms")
        .mockResolvedValue({ terms: "Net 30", dueDays: 30 });
      jest
        .spyOn(service as any, "resolveTenantInvoiceDefaults")
        .mockResolvedValue({ notes: null, terms: null, timezone: null });
      prisma.trackedCategory.findMany.mockResolvedValue([]);
      prisma.customer.findFirst.mockResolvedValue({ isTaxExempt: false });
      prisma.invoice.create.mockImplementation((args: any) =>
        Promise.resolve({ ...args.data, items: [], payments: [], customer: {} }),
      );
    });

    it("delivery path: createInvoiceFromOrder(orderId, tx) reserves ON that tx and opens no transaction", async () => {
      // A stable, identity-distinct tx client (the #506 spec shape): a pass-through
      // to `this.prisma` would make the `{ tx: txClient }` assertion vacuous, since
      // reserving on the base client would look identical to reserving on the tx.
      const txClient = {
        order: { findUnique: jest.fn().mockResolvedValue(orderFixture("ord-d7-tx")) },
        invoice: {
          findMany: jest.fn().mockResolvedValue([]),
          create: jest.fn(async (args: any) => ({
            ...args.data,
            id: "inv-d7",
            items: [],
            payments: [],
            customer: {},
          })),
        },
        customer: { findFirst: jest.fn().mockResolvedValue({ isTaxExempt: false }) },
        trackedCategory: { findMany: jest.fn().mockResolvedValue([]) },
        orderItem: { update: jest.fn().mockResolvedValue({}) },
        $executeRaw: jest.fn().mockResolvedValue(0),
        $queryRaw: jest.fn().mockResolvedValue([]),
      };

      await service.createInvoiceFromOrder("ord-d7-tx", txClient);

      expect(mockNumbering.reserveNext).toHaveBeenCalledTimes(1);
      expect(mockNumbering.reserveNext).toHaveBeenCalledWith(
        "INVOICE",
        expect.objectContaining({ tx: txClient, year: new Date().getFullYear() }),
      );
      // No transaction of ours — the caller's is the only one on this path.
      expect(prisma.tenantTransaction).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
      // …and the insert really did run on that tx, so the counter lock it now holds
      // is released by the caller's commit, not left dangling on another client.
      expect(txClient.invoice.create).toHaveBeenCalledTimes(1);
      expect(prisma.invoice.create).not.toHaveBeenCalled();
    });

    it("office path: createInvoiceFromOrder(orderId) reserves standalone (no tx) before its transaction opens", async () => {
      prisma.order.findUnique.mockResolvedValue(orderFixture("ord-d7-office"));

      await service.createInvoiceFromOrder("ord-d7-office");

      expect(mockNumbering.reserveNext).toHaveBeenCalledTimes(1);
      // No `tx` key at all — reserveNext must open its OWN short transaction here.
      expect(mockNumbering.reserveNext.mock.calls[0][1]).not.toHaveProperty("tx");
      expect(prisma.tenantTransaction).toHaveBeenCalled();
      // Reserved (and committed) strictly BEFORE the invoice transaction opens.
      expect(mockNumbering.reserveNext.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.tenantTransaction.mock.invocationCallOrder[0],
      );
    });
  });

  // GREEN invariant pin (outside the red gate — see bug-test-plan.md "Pins"): the
  // sibling derivation must survive routing the base number through NumberingService.
  // Asserted on the numbers actually written (`invoice.create` args), never on the
  // source text of invoices.service.ts — a text match would be satisfied by a comment
  // or by dead code (L-087).
  describe("B100/F16b pin P4 — createSplitInvoices' -R{i} suffix is untouched", () => {
    it("derives sibling numbers from the ONE reserved base: [base, base-R1]", async () => {
      jest
        .spyOn(service as any, "resolveDefaultTerms")
        .mockResolvedValue({ terms: "Net 30", dueDays: 30 });
      jest
        .spyOn(service as any, "resolveTenantInvoiceDefaults")
        .mockResolvedValue({ notes: null, terms: null, timezone: null });
      // NOT stubbed: generateInvoiceNumber runs for real so the base number is the one
      // NumberingService reserved, and the siblings are derived from it.
      mockNumbering.reserveNext.mockResolvedValueOnce("INV-2026-0038");
      prisma.customer.findFirst.mockResolvedValue({ isTaxExempt: false });
      prisma.invoice.create.mockImplementation((args: any) =>
        Promise.resolve({ ...args.data, items: [], payments: [], customer: {} }),
      );
      prisma.trackedCategory.findMany.mockResolvedValue([
        {
          id: "cat-tob",
          name: "Tobacco",
          invoiceTreatment: "SEPARATE_INVOICE",
          taxType: "NONE",
          rate: 0,
        },
      ]);
      const line = (id: string, catId: string | null, name: string) => ({
        id,
        productId: `p-${id}`,
        qty: 1,
        invoicedQty: 0,
        unitPrice: 10,
        priceType: "STANDARD",
        trackedCategoryId: catId,
        categoryTaxAmount: 0,
        product: { name, unitsPerBox: 0, trackedCategoryId: catId },
      });
      prisma.order.findUnique.mockResolvedValue({
        id: "ord-p4",
        customerId: "cust-1",
        orderNumber: "ORD-P4",
        subtotal: 20,
        tax: 0,
        lineItems: [line("std", null, "Widget"), line("tob", "cat-tob", "Cigarillos")],
      });

      await service.createInvoiceFromOrder("ord-p4");

      // Exactly ONE number reserved for the whole group; index 0 keeps the base,
      // every sibling appends `-R{i}` (invoices.service.ts:1243).
      expect(mockNumbering.reserveNext).toHaveBeenCalledTimes(1);
      expect(prisma.invoice.create.mock.calls.map((c: any) => c[0].data.invoiceNumber)).toEqual([
        "INV-2026-0038",
        "INV-2026-0038-R1",
      ]);
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

    // ─── BUY_N_GET_M: the free-unit snapshot is MONEY and must survive the edit ──
    // The edit path delete-and-recreates every line from the payload, so a plain
    // re-save of an order-derived BOGO invoice used to re-price it at full price
    // (12 x $35 = $420 instead of the agreed $350). The snapshot now travels on
    // the payload like boxes/pieces/notes do, and is fed to computeLineSubtotal.

    it("re-prices a BOGO line off promoFreeUnits, never qty*unitPrice, on a plain re-save", async () => {
      prisma.invoice.findUnique.mockResolvedValue(draftInvoice);
      prisma.product.findMany.mockResolvedValue([]);
      prisma.customer.findUnique.mockResolvedValue({ isTaxExempt: false });
      prisma.invoice.update.mockResolvedValue(draftInvoice);

      // The owner's example: buy 5 get 1 free, 12 units of a $35 product -> 2 free.
      await service.update("inv-box", {
        items: [
          {
            productId: "prod-plain",
            description: "Sparkling water",
            qty: 12,
            unitPrice: 35,
            promoFreeUnits: 2,
          },
        ],
      });

      const created = prisma.invoice.update.mock.calls[0][0].data.items.create[0];
      expect(created.subtotal).toBe(350); // exact — 10 paid units x $35
      expect(created.subtotal).not.toBe(420); // the reverted-to-full-price bug
      expect(created.unitPrice).toBe(35); // the unit price is NEVER faked
      expect(created.discount).toBe(0); // the saving lives in the subtotal only
      expect(created.promoFreeUnits).toBe(2); // and survives the NEXT edit too
      expect(prisma.invoice.update.mock.calls[0][0].data.subtotal).toBe(350);
    });

    it("boxed BOGO line: free CASES come off the case price, loose pieces never do", async () => {
      prisma.invoice.findUnique.mockResolvedValue(draftInvoice);
      prisma.product.findMany.mockResolvedValue([{ id: "prod-box", unitsPerBox: 12 }]);
      prisma.customer.findUnique.mockResolvedValue({ isTaxExempt: false });
      prisma.invoice.update.mockResolvedValue(draftInvoice);

      // 12 cases + 4 loose of a 12-per-case product at $35 per CASE, 2 cases free:
      // 35 * ((12 - 2) + 4/12) = 350 + 11.6667 = 361.67. The loose pieces are still
      // billed — only whole selling units are ever given away.
      await service.update("inv-box", {
        items: [
          {
            productId: "prod-box",
            description: "Boxed chips",
            qty: 148,
            unitPrice: 35,
            boxes: 12,
            pieces: 4,
            promoFreeUnits: 2,
          },
        ],
      });

      const created = prisma.invoice.update.mock.calls[0][0].data.items.create[0];
      expect(created.subtotal).toBeCloseTo(361.67, 2);
      expect(created.promoFreeUnits).toBe(2);
      expect(created.unitsPerBox).toBe(12);
    });

    it("clamps a stale snapshot so a shrunk line can never be entirely free", async () => {
      prisma.invoice.findUnique.mockResolvedValue(draftInvoice);
      prisma.product.findMany.mockResolvedValue([]);
      prisma.customer.findUnique.mockResolvedValue({ isTaxExempt: false });
      prisma.invoice.update.mockResolvedValue(draftInvoice);

      // 2 units left but a 2-free snapshot: the buyer always pays the N in (N + M).
      await service.update("inv-box", {
        items: [
          {
            productId: "prod-plain",
            description: "Sparkling water",
            qty: 2,
            unitPrice: 35,
            promoFreeUnits: 2,
          },
        ],
      });

      const created = prisma.invoice.update.mock.calls[0][0].data.items.create[0];
      expect(created.subtotal).toBe(35);
      expect(created.promoFreeUnits).toBe(1);
    });

    it("leaves a non-BOGO line's money bit-for-bit unchanged (promoFreeUnits null)", async () => {
      prisma.invoice.findUnique.mockResolvedValue(draftInvoice);
      prisma.product.findMany.mockResolvedValue([]);
      prisma.customer.findUnique.mockResolvedValue({ isTaxExempt: false });
      prisma.invoice.update.mockResolvedValue(draftInvoice);

      await service.update("inv-box", {
        items: [{ productId: "prod-plain", description: "Loose", qty: 12, unitPrice: 35 }],
      });

      const created = prisma.invoice.update.mock.calls[0][0].data.items.create[0];
      expect(created.subtotal).toBe(420);
      expect(created.promoFreeUnits).toBeNull();
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

  // ─── RF-1: manual-create / draft-update reach the regulated sales ledger ───

  describe("RF-1 — manual regulated invoice ledger sync", () => {
    it("create() snapshots the category and writes W5 SALE rows (orderId null)", async () => {
      prisma.customer.findUnique.mockResolvedValue({ id: "cust-1", isTaxExempt: false });
      prisma.product.findMany.mockResolvedValue([
        {
          id: "prod-tob",
          unitsPerBox: null,
          trackedCategoryId: "cat-tob",
          trackedSubcategoryId: "sub-1",
        },
      ]);
      prisma.invoice.create.mockResolvedValue({
        id: "inv-new",
        items: [
          {
            id: "ii-1",
            trackedCategoryId: "cat-tob",
            trackedSubcategoryId: "sub-1",
            orderItemId: null,
            qty: 3,
            subtotal: 30,
            categoryTaxAmount: 0,
          },
        ],
        customer: {},
        payments: [],
      });
      const ledger = (service as any).ledger;

      await service.create({
        customerId: "cust-1",
        items: [{ productId: "prod-tob", description: "Cigs", qty: 3, unitPrice: 10 }],
      });

      // The regulated category/subcategory snapshot flows onto the created line.
      const createData = prisma.invoice.create.mock.calls[0][0].data;
      expect(createData.items.create[0]).toMatchObject({
        trackedCategoryId: "cat-tob",
        trackedSubcategoryId: "sub-1",
      });
      // A SALE row is written from the created items with orderId null (manual sale) —
      // RF-3: the ledger line carries the subcategory breakdown through.
      expect(ledger.writeSaleEntries).toHaveBeenCalledWith(
        expect.objectContaining({
          orderId: null,
          invoiceId: "inv-new",
          lines: [
            expect.objectContaining({
              invoiceItemId: "ii-1",
              trackedCategoryId: "cat-tob",
              trackedSubcategoryId: "sub-1",
              qty: 3,
              netSales: 30,
            }),
          ],
        }),
      );
    });

    it("create() does NOT touch the ledger for a purely non-regulated invoice", async () => {
      prisma.customer.findUnique.mockResolvedValue({ id: "cust-1", isTaxExempt: false });
      prisma.product.findMany.mockResolvedValue([
        {
          id: "prod-plain",
          unitsPerBox: null,
          trackedCategoryId: null,
          trackedSubcategoryId: null,
        },
      ]);
      prisma.invoice.findFirst.mockResolvedValue(null);
      prisma.invoice.create.mockResolvedValue({
        id: "inv-2",
        items: [],
        customer: {},
        payments: [],
      });
      const ledger = (service as any).ledger;

      await service.create({
        customerId: "cust-1",
        items: [{ productId: "prod-plain", description: "Soda", qty: 2, unitPrice: 3 }],
      });
      expect(ledger.writeSaleEntries).not.toHaveBeenCalled();
    });

    it("update() re-syncs the ledger on a draft edit (reverse prior SALE + write new)", async () => {
      prisma.invoice.findUnique.mockResolvedValue({
        id: "inv-e",
        orderId: null,
        deliveryBatchId: null,
        customerId: "cust-1",
        status: InvoiceStatus.DRAFT,
        discount: 0,
        shippingFee: 0,
        issueDate: new Date(),
      });
      prisma.product.findMany.mockResolvedValue([
        {
          id: "prod-tob",
          unitsPerBox: null,
          trackedCategoryId: "cat-tob",
          trackedSubcategoryId: null,
        },
      ]);
      prisma.customer.findUnique.mockResolvedValue({ isTaxExempt: false });
      prisma.invoice.update.mockResolvedValue({
        id: "inv-e",
        items: [
          {
            id: "ii-new",
            trackedCategoryId: "cat-tob",
            orderItemId: null,
            qty: 5,
            subtotal: 50,
            categoryTaxAmount: 0,
          },
        ],
        customer: {},
        payments: [],
      });
      const ledger = (service as any).ledger;

      await service.update("inv-e", {
        items: [{ productId: "prod-tob", description: "Cigs", qty: 5, unitPrice: 10 }],
      });

      // Prior SALE reversed (preserveReturns), then a fresh SALE written from new items.
      expect(ledger.reverseInvoiceEntries).toHaveBeenCalledWith(
        expect.objectContaining({ invoiceId: "inv-e", preserveReturns: true }),
      );
      expect(ledger.writeSaleEntries).toHaveBeenCalledWith(
        expect.objectContaining({
          invoiceId: "inv-e",
          lines: [
            expect.objectContaining({
              invoiceItemId: "ii-new",
              trackedCategoryId: "cat-tob",
              qty: 5,
              netSales: 50,
            }),
          ],
        }),
      );
    });
  });

  // ─── RF-4: manual invoice per-category tax ─────────────────────────────────

  describe("RF-4 — manual invoice category tax", () => {
    const seedManual = (isTaxExempt: boolean) => {
      prisma.customer.findUnique.mockResolvedValue({ id: "cust-1", isTaxExempt });
      prisma.product.findMany.mockResolvedValue([
        {
          id: "prod-tob",
          unitsPerBox: null,
          trackedCategoryId: "cat-tob",
          trackedSubcategoryId: null,
        },
      ]);
      prisma.trackedCategory.findMany.mockResolvedValue([
        {
          id: "cat-tob",
          name: "Tobacco",
          taxType: "PERCENT_OF_SALE",
          rate: 0.1,
          unitBasis: null,
          priceIncludesTax: false,
        },
      ]);
      prisma.invoice.create.mockImplementation((args: any) =>
        Promise.resolve({ id: "inv-x", ...args.data, items: [], customer: {}, payments: [] }),
      );
    };

    it("folds category tax into taxAmount + total (PERCENT_OF_SALE 10%)", async () => {
      seedManual(false);
      await service.create({
        customerId: "cust-1",
        items: [{ productId: "prod-tob", description: "Cigs", qty: 3, unitPrice: 10 }],
      });
      const data = prisma.invoice.create.mock.calls[0][0].data;
      // subtotal 30; regular tax 0 (no line taxRate); category tax 10% × 30 = 3; total 33.
      expect(Number(data.subtotal)).toBe(30);
      expect(Number(data.taxAmount)).toBe(3);
      expect(Number(data.total)).toBe(33);
      expect(Number(data.items.create[0].categoryTaxAmount)).toBe(3);
    });

    it("tax-exempt customer → category tax 0 (both the total AND the line snapshot)", async () => {
      seedManual(true);
      await service.create({
        customerId: "cust-1",
        items: [{ productId: "prod-tob", description: "Cigs", qty: 3, unitPrice: 10 }],
      });
      const data = prisma.invoice.create.mock.calls[0][0].data;
      expect(Number(data.taxAmount)).toBe(0);
      expect(Number(data.total)).toBe(30);
      expect(Number(data.items.create[0].categoryTaxAmount)).toBe(0);
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

    // Order-driven reconcile (WP2): the ORDER owns the fee — a stale value left on
    // the draft (e.g. from before the order's fee was edited) is overwritten.
    it("order-driven reconcile: the order's fee OVERWRITES a stale draft fee value", async () => {
      const feeOrder = { ...order, id: "o-fee", shippingFee: 8 };
      prisma.invoice.findFirst.mockResolvedValue({ id: "d-fee", discount: 0, shippingFee: 3 });
      prisma.order.findUnique.mockResolvedValue(feeOrder);
      prisma.customer.findUnique.mockResolvedValue({ isTaxExempt: false });
      prisma.invoiceItem.deleteMany.mockResolvedValue({});
      prisma.invoice.update.mockResolvedValue({ id: "d-fee", status: InvoiceStatus.DRAFT });
      prisma.orderItem.findMany.mockResolvedValue([{ id: "li1" }]);
      prisma.orderItem.update.mockResolvedValue({});
      // No other non-void sibling invoices carry any of the fee.
      prisma.invoice.aggregate.mockResolvedValue({ _sum: { shippingFee: 0 } });

      await service.reconcileOrderDraftInvoice("o-fee", { basis: "order" });

      const data = prisma.invoice.update.mock.calls[0][0].data;
      expect(data.shippingFee).toBe(8); // order fee wins, stale draft value (3) discarded
      // subtotal 50 - discount 0 + fee 8 + tax 5 = 63.
      expect(data.total).toBeCloseTo(63, 2);
    });
  });

  // WP-D1: a deposit-collect-at-order mirror is SENT (not DRAFT) at placement, so
  // it has no open draft to find — reconcileOrderDraftInvoice widens to also catch
  // it, ONLY when it's the order's sole non-void invoice, carries a deposit, and
  // the order hasn't reached DELIVERED/CANCELLED.
  describe("reconcileOrderDraftInvoice — WP-D1 deposit-mirror widening", () => {
    const depositOrder = {
      id: "o-dep",
      customerId: "c1",
      subtotal: 50,
      tax: 5,
      lineItems: [
        {
          id: "li1",
          productId: "p1",
          qty: 10,
          deliveredQty: 10,
          unitPrice: 5,
          originalPrice: null,
          priceType: "STANDARD",
          product: { name: "P1" },
          status: "PENDING",
        },
      ],
    };

    function armDepositReconcile(overrides: any = {}) {
      prisma.invoice.findFirst.mockResolvedValue(null); // no open DRAFT pending mirror
      prisma.order.findFirst.mockResolvedValue({ status: "PENDING" }); // order-editable gate
      prisma.invoice.findMany.mockResolvedValue([
        {
          id: "inv-dep",
          status: InvoiceStatus.SENT,
          deliveryBatchId: null,
          discount: 0,
          shippingFee: 0,
          depositPercent: 50,
          dueDate: new Date("2026-10-01"),
          items: [],
          payments: [{ amount: 20, status: "PAID" }],
          ...overrides,
        },
      ]);
      prisma.order.findUnique.mockResolvedValue(depositOrder);
      prisma.customer.findFirst.mockResolvedValue({ isTaxExempt: false });
      prisma.invoiceItem.deleteMany.mockResolvedValue({});
      prisma.invoice.update.mockImplementation((args: any) =>
        Promise.resolve({ id: "inv-dep", ...args.data }),
      );
      prisma.orderItem.findMany.mockResolvedValue([{ id: "li1" }]);
      prisma.orderItem.update.mockResolvedValue({});
      prisma.invoice.aggregate.mockResolvedValue({ _sum: { shippingFee: 0 } });
    }

    it("reconciles a SENT+deposit mirror: rebuilds totals, preserves payments/dueDate, recomputes status from paid vs new total", async () => {
      armDepositReconcile();

      const result = await service.reconcileOrderDraftInvoice("o-dep", { basis: "order" });

      expect(result).toBeTruthy();
      const data = prisma.invoice.update.mock.calls[0][0].data;
      // subtotal 10*5=50, tax proportion 50/50=1 -> regularTax 5, total 55; paid 20 -> PARTIAL.
      expect(data.subtotal).toBeCloseTo(50, 2);
      expect(data.total).toBeCloseTo(55, 2);
      expect(data.status).toBe(InvoiceStatus.PARTIAL);
      // depositDueDate/dueDate anchor to placement/terms, not to edits — never
      // part of this update at all (Prisma leaves untouched columns alone).
      expect("dueDate" in data).toBe(false);
      expect("depositDueDate" in data).toBe(false);
      // Payments are read (for the status recompute) but never written here.
      expect("payments" in data).toBe(false);
    });

    it("flips PAID (balance floors at 0) when the edited total drops to/below what's already paid", async () => {
      armDepositReconcile({ payments: [{ amount: 60, status: "PAID" }] });

      await service.reconcileOrderDraftInvoice("o-dep", { basis: "order" });

      const data = prisma.invoice.update.mock.calls[0][0].data;
      expect(data.status).toBe(InvoiceStatus.PAID);
    });

    it("excludes a VOID payment from the recomputed status, same as findAll/findOne", async () => {
      armDepositReconcile({
        payments: [
          { amount: 60, status: "VOID" },
          { amount: 10, status: "PAID" },
        ],
      });

      await service.reconcileOrderDraftInvoice("o-dep", { basis: "order" });

      const data = prisma.invoice.update.mock.calls[0][0].data;
      expect(data.status).toBe(InvoiceStatus.PARTIAL); // 10 paid, not 70
    });

    // F03 (T-B11s / R1 / REG-B11) — the deposit-mirror status recompute is one of the
    // payment SUMS R1 covers, and `not: VOID` is not enough here: an UNCONFIRMED
    // DRAFT row is neither VOID nor collected money. Rebuilt total is $55; $30 is
    // confirmed and $40 is a DRAFT bank-reconciliation row nobody has confirmed.
    // CONFIRMED basis ⇒ $30 of $55 ⇒ PARTIAL. A `not: VOID` sum sees $70 ≥ $55 and
    // marks an ISSUED deposit mirror PAID off money the tenant has not been paid —
    // closing it to reminders and write-off while $25 is genuinely outstanding.
    it("REG-B11: an unconfirmed DRAFT payment never funds the deposit mirror's recomputed status", async () => {
      armDepositReconcile({
        payments: [
          { amount: 30, status: "PAID" },
          { amount: 40, status: "DRAFT" },
        ],
      });

      await service.reconcileOrderDraftInvoice("o-dep", { basis: "order" });

      const data = prisma.invoice.update.mock.calls[0][0].data;
      expect(data.status).toBe(InvoiceStatus.PARTIAL); // 30 confirmed of 55, not 70
    });

    // S2: the rebuilt mirror is an ISSUED invoice whose money just moved — commission
    // must re-sync (what rebuildSiblingDrafts does on a preserveStatus rebuild) and
    // the UI must hear about it.
    it("re-syncs commission and emits invoice-updated for the issued mirror", async () => {
      armDepositReconcile();
      mockCommissionEngine.syncInvoiceCommissionSafe.mockClear();
      mockGateway.emitInvoiceUpdated.mockClear();

      await service.reconcileOrderDraftInvoice("o-dep", { basis: "order" });

      expect(mockCommissionEngine.syncInvoiceCommissionSafe).toHaveBeenCalledWith(
        "inv-dep",
        expect.anything(),
      );
      expect(mockGateway.emitInvoiceUpdated).toHaveBeenCalledWith(
        "test-tenant",
        expect.objectContaining({
          invoiceId: "inv-dep",
          status: InvoiceStatus.PARTIAL,
          total: 55,
        }),
      );
    });

    it("a plain DRAFT pending mirror syncs no commission and emits nothing (unchanged)", async () => {
      prisma.invoice.findFirst.mockResolvedValue({ id: "d1", discount: 0, shippingFee: 0 });
      prisma.order.findUnique.mockResolvedValue(depositOrder);
      prisma.customer.findFirst.mockResolvedValue({ isTaxExempt: false });
      prisma.invoice.update.mockResolvedValue({ id: "d1", status: InvoiceStatus.DRAFT });
      prisma.orderItem.findMany.mockResolvedValue([{ id: "li1" }]);
      prisma.invoice.aggregate.mockResolvedValue({ _sum: { shippingFee: 0 } });
      mockCommissionEngine.syncInvoiceCommissionSafe.mockClear();
      mockGateway.emitInvoiceUpdated.mockClear();

      await service.reconcileOrderDraftInvoice("o-dep", { basis: "order" });

      expect(mockCommissionEngine.syncInvoiceCommissionSafe).not.toHaveBeenCalled();
      expect(mockGateway.emitInvoiceUpdated).not.toHaveBeenCalled();
    });

    it("never touches a plain SENT invoice with no deposit — the fence", async () => {
      armDepositReconcile({ depositPercent: null });

      const result = await service.reconcileOrderDraftInvoice("o-dep", { basis: "order" });

      expect(result).toBeNull();
      expect(prisma.invoice.update).not.toHaveBeenCalled();
    });

    it("never touches the mirror once the order is DELIVERED (post-delivery edits are resyncOrderInvoicesForEdit's job)", async () => {
      prisma.invoice.findFirst.mockResolvedValue(null);
      prisma.order.findFirst.mockResolvedValue({ status: "DELIVERED" });
      prisma.invoice.findMany.mockResolvedValue([
        {
          id: "inv-dep",
          status: InvoiceStatus.SENT,
          deliveryBatchId: null,
          depositPercent: 50,
          payments: [],
        },
      ]);

      const result = await service.reconcileOrderDraftInvoice("o-dep", { basis: "order" });

      expect(result).toBeNull();
      expect(prisma.invoice.update).not.toHaveBeenCalled();
    });

    it("never touches the mirror once the order is CANCELLED", async () => {
      prisma.invoice.findFirst.mockResolvedValue(null);
      prisma.order.findFirst.mockResolvedValue({ status: "CANCELLED" });
      prisma.invoice.findMany.mockResolvedValue([
        {
          id: "inv-dep",
          status: InvoiceStatus.SENT,
          deliveryBatchId: null,
          depositPercent: 50,
          payments: [],
        },
      ]);

      const result = await service.reconcileOrderDraftInvoice("o-dep", { basis: "order" });

      expect(result).toBeNull();
      expect(prisma.invoice.update).not.toHaveBeenCalled();
    });

    it("never touches when the order has more than one non-void invoice (split/partial territory, not this path)", async () => {
      prisma.invoice.findFirst.mockResolvedValue(null);
      prisma.order.findFirst.mockResolvedValue({ status: "PENDING" });
      prisma.invoice.findMany.mockResolvedValue([
        {
          id: "inv-dep",
          status: InvoiceStatus.SENT,
          deliveryBatchId: null,
          depositPercent: 50,
          payments: [],
        },
        {
          id: "inv-other",
          status: InvoiceStatus.SENT,
          deliveryBatchId: null,
          depositPercent: null,
          payments: [],
        },
      ]);

      const result = await service.reconcileOrderDraftInvoice("o-dep", { basis: "order" });

      expect(result).toBeNull();
      expect(prisma.invoice.update).not.toHaveBeenCalled();
    });

    it("a plain DRAFT pending mirror still forces DRAFT unconditionally — unwidened behavior is untouched", async () => {
      // The open-draft branch short-circuits before the widened lookup even runs.
      prisma.invoice.findFirst.mockResolvedValue({ id: "d1", discount: 0, shippingFee: 0 });
      prisma.order.findUnique.mockResolvedValue(depositOrder);
      prisma.customer.findFirst.mockResolvedValue({ isTaxExempt: false });
      prisma.invoiceItem.deleteMany.mockResolvedValue({});
      prisma.invoice.update.mockResolvedValue({ id: "d1", status: InvoiceStatus.DRAFT });
      prisma.orderItem.findMany.mockResolvedValue([{ id: "li1" }]);
      prisma.orderItem.update.mockResolvedValue({});
      prisma.invoice.aggregate.mockResolvedValue({ _sum: { shippingFee: 0 } });

      await service.reconcileOrderDraftInvoice("o-dep", { basis: "order" });

      const data = prisma.invoice.update.mock.calls[0][0].data;
      expect(data.status).toBe(InvoiceStatus.DRAFT);
      expect(prisma.order.findFirst).not.toHaveBeenCalled();
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
      prisma.order.findFirst.mockResolvedValue({ status: "PENDING", orderNumber: "O1" });
      await expect(service.send("i1")).rejects.toThrow(BadRequestException);
      expect(prisma.invoice.update).not.toHaveBeenCalled();
    });

    // WP-D1: the deposit-collect-at-order issuance path calls send() with this
    // narrow escape hatch — never set by the public controller/reminder/van-sale
    // callers — so a deposit mirror can be issued pre-delivery on purpose.
    it("allowPreDelivery lets an order-linked DRAFT be sent before the order is delivered, without even checking the order", async () => {
      prisma.invoice.findUnique.mockResolvedValue({
        id: "i1",
        orderId: "o1",
        status: InvoiceStatus.DRAFT,
        deliveryBatchId: null,
        depositPercent: 30,
      });
      prisma.invoice.update.mockResolvedValue({
        id: "i1",
        invoiceNumber: "INV-1",
        customerId: "c1",
        status: InvoiceStatus.SENT,
        total: 10,
      });
      await expect(service.send("i1", { allowPreDelivery: true })).resolves.toBeDefined();
      expect(prisma.order.findFirst).not.toHaveBeenCalled();
    });

    it("allows sending once the order is delivered", async () => {
      prisma.invoice.findUnique.mockResolvedValue({
        id: "i1",
        orderId: "o1",
        status: InvoiceStatus.DRAFT,
        deliveryBatchId: null,
      });
      prisma.order.findFirst.mockResolvedValue({ status: "DELIVERED", orderNumber: "O1" });
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
      expect(prisma.order.findFirst).not.toHaveBeenCalled();
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

    // WP4 — sales agents & commissions: send() is a hook site (accrual on issue).
    it("calls syncInvoiceCommissionSafe once with the invoice id", async () => {
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
      expect(mockCommissionEngine.syncInvoiceCommissionSafe).toHaveBeenCalledTimes(1);
      expect(mockCommissionEngine.syncInvoiceCommissionSafe).toHaveBeenCalledWith(
        "i1",
        expect.anything(),
      );
    });
  });

  // WP2 — order-scoped credit notes: stuck-SENT fix + explicit-amount exclusions.
  describe("send() — credit-note interactions (WP2)", () => {
    it("flips a fully-pre-credited DRAFT to PAID, not SENT (stuck-SENT regression)", async () => {
      prisma.invoice.findUnique
        .mockResolvedValueOnce({
          // findOneOrThrow — the invoice as it is before send()
          id: "i1",
          orderId: null,
          status: InvoiceStatus.DRAFT,
          deliveryBatchId: null,
        })
        .mockResolvedValueOnce({
          // fresh read inside the tx, after the DRAFT→SENT flip already committed —
          // a credit applied at order-create time already covers the full total.
          id: "i1",
          status: InvoiceStatus.SENT,
          total: 100,
          dueDate: null,
          payments: [{ id: "pay-1", amount: 100, status: "PAID" }],
        })
        .mockResolvedValueOnce({
          // final post-tx re-fetch for the return value
          id: "i1",
          invoiceNumber: "INV-1",
          customerId: "c1",
          status: InvoiceStatus.PAID,
          total: 100,
        });
      prisma.invoice.update.mockResolvedValueOnce({
        id: "i1",
        invoiceNumber: "INV-1",
        customerId: "c1",
        orderId: null,
        status: InvoiceStatus.SENT,
        total: 100,
        dueDate: null,
      });
      // Auto-apply finds nothing left to apply — the credit already covered this
      // invoice at order-create time via settleOrderCreditsInTx.
      mockCreditNotes.autoApplyOldestCreditsInTx.mockResolvedValueOnce({
        applied: 0,
        invoiceStatus: null,
      });

      const result = await service.send("i1");

      // The stuck-SENT fix recomputed status from the invoice's own payments and
      // promoted it to PAID instead of leaving it SENT.
      expect(prisma.invoice.update).toHaveBeenCalledWith({
        where: { id: "i1" },
        data: { status: InvoiceStatus.PAID, paidAt: expect.any(Date) },
      });
      expect((result as any).status).toBe(InvoiceStatus.PAID);
    });

    it("passes the order's explicit-amount intent ids as excludeCreditNoteIds", async () => {
      prisma.invoice.findUnique.mockResolvedValueOnce({
        id: "i2",
        orderId: "ord-2",
        status: InvoiceStatus.DRAFT,
        deliveryBatchId: null,
      });
      prisma.order.findFirst.mockResolvedValue({ status: "DELIVERED", orderNumber: "O2" });
      prisma.invoice.update.mockResolvedValueOnce({
        id: "i2",
        invoiceNumber: "INV-2",
        customerId: "c2",
        orderId: "ord-2",
        status: InvoiceStatus.SENT,
        total: 50,
        dueDate: null,
      });
      prisma.orderCreditNote.findMany.mockResolvedValueOnce([
        { creditNoteId: "cn-explicit-1" },
        { creditNoteId: "cn-explicit-2" },
      ]);
      mockCreditNotes.autoApplyOldestCreditsInTx.mockResolvedValueOnce({
        applied: 0,
        invoiceStatus: InvoiceStatus.SENT,
      });

      await service.send("i2");

      expect(prisma.orderCreditNote.findMany).toHaveBeenCalledWith({
        where: { orderId: "ord-2", amount: { not: null } },
        select: { creditNoteId: true },
      });
      expect(mockCreditNotes.autoApplyOldestCreditsInTx).toHaveBeenCalledWith(
        expect.anything(),
        "i2",
        "c2",
        { excludeCreditNoteIds: ["cn-explicit-1", "cn-explicit-2"] },
      );
    });
  });

  // R5 — sendEmail must only claim "sent" when the email ACTUALLY went out.
  describe("sendEmail — email honesty (R5)", () => {
    const draftInvoice = () => ({
      id: "i1",
      orderId: null, // standalone → assertOrderInvoiceUnlocked skips the order check
      invoiceNumber: "INV-1",
      status: InvoiceStatus.DRAFT,
      deliveryBatchId: null,
      total: 100,
      issueDate: new Date("2026-07-01"),
      dueDate: new Date("2026-07-15"),
      customer: { id: "c1", businessName: "Acme", email: "buyer@example.com" },
      items: [],
    });

    it("throws EMAIL_NOT_CONFIGURED and does NOT mark SENT when email isn't set up", async () => {
      prisma.invoice.findUnique.mockResolvedValue(draftInvoice() as any);
      mockEmailService.isEmailConfigured.mockResolvedValueOnce(false);

      await expect(service.sendEmail("i1")).rejects.toMatchObject({
        response: { code: "EMAIL_NOT_CONFIGURED" },
      });
      // No PDF, no send attempt, no SENT flip — nothing pretends it happened.
      expect(mockEmailService.sendInvoice).not.toHaveBeenCalled();
      expect(prisma.invoice.update).not.toHaveBeenCalled();
    });

    it("throws EMAIL_SEND_FAILED and does NOT mark SENT when the send fails", async () => {
      prisma.invoice.findUnique.mockResolvedValue(draftInvoice() as any);
      mockEmailService.isEmailConfigured.mockResolvedValueOnce(true);
      mockEmailService.sendInvoice.mockResolvedValueOnce({
        delivered: false,
        transport: "smtp",
        error: "Invalid login",
      });

      await expect(service.sendEmail("i1")).rejects.toMatchObject({
        response: { code: "EMAIL_SEND_FAILED" },
      });
      expect(prisma.invoice.update).not.toHaveBeenCalled();
    });

    it("marks SENT and returns success ONLY when the email is actually delivered", async () => {
      prisma.invoice.findUnique.mockResolvedValue(draftInvoice() as any);
      mockEmailService.isEmailConfigured.mockResolvedValueOnce(true);
      mockEmailService.sendInvoice.mockResolvedValueOnce({ delivered: true, transport: "resend" });
      prisma.invoice.update.mockResolvedValue({
        id: "i1",
        invoiceNumber: "INV-1",
        customerId: "c1",
        status: InvoiceStatus.SENT,
        total: 100,
        dueDate: null,
      });

      const res = await service.sendEmail("i1");
      expect(res).toMatchObject({ success: true, sentTo: "buyer@example.com" });
      expect(prisma.invoice.update).toHaveBeenCalled();
    });

    // Import sentinels (`@imported.local` / `@placeholder.local`) are non-routable —
    // they must behave exactly like "no email on file", never like a real recipient.
    it("refuses a sentinel on-file email as if no email exists (no send, no SENT flip)", async () => {
      mockEmailService.sendInvoice.mockClear();
      prisma.invoice.update.mockClear();
      prisma.invoice.findUnique.mockResolvedValue({
        ...draftInvoice(),
        customer: { id: "c1", businessName: "Acme", email: "acme_store@imported.local" },
      } as any);

      await expect(service.sendEmail("i1")).rejects.toThrow(/No email address on file/);
      expect(mockEmailService.sendInvoice).not.toHaveBeenCalled();
      expect(prisma.invoice.update).not.toHaveBeenCalled();
    });

    it("refuses a sentinel override too (older clients echo the on-file address)", async () => {
      mockEmailService.sendInvoice.mockClear();
      prisma.invoice.findUnique.mockResolvedValue({
        ...draftInvoice(),
        customer: { id: "c1", businessName: "Acme", email: "no-email+x@placeholder.local" },
      } as any);

      await expect(service.sendEmail("i1", "acme_store@imported.local")).rejects.toThrow(
        /No email address on file/,
      );
      expect(mockEmailService.sendInvoice).not.toHaveBeenCalled();
    });

    it("a real override wins over a sentinel on-file email", async () => {
      prisma.invoice.findUnique.mockResolvedValue({
        ...draftInvoice(),
        customer: { id: "c1", businessName: "Acme", email: "acme_store@imported.local" },
      } as any);
      mockEmailService.isEmailConfigured.mockResolvedValueOnce(true);
      mockEmailService.sendInvoice.mockResolvedValueOnce({ delivered: true, transport: "resend" });
      prisma.invoice.update.mockResolvedValue({
        id: "i1",
        invoiceNumber: "INV-1",
        customerId: "c1",
        status: InvoiceStatus.SENT,
        total: 100,
        dueDate: null,
      });

      const res = await service.sendEmail("i1", "owner@realstore.com");
      expect(res).toMatchObject({ success: true, sentTo: "owner@realstore.com" });
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

    // Shipping back-sync (WP2): Order.shippingFee is DEFINED as Σ(non-void invoice
    // fees) — an invoice-side fee edit back-syncs here. The `invoice.findMany` this
    // method runs already filters `status: { not: VOID }`, so a VOID sibling never
    // appears in `invoices` here — mirrored below by simply not including one.
    it("writes Order.shippingFee = Σ non-void invoice fees, folded into the total", async () => {
      prisma.order.findUnique.mockResolvedValue({
        id: "o1",
        subtotal: 100,
        tax: 10,
        lineItems: [{ id: "li1", productId: "p1" }],
      });
      prisma.invoice.findMany.mockResolvedValue([
        {
          id: "a",
          status: InvoiceStatus.SENT,
          shippingFee: 6,
          items: [{ productId: "p1", qty: 1, subtotal: 220, unitPrice: 220 }],
        },
        {
          id: "b",
          status: InvoiceStatus.DRAFT,
          shippingFee: 0,
          items: [{ productId: "p1", qty: 1, subtotal: 220, unitPrice: 220 }],
        },
        // A VOID sibling's fee is EXCLUDED — Prisma's own query filter would never
        // return it, so it's simply left off the mocked findMany result here.
      ]);
      prisma.orderItem.update.mockResolvedValue({});
      prisma.order.update.mockResolvedValue({});

      const res = await service.recomputeOrderFromInvoices("o1");

      const data = prisma.order.update.mock.calls[0][0].data;
      expect(data.shippingFee).toBe(6);
      // subtotal 440, tax 44, categoryTax 0, fee 6 → total 490.
      expect(data.total).toBeCloseTo(490, 2);
      expect(res).toMatchObject({ shippingFee: 6, total: 490 });
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
        .mockResolvedValue({ notes: null, terms: null, timezone: null });
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

  // WP2: createSplitInvoices settles order-selected credit notes at invoice-creation time.
  describe("createSplitInvoices — credit-note settle hook", () => {
    it("calls settleOrderCreditsInTx with the creation tx + order id", async () => {
      jest
        .spyOn(service as any, "resolveDefaultTerms")
        .mockResolvedValue({ terms: "Net 30", dueDays: 30 });
      jest
        .spyOn(service as any, "resolveTenantInvoiceDefaults")
        .mockResolvedValue({ notes: null, terms: null, timezone: null });
      jest.spyOn(service as any, "generateInvoiceNumber").mockResolvedValue("INV-1");

      prisma.order.findUnique.mockResolvedValue({
        id: "ord-credit",
        customerId: "cust-1",
        orderNumber: "ORD-CR",
        subtotal: 20,
        tax: 0,
        lineItems: [
          {
            id: "li-1",
            productId: "p1",
            name: null,
            qty: 2,
            invoicedQty: 0,
            unitPrice: 10,
            originalPrice: null,
            priceType: "STANDARD",
            product: { name: "Widget", unitsPerBox: 0 },
          },
        ],
      });
      prisma.customer.findUnique.mockResolvedValue({ isTaxExempt: false });
      prisma.invoice.create.mockResolvedValue({
        id: "inv-credit",
        items: [],
        payments: [],
        customer: {},
      });

      await service.createInvoiceFromOrder("ord-credit");

      expect(mockCreditNotes.settleOrderCreditsInTx).toHaveBeenCalledWith(
        expect.anything(),
        "ord-credit",
        "test-tenant",
      );
    });
  });

  describe("createInvoiceFromOrder — regulated category split (W4)", () => {
    const setupSplitSpies = () => {
      jest
        .spyOn(service as any, "resolveDefaultTerms")
        .mockResolvedValue({ terms: "Net 30", dueDays: 30 });
      jest
        .spyOn(service as any, "resolveTenantInvoiceDefaults")
        .mockResolvedValue({ notes: null, terms: null, timezone: null });
      jest.spyOn(service as any, "generateInvoiceNumber").mockResolvedValue("INV-2026-0042");
      prisma.customer.findFirst.mockResolvedValue({ isTaxExempt: false });
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

    it("RF-4: a non-zero-rate category no longer throws — it folds category tax into the split", async () => {
      setupSplitSpies();
      prisma.trackedCategory.findMany.mockResolvedValue([
        {
          id: "cat-alc",
          name: "Alcohol",
          invoiceTreatment: "SEPARATE_INVOICE",
          taxType: "PERCENT_OF_SALE",
          rate: 0.05,
        },
      ]);
      // Order line already carries its snapshotted category tax ($10 × 5% = $0.50);
      // the invoice copies + folds it (the removed guard used to reject this).
      prisma.order.findUnique.mockResolvedValue({
        id: "ord-3",
        customerId: "cust-1",
        orderNumber: "ORD-11",
        subtotal: 10,
        tax: 0,
        lineItems: [{ ...line("alc", "cat-alc", "Beer"), categoryTaxAmount: 0.5 }],
      });

      const result = (await service.createInvoiceFromOrder("ord-3")) as any[];
      expect(result).toHaveLength(1);
      // subtotal 10 + regular tax 0 + category tax 0.50 = 10.50.
      expect(Number(result[0].taxAmount)).toBe(0.5);
      expect(Number(result[0].total)).toBe(10.5);
    });

    it("RF-4: split invariant — Σ sibling totals == order total with a PERCENT category", async () => {
      setupSplitSpies();
      prisma.trackedCategory.findMany.mockResolvedValue([
        {
          id: "cat-alc",
          name: "Alcohol",
          invoiceTreatment: "SEPARATE_INVOICE",
          taxType: "PERCENT_OF_SALE",
          rate: 0.05,
        },
      ]);
      // Standard line $20 (cat tax 0) + alcohol line $10 (5% = $0.50 snapshot).
      // Order total = 30 subtotal + 3 regular tax + 0.50 category tax = 33.50.
      prisma.order.findUnique.mockResolvedValue({
        id: "ord-inv",
        customerId: "cust-1",
        orderNumber: "ORD-INV",
        subtotal: 30,
        tax: 3,
        lineItems: [
          line("std", null, "Widget"),
          { ...line("alc", "cat-alc", "Cabernet"), categoryTaxAmount: 0.5 },
        ],
      });

      const result = (await service.createInvoiceFromOrder("ord-inv")) as any[];
      expect(result).toHaveLength(2);
      const [primary, sibling] = result;
      // Standard sibling: subtotal 20, regular tax 2, category tax 0 → total 22.
      expect(Number(primary.total)).toBe(22);
      // Alcohol sibling: subtotal 10, regular tax 1, category tax 0.50 → total 11.50.
      expect(Number(sibling.taxAmount)).toBe(1.5);
      expect(Number(sibling.total)).toBe(11.5);
      // INVARIANT: Σ sibling totals == order total (33.50).
      const orderTotal = 30 + 3 + 0.5;
      expect(Number(primary.total) + Number(sibling.total)).toBe(orderTotal);
    });

    it("RF-4: a tax-exempt customer owes $0 of BOTH regular AND category tax", async () => {
      setupSplitSpies();
      prisma.customer.findFirst.mockResolvedValue({ isTaxExempt: true });
      prisma.trackedCategory.findMany.mockResolvedValue([
        {
          id: "cat-alc",
          name: "Alcohol",
          invoiceTreatment: "SEPARATE_INVOICE",
          taxType: "PERCENT_OF_SALE",
          rate: 0.05,
        },
      ]);
      prisma.order.findUnique.mockResolvedValue({
        id: "ord-ex",
        customerId: "cust-1",
        orderNumber: "ORD-EX",
        subtotal: 30,
        tax: 3,
        lineItems: [
          line("std", null, "Widget"),
          { ...line("alc", "cat-alc", "Cabernet"), categoryTaxAmount: 0.5 },
        ],
      });

      const result = (await service.createInvoiceFromOrder("ord-ex")) as any[];
      // Both siblings: 0 tax. Total charged = subtotal only (no regular OR category tax).
      const totalTax = result.reduce((s, inv) => s + Number(inv.taxAmount), 0);
      expect(totalTax).toBe(0);
      const totalCharged = result.reduce((s, inv) => s + Number(inv.total), 0);
      expect(totalCharged).toBe(30); // subtotal only
      // The exempt customer's per-line category-tax snapshot is zeroed too, so the
      // created InvoiceItems (and the regulated-sales ledger) record $0 category tax.
      const createdItems = prisma.invoice.create.mock.calls.flatMap(
        (c: any) => c[0].data.items.create as any[],
      );
      expect(createdItems.length).toBeGreaterThan(0);
      for (const it of createdItems) {
        expect(Number(it.categoryTaxAmount ?? 0)).toBe(0);
      }
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

    // ─── Shipping fee seeding (WP2) ───────────────────────────────────────────

    it("seeds Invoice.shippingFee from the order for a single (non-split) invoice", async () => {
      setupSplitSpies();
      prisma.trackedCategory.findMany.mockResolvedValue([]);
      prisma.order.findUnique.mockResolvedValue({
        id: "ord-fee1",
        customerId: "cust-1",
        orderNumber: "ORD-FEE1",
        subtotal: 20,
        tax: 2,
        shippingFee: 6,
        lineItems: [line("std", null, "Widget")],
      });

      const result = (await service.createInvoiceFromOrder("ord-fee1")) as any[];
      expect(result).toHaveLength(1);
      expect(Number(result[0].shippingFee)).toBe(6);
      // subtotal 20 + tax 2 + fee 6 = 28.
      expect(Number(result[0].total)).toBe(28);
    });

    it("split — the WHOLE fee lands on exactly the largest-subtotal sibling, never prorated", async () => {
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
        id: "ord-fee2",
        customerId: "cust-1",
        orderNumber: "ORD-FEE2",
        subtotal: 30,
        tax: 3,
        shippingFee: 6,
        lineItems: [line("std", null, "Widget"), line("tob", "cat-tob", "Cigarillos")],
      });

      const result = (await service.createInvoiceFromOrder("ord-fee2")) as any[];
      const [primary, sibling] = result;
      // std group $20 > tobacco group $10 → the whole $6 fee lands on the primary.
      expect(Number(primary.subtotal)).toBe(20);
      expect(Number(sibling.subtotal)).toBe(10);
      expect(Number(primary.shippingFee)).toBe(6);
      expect(Number(sibling.shippingFee)).toBe(0);
      // INVARIANT: Σ sibling totals == order total (30 + 3 tax + 6 fee = 39).
      expect(Number(primary.total) + Number(sibling.total)).toBe(39);
    });

    it("tax-exempt customer: the fee is STILL charged even though tax is zeroed", async () => {
      setupSplitSpies();
      prisma.customer.findFirst.mockResolvedValue({ isTaxExempt: true });
      prisma.trackedCategory.findMany.mockResolvedValue([]);
      prisma.order.findUnique.mockResolvedValue({
        id: "ord-fee3",
        customerId: "cust-1",
        orderNumber: "ORD-FEE3",
        subtotal: 20,
        tax: 2,
        shippingFee: 4,
        lineItems: [line("std", null, "Widget")],
      });

      const result = (await service.createInvoiceFromOrder("ord-fee3")) as any[];
      expect(Number(result[0].taxAmount)).toBe(0); // tax-exempt
      expect(Number(result[0].shippingFee)).toBe(4); // fee still applies
      expect(Number(result[0].total)).toBe(24); // 20 + 0 + 4
    });

    // ─── Order discount carry (WP2 — sale integrity phase 2) ──────────────────
    // createSplitInvoices allocates order.discountAmount across sibling groups
    // proportionally by subtotal, MIRRORING the regular-tax allocator directly
    // above: roundMoney each share, largest-subtotal group absorbs the rounding
    // remainder, and each group's total subtracts its own discount share.

    it("fully discounts a single-group order: invoice discount 20, total 0", async () => {
      setupSplitSpies();
      prisma.trackedCategory.findMany.mockResolvedValue([]);
      prisma.order.findUnique.mockResolvedValue({
        id: "ord-disc1",
        customerId: "cust-1",
        orderNumber: "ORD-DISC1",
        subtotal: 20,
        tax: 0,
        discountAmount: 20,
        lineItems: [line("std", null, "Widget")],
      });

      const result = (await service.createInvoiceFromOrder("ord-disc1")) as any[];
      expect(result).toHaveLength(1);
      expect(Number(result[0].discount)).toBe(20);
      expect(Number(result[0].total)).toBe(0);
    });

    it("prorates the order discount across split siblings — shares sum to the order total", async () => {
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
        id: "ord-disc2",
        customerId: "cust-1",
        orderNumber: "ORD-DISC2",
        subtotal: 30,
        tax: 3,
        discountAmount: 15,
        lineItems: [line("std", null, "Widget"), line("tob", "cat-tob", "Cigarillos")],
      });

      const result = (await service.createInvoiceFromOrder("ord-disc2")) as any[];
      expect(result).toHaveLength(2);
      const [primary, sibling] = result;
      // Standard group $20 of $30 subtotal → discount 15 × 20/30 = 10.
      expect(Number(primary.discount)).toBe(10);
      // Tobacco group $10 of $30 subtotal → discount 15 × 10/30 = 5.
      expect(Number(sibling.discount)).toBe(5);
      // Σ sibling discounts == the order's discountAmount exactly.
      expect(Number(primary.discount) + Number(sibling.discount)).toBe(15);
      // primary total = 20 subtotal + 2 tax − 10 discount = 12.
      expect(Number(primary.total)).toBe(12);
      // sibling total = 10 subtotal + 1 tax − 5 discount = 6.
      expect(Number(sibling.total)).toBe(6);
      // INVARIANT: Σ sibling totals == order total (30 + 3 tax − 15 discount = 18).
      expect(Number(primary.total) + Number(sibling.total)).toBe(18);
    });

    it("gives the rounding remainder to the largest-subtotal group, same as the tax allocator", async () => {
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
      // Three equal-subtotal groups ($10 each) — naive proportional rounding
      // (10 × 10/30 = 3.333…) rounds every share to $3.33, leaving a $0.01
      // remainder that must land on exactly one group, never dropped.
      prisma.order.findUnique.mockResolvedValue({
        id: "ord-disc3",
        customerId: "cust-1",
        orderNumber: "ORD-DISC3",
        subtotal: 30,
        tax: 0,
        discountAmount: 10,
        lineItems: [mkLine("std", null, 10), mkLine("a", "cat-a", 10), mkLine("b", "cat-b", 10)],
      });

      const result = (await service.createInvoiceFromOrder("ord-disc3")) as any[];
      expect(result).toHaveLength(3);
      const discounts = result.map((inv: any) => Number(inv.discount)).sort((a, b) => a - b);
      expect(discounts).toEqual([3.33, 3.33, 3.34]);
      const discountSum = result.reduce((s: number, inv: any) => s + Number(inv.discount), 0);
      expect(Number(discountSum.toFixed(2))).toBe(10);
    });

    // A partially-invoiced order bills only `qty − invoicedQty`, so the discount
    // target must be scaled to the portion being billed — the SAME scaling the
    // regular-tax allocator does (totalRegularTax). Measuring the rounding
    // remainder against the FULL order discount dumped the whole discount onto
    // this second invoice: discount 20 on a $10 subtotal → total −10, and the
    // discount counted twice across siblings.
    it("only carries the REMAINING share of the discount when part of the order is already invoiced", async () => {
      setupSplitSpies();
      prisma.trackedCategory.findMany.mockResolvedValue([]);
      prisma.order.findUnique.mockResolvedValue({
        id: "ord-disc4",
        customerId: "cust-1",
        orderNumber: "ORD-DISC4",
        subtotal: 20,
        tax: 0,
        discountAmount: 20,
        lineItems: [
          {
            id: "std",
            productId: "p-std",
            qty: 2,
            invoicedQty: 1, // half the line already billed on a partial invoice
            unitPrice: 10,
            priceType: "STANDARD",
            trackedCategoryId: null,
            categoryTaxAmount: 0,
            product: { name: "Widget", unitsPerBox: 0, trackedCategoryId: null },
          },
        ],
      });

      const result = (await service.createInvoiceFromOrder("ord-disc4")) as any[];
      expect(result).toHaveLength(1);
      expect(Number(result[0].subtotal)).toBe(10); // remaining qty 1 × $10
      expect(Number(result[0].discount)).toBe(10); // 20 × 10/20 — not the full 20
      expect(Number(result[0].total)).toBe(0); // never negative
    });

    it("zero/undefined discountAmount produces byte-identical invoice.create payloads", async () => {
      setupSplitSpies();
      prisma.trackedCategory.findMany.mockResolvedValue([]);
      const baseOrder = {
        id: "ord-disc0",
        customerId: "cust-1",
        orderNumber: "ORD-DISC0",
        subtotal: 20,
        tax: 2,
        lineItems: [line("std", null, "Widget")],
      };

      // Call 1: no discountAmount field at all (today's callers before this order
      // field existed / a draft order that never set one).
      prisma.order.findUnique.mockResolvedValueOnce({ ...baseOrder });
      await service.createInvoiceFromOrder("ord-disc0");
      const withoutField = prisma.invoice.create.mock.calls[0][0].data;

      prisma.invoice.create.mockClear();
      prisma.orderItem.update.mockClear();

      // Call 2: discountAmount explicitly 0.
      prisma.order.findUnique.mockResolvedValueOnce({ ...baseOrder, discountAmount: 0 });
      await service.createInvoiceFromOrder("ord-disc0");
      const withZeroField = prisma.invoice.create.mock.calls[0][0].data;

      // DEEP-EQUAL: the discount allocator must not perturb a single byte of the
      // create payload when there is nothing to allocate.
      expect(withZeroField).toEqual(withoutField);
      expect(withZeroField.discount).toBe(0);
      expect(Number(withZeroField.total)).toBe(22); // 20 subtotal + 2 tax − 0 discount
    });
  });

  describe("updateInvoiceShipment", () => {
    it("sets carrier + tracking + shippedAt on a non-void invoice", async () => {
      prisma.invoice.findFirst.mockResolvedValue({ id: "inv-1", status: "SENT", shippedAt: null });
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
      prisma.invoice.findFirst.mockResolvedValue({ id: "inv-1", status: "VOID", shippedAt: null });
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

    // BUY_N_GET_M partials: free units are WHOLE units, so prorating the money over
    // the raw piece count while flooring the free units over the same count made the
    // two disagree by up to one unit price — and `update()` re-prices a DRAFT from
    // the stored promoFreeUnits, so a no-op re-save moved the money ($145.83 → $175).
    // The proration now keys on the PAID qty, keeping both in step.
    it("keeps a BOGO partial's stored money and free-unit snapshot in agreement", () => {
      // 12 boxes of 100 @ $35/box with 2 free = $350.00 agreed. Billed 5 boxes then 7.
      const li = {
        id: "oi-6",
        productId: "p-6",
        qty: 1200,
        boxes: 12,
        pieces: 0,
        unitsPerBox: 100,
        unitPrice: 35,
        subtotal: 350,
        promoFreeUnits: 2,
        product: { name: "BOGO Boxed", unitsPerBox: 100 },
      };
      const partials: Array<[any, number]> = [
        [build(li, 500, { priorBilledQty: 0 }), 5],
        [build(li, 700, { priorBilledQty: 500 }), 7],
      ];

      // Σ(partials) is still exactly the order line's money AND its free units.
      expect(roundMoney(partials.reduce((s, [p]) => s + p.subtotal, 0))).toBe(350);
      expect(partials.reduce((s, [p]) => s + (p.promoFreeUnits ?? 0), 0)).toBe(2);

      // Each partial's stored subtotal is exactly what a DRAFT re-save recomputes
      // from the stored snapshot (what the edit form previews and update() writes).
      for (const [line, boxes] of partials) {
        expect(line.boxes).toBe(boxes);
        expect(
          computeLineSubtotal({
            unitPrice: 35,
            qty: line.qty,
            boxes: line.boxes,
            pieces: line.pieces,
            unitsPerBox: 100,
            freeUnits: line.promoFreeUnits ?? 0,
          }),
        ).toBe(line.subtotal);
      }
    });

    it("copies a BOGO line verbatim on a full bill (free units and money both)", () => {
      const li = {
        id: "oi-7",
        productId: "p-7",
        qty: 1200,
        boxes: 12,
        pieces: 0,
        unitsPerBox: 100,
        unitPrice: 35,
        subtotal: 350,
        promoFreeUnits: 2,
        product: { name: "BOGO Boxed", unitsPerBox: 100 },
      };
      const line = build(li, 1200);
      expect(line.subtotal).toBe(350);
      expect(line.promoFreeUnits).toBe(2);
    });
  });

  // ── F03 (T-B50s / REG-B50s): buildInvoiceItemData's telescoping proration must
  // cap billedThrough(cumQty) at basisQty on BOTH telescope points. With
  // freeUnitSize > 1 the floored free-unit allocation (freeUnitsThrough) lands
  // only near 100% delivered, so an UNCAPPED billedThrough can exceed basisQty
  // for a cumQty still short of orderQty — a boxed BOGO line of 48 pieces
  // (unitsPerBox 6, 2 free boxes ⇒ basisQty 36 paid pieces): billing 47 of 48
  // (one piece short of orderQty), freeUnitsThrough(47) floors to 1 (the second
  // free box isn't "earned" until the very last piece), so billedThrough(47) =
  // 47 − 1×6 = 41 — 5 MORE than the line's whole paid basis (36). Uncapped, that
  // partial would bill 41/36 of the $360 agreed subtotal ($410) — more than the
  // customer ever owed for the entire line.
  //
  // Token note: the describe carries `REG-B50s` (NOT `REG-B50`) on purpose. The bare
  // `REG-B50` token is owned by the SHIPPED F04 parity tests, which now live in
  // packages/pricing/src/golden.spec.ts (the data-driven `prorateLineSubtotal —
  // PRORATE_LINE_SUBTOTAL_FIXTURES (REG-B50)` describe) and in
  // apps/mobile/__tests__/short-pick-prorate.test.ts. Both are separate Jest projects,
  // so an `apps/api`-scoped `-t REG-B50` run no longer collides — but the `REG-B50s`
  // token is kept so the F03 gate regex
  // `-t "REG-B(11|57|74|81|84|85|102|103)|REG-B50s"` stays stable and unambiguous
  // across projects.
  const B50S_LINE = {
    id: "oi-50",
    productId: "p-50",
    qty: 48,
    boxes: 8,
    pieces: 0,
    unitsPerBox: 6,
    unitPrice: 60,
    subtotal: 360,
    promoFreeUnits: 2,
    product: { name: "BOGO Boxed Cap", unitsPerBox: 6 },
  };

  describe("buildInvoiceItemData — caps billedThrough at basisQty on a boxed BOGO partial (T-B50s / REG-B50s)", () => {
    const build = (li: any, billQty: number, opts?: { priorBilledQty?: number }) =>
      (service as any).buildInvoiceItemData(li, billQty, "test-tenant", opts);

    // 8 boxes of 6 = 48 pieces @ $60/box, 2 free boxes ⇒ paid basis = 6 boxes =
    // 36 pieces ⇒ $360 stored subtotal (6 paid boxes × $60).
    const li = B50S_LINE;

    it("never bills above the stored line subtotal on a partial one piece short of orderQty", () => {
      // cumQty 47 of 48: uncapped billedThrough would be 41 > basisQty 36, i.e.
      // a $410 bill against a $360 agreed line. Capped, it must land at exactly
      // $360 — the whole paid basis is already delivered by piece 47.
      const partial = build(li, 47, { priorBilledQty: 0 });
      expect(partial.subtotal).toBe(360);
    });

    it("bills nothing further once the cap already captured the full subtotal (kills a one-sided cap)", () => {
      // Finishing the delivery (piece 48, prior 47) must bill $0 more: the cap
      // already collected the whole $360 at piece 47. Capping only the
      // (prior+billQty) telescope point but leaving the `prior` point uncapped
      // would compute round(360×36/36) − round(360×41/36) = 360 − 410 = −$50 —
      // a negative bill — so this proves the cap must apply to BOTH points.
      const finisher = build(li, 1, { priorBilledQty: 47 });
      expect(finisher.subtotal).toBe(0);

      // …and the round-trip the cap must not break: a FULL bill still reproduces
      // the stored subtotal exactly (billedThrough(48) = 48 − 2×6 = 36 = basisQty,
      // so the cap is the identity here). Folded into this case on purpose — on its
      // own it discriminates nothing about the cap and would be an always-green,
      // requirement-ID-less test; paired with the $0 finisher above it pins that the
      // cap clamps AT basisQty and never BELOW it.
      expect(build(li, 48, { priorBilledQty: 0 }).subtotal).toBe(360);
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

    // B1 (WP-D1): a deposit mirror issued at ORDER PLACEMENT is SENT on purpose, and
    // reverting it is IRREVERSIBLE (a pre-delivery order-linked DRAFT can never be
    // re-sent). It is exempt — the widened reconcile keeps it in lockstep instead.
    it("does NOT revert an unpaid issued deposit mirror — it stays SENT and the widened reconcile rebuilds its totals", async () => {
      prisma.invoice.findMany.mockResolvedValue([
        {
          id: "inv-dep",
          invoiceNumber: "INV-DEP",
          internalNotes: null,
          status: InvoiceStatus.SENT,
          deliveryBatchId: null,
          depositPercent: 30,
          discount: 0,
          shippingFee: 0,
          dueDate: new Date("2099-10-01"),
          items: [],
          payments: [],
        },
      ]);
      prisma.order.findFirst.mockResolvedValue({ status: "PENDING" });
      prisma.invoice.count.mockResolvedValue(1); // the order's SOLE non-void invoice

      const reverted = await service.revertLinkedInvoicesForOrderEdit("o-dep");

      expect(reverted).toEqual([]);
      expect(prisma.invoice.update).not.toHaveBeenCalled();
      // Skipped outright — not even the payment probe (so a PAID deposit can't block
      // the edit the way the legacy revert does).
      expect(prisma.invoicePayment.count).not.toHaveBeenCalled();

      // …and the post-edit reconcile rebuilds that same invoice in place, still issued.
      prisma.invoice.findFirst.mockResolvedValue(null); // no open DRAFT to find
      prisma.order.findUnique.mockResolvedValue({
        id: "o-dep",
        customerId: "c1",
        subtotal: 50,
        tax: 5,
        lineItems: [
          {
            id: "li1",
            productId: "p1",
            qty: 10,
            deliveredQty: 10,
            unitPrice: 5,
            originalPrice: null,
            priceType: "STANDARD",
            product: { name: "P1" },
            status: "PENDING",
          },
        ],
      });
      prisma.customer.findFirst.mockResolvedValue({ isTaxExempt: false });
      prisma.invoice.aggregate.mockResolvedValue({ _sum: { shippingFee: 0 } });
      prisma.orderItem.findMany.mockResolvedValue([{ id: "li1" }]);
      prisma.invoice.update.mockImplementation((args: any) =>
        Promise.resolve({ id: "inv-dep", ...args.data }),
      );

      await service.reconcileOrderDraftInvoice("o-dep", { basis: "order" });

      const data = prisma.invoice.update.mock.calls[0][0].data;
      expect(data.total).toBeCloseTo(55, 2); // 10 × $5 + $5 tax
      expect(data.status).toBe(InvoiceStatus.SENT); // still issued; nothing paid yet
    });

    it("still reverts a deposit mirror once the order is DELIVERED (outside the reconcile fence)", async () => {
      prisma.invoice.findMany.mockResolvedValue([
        { id: "inv-dep", invoiceNumber: "INV-DEP", internalNotes: null, depositPercent: 30 },
      ]);
      prisma.order.findFirst.mockResolvedValue({ status: "DELIVERED" });
      prisma.invoice.count.mockResolvedValue(1);
      prisma.invoicePayment.count.mockResolvedValue(0);
      prisma.invoice.update.mockResolvedValue({ id: "inv-dep", status: "DRAFT" });

      expect(await service.revertLinkedInvoicesForOrderEdit("o-dep")).toEqual(["inv-dep"]);
    });

    it("still reverts a deposit invoice when the order has OTHER non-void invoices (split/partial — the reconcile can't cover it)", async () => {
      prisma.invoice.findMany.mockResolvedValue([
        { id: "inv-dep", invoiceNumber: "INV-DEP", internalNotes: null, depositPercent: 30 },
      ]);
      prisma.order.findFirst.mockResolvedValue({ status: "PENDING" });
      prisma.invoice.count.mockResolvedValue(2); // not the sole invoice
      prisma.invoicePayment.count.mockResolvedValue(0);
      prisma.invoice.update.mockResolvedValue({ id: "inv-dep", status: "DRAFT" });

      expect(await service.revertLinkedInvoicesForOrderEdit("o-dep")).toEqual(["inv-dep"]);
    });
  });

  // The payment count that decides "block or revert" is only trustworthy while the Invoice row is
  // held — recordPayment locks the same row before it writes. `lockRows` is what an in-tx caller
  // (the at-door merge) passes to close that window.
  describe("revertLinkedInvoicesForOrderEdit lockRows", () => {
    const revertTx = () => ({
      invoice: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: "inv-1", invoiceNumber: "INV-1", internalNotes: null }]),
        update: jest.fn().mockResolvedValue({ id: "inv-1", status: "DRAFT" }),
        count: jest.fn().mockResolvedValue(1),
      },
      invoicePayment: { count: jest.fn().mockResolvedValue(0) },
      order: { findFirst: jest.fn().mockResolvedValue({ status: "PENDING" }) },
      $executeRaw: jest.fn().mockResolvedValue(0),
    });

    it("P15: locks the Invoice row (NOWAIT) BEFORE counting its payments", async () => {
      const tx = revertTx();

      await service.revertLinkedInvoicesForOrderEdit("ord-1", tx, { lockRows: true });

      const sql = tx.$executeRaw.mock.calls[0][0].join("?");
      expect(sql).toContain('"Invoice"');
      expect(sql).toContain("FOR NO KEY UPDATE NOWAIT");
      expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
        tx.invoicePayment.count.mock.invocationCallOrder[0],
      );
    });

    it("P16: a row held by an in-flight payment (55P03) refuses as retryable CONCURRENT_UPDATE and reverts nothing", async () => {
      const tx = revertTx();
      const lockErr: any = new Error("Raw query failed");
      lockErr.meta = { code: "55P03" };
      tx.$executeRaw.mockRejectedValueOnce(lockErr);

      const err = await service
        .revertLinkedInvoicesForOrderEdit("ord-1", tx, { lockRows: true })
        .catch((e) => e);

      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toMatchObject({
        code: "CONCURRENT_UPDATE",
        reason: "INVOICE_BUSY",
        retryable: true,
      });
      expect(tx.invoice.update).not.toHaveBeenCalled();
    });

    it("P17: without the flag no lock is taken — every existing caller is unchanged", async () => {
      const tx = revertTx();

      expect(await service.revertLinkedInvoicesForOrderEdit("ord-1", tx)).toEqual(["inv-1"]);

      expect(tx.$executeRaw).not.toHaveBeenCalled();
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

  // F03 (T-B84 / R6 / REG-B84): voidInvoiceInTx has no atomic claim — a double-click
  // or a retried request lets two concurrent voids both "succeed" and both release
  // invoicedQty. R6's fix is `updateMany({ where: { id, status: { not: VOID } } })`,
  // abort on count===0 — the same claim shape returns.service.ts's void path uses.
  // See .claude/pipeline/2026-08-31-f03-payment-truth/{spec,test-plan}.md R6/T-B84.
  describe("voidInvoiceInTx — atomic claim under concurrent void (T-B84 / R6 / REG-B84)", () => {
    it("two concurrent voidInvoice calls on one SENT invoice: exactly one succeeds, invoicedQty releases exactly once", async () => {
      prisma.invoice.findUnique.mockResolvedValue({
        id: "inv-race",
        status: InvoiceStatus.SENT,
        orderId: "ord-race",
        payments: [],
      });

      // Fake-store claim, modeling Postgres's real conditional-update semantics:
      // `updateMany` only "claims" the row (and flips it to VOID) while it is
      // NOT already VOID, exactly like a real `WHERE id = ? AND status <> 'VOID'`
      // would. A plain `.update()` mock (today's actual code path) has no way to
      // express "count===0 because a concurrent caller already claimed it" —
      // that's precisely the race this fake exists to make observable.
      let liveStatus: string = InvoiceStatus.SENT;
      prisma.invoice.updateMany.mockImplementation(async (args: any) => {
        const where = args?.where ?? {};
        if (where.id !== "inv-race") return { count: 0 };
        const excludesVoid = where.status && (where.status as any).not === InvoiceStatus.VOID;
        if (excludesVoid && liveStatus === InvoiceStatus.VOID) return { count: 0 };
        liveStatus = (args?.data?.status as string) ?? liveStatus;
        return { count: 1 };
      });

      // Fake orderItem row, live-mutated by whichever call actually wins the
      // claim — the same reasoning as above: a static/stale mock can't
      // distinguish "released once" from "released twice".
      const orderItemRow = { id: "oi-race", productId: "p-race", qty: 10, invoicedQty: 10 };
      prisma.invoiceItem.findMany.mockResolvedValue([
        { productId: "p-race", qty: 3, orderItemId: "oi-race" },
      ]);
      prisma.orderItem.findMany.mockImplementation(async () => [{ ...orderItemRow }]);
      prisma.orderItem.update.mockImplementation(async (args: any) => {
        if (args?.where?.id === "oi-race") orderItemRow.invoicedQty = args.data.invoicedQty;
        return { ...orderItemRow };
      });

      const results = await Promise.allSettled([
        service.voidInvoice("inv-race"),
        service.voidInvoice("inv-race"),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      // Today: voidInvoiceInTx does a plain `tx.invoice.update(...)` with no
      // status filter at all, so BOTH calls succeed — red now (fulfilled has 2).
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      // Exactly one release of this invoice line's 3 units (10 -> 7). Today's
      // unconditional double-void releases it twice (10 -> 4).
      expect(orderItemRow.invoicedQty).toBe(7);
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
      prisma.invoice.findFirst.mockResolvedValue({
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
      prisma.invoice.findFirst.mockResolvedValue({
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
        data: {
          checkStatus: CheckStatus.CLEARED,
          clearedAt: expect.any(Date),
        },
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
          // The commission engine excludes this line from the base by this exact
          // prefix — the writer must never drift from the shared constant.
          description: expect.stringMatching(/^NSF fee — returned check/),
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
        payments: [{ id: "pay-2", amount: 40, status: "PAID" }],
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

    // F03 (T-B11s / R1 / REG-B11) — the BOUNCED branch re-reads the invoice's
    // surviving payments to recompute status, and that read is a payment SUM, so it
    // is on the CONFIRMED basis. The fixture reproduces the database rather than
    // handing over a pre-filtered list: findUnique honours whatever
    // `include.payments.where` the service passes, so a `not: VOID` query really does
    // get the DRAFT row back and the assertion pins the resulting NUMBER, not a query
    // shape. $130 invoice, the bounced $100 plus $80 confirmed and $50 unconfirmed:
    // survivors on the CONFIRMED basis are $80 of $130 ⇒ PARTIAL. A non-VOID sum sees
    // $130 ⇒ PAID, so a returned check would leave the invoice reading fully paid.
    it("REG-B11: an unconfirmed DRAFT survivor never funds the post-bounce status recompute", async () => {
      const rows = [
        { id: "pay-1", amount: 100, status: "VOID" }, // the check just bounced
        { id: "pay-2", amount: 80, status: "PAID" },
        { id: "pay-3", amount: 50, status: "DRAFT" },
      ];
      prisma.invoicePayment.findFirst.mockResolvedValue({
        ...basePayment,
        checkStatus: CheckStatus.DEPOSITED,
      });
      prisma.invoicePayment.updateMany.mockResolvedValue({ count: 1 });
      prisma.invoice.findUnique.mockImplementation(async (args: any) => ({
        id: "inv-1",
        invoiceNumber: "INV-0001",
        customerId: "cust-1",
        status: InvoiceStatus.PAID,
        subtotal: 130,
        total: 130,
        dueDate: null,
        paidAt: new Date("2026-01-05"),
        payments: filterPayments(rows as any, args?.include?.payments?.where),
      }));

      await service.setCheckStatus("inv-1", "pay-1", { status: CheckStatus.BOUNCED });

      expect(prisma.invoice.update).toHaveBeenCalledWith({
        where: { id: "inv-1" },
        data: { status: InvoiceStatus.PARTIAL, paidAt: null },
      });
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
      prisma.invoice.findFirst.mockResolvedValue({
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

  // F03 (T-B11s / R1 / REG-B11): findAll's balanceDue must be computed from
  // CONFIRMED (PAID) payments only — an unconfirmed DRAFT payment (e.g. a bulk
  // bank-reconciliation entry an operator hasn't confirmed yet) must not be
  // silently folded into the invoice list's own balance-due number. See
  // .claude/pipeline/2026-08-31-f03-payment-truth/{spec,test-plan}.md R1/T-B11s.
  // This is the findAll leg only — the three bookkeeping dashboards (same bug,
  // same predicate) are proven in bookkeeping.service.spec.ts, a separate package.
  describe("findAll — balanceDue counts only CONFIRMED (PAID) payments (T-B11s / R1 / REG-B11)", () => {
    it("a $500 invoice with $200 PAID + $300 DRAFT reports balanceDue $300, not $0", async () => {
      prisma.invoice.findMany.mockResolvedValue([
        {
          id: "inv-b11",
          status: InvoiceStatus.PARTIAL,
          total: 500,
          dueDate: null,
          depositPercent: null,
          depositDueDate: null,
          payments: [
            { id: "pay-confirmed", amount: 200, status: "PAID" },
            { id: "pay-draft", amount: 300, status: "DRAFT" },
          ],
        },
      ]);
      prisma.invoice.count.mockResolvedValue(1);

      const result = await service.findAll({} as any);

      // Today: `p.status !== "VOID"` counts the DRAFT $300 as paid too, so
      // paidAmount is $500 and balanceDue floors at $0 — red now. The DRAFT
      // payment must stay invisible to this total until an operator confirms
      // it (recordPayment/recordStandalonePayment only advance invoice.status
      // on PAID, so a lying balanceDue disagrees with status on top of it).
      expect(result.data[0]).toMatchObject({ paidAmount: 200, balanceDue: 300 });
    });
  });

  // ─── P5-12 fallout — VOID payments excluded from balance math ────────────────
  // A bounced check flips its InvoicePayment.status to VOID and reverts the invoice
  // to OPEN/PARTIAL. Any sum of payment amounts that ignored VOID under-states the
  // balance; these lock in the payment-level filter that findOne already had.
  // WP3 — the invoices page's Due today / Due tomorrow / Next 7 days chips send a
  // dueFrom/dueTo window. findAll must translate it into a `dueDate` range; without
  // it the chips silently return every unpaid invoice (indistinguishable from no filter).
  describe("WP3 — findAll due-date window (dueFrom/dueTo)", () => {
    const whereArg = () => prisma.invoice.findMany.mock.calls[0][0].where;

    beforeEach(() => {
      prisma.invoice.findMany.mockResolvedValue([]);
      prisma.invoice.count.mockResolvedValue(0);
    });

    // T1-pin (L-047): dueDate is a UTC-midnight stamp — its end-of-day bound is a
    // LITERAL UTC instant, never a host-local `setHours` mutation (that self-referential
    // oracle agreed with the buggy code on every host whose local TZ is UTC, CI included,
    // and silently disagreed everywhere else).
    it("passes dueFrom/dueTo through as a dueDate range, widening dueTo to end-of-day", async () => {
      await service.findAll({ dueFrom: "2026-08-26", dueTo: "2026-08-26" } as any);

      expect(whereArg().dueDate).toEqual({
        gte: new Date("2026-08-26"),
        lte: new Date("2026-08-26T23:59:59.999Z"),
      });
    });

    it("accepts dueFrom alone (open-ended window)", async () => {
      await service.findAll({ dueFrom: "2026-08-26" } as any);

      expect(whereArg().dueDate).toEqual({ gte: new Date("2026-08-26") });
    });

    it("leaves `where` untouched when both are omitted", async () => {
      await service.findAll({} as any);

      expect(whereArg()).not.toHaveProperty("dueDate");
    });

    it("intersects with isOverdue's dueDate instead of clobbering it", async () => {
      await service.findAll({ isOverdue: true, dueFrom: "2026-08-01" } as any);

      const dueDate = whereArg().dueDate;
      expect(dueDate.gte).toEqual(new Date("2026-08-01"));
      expect(dueDate.lt).toBeInstanceOf(Date); // isOverdue's "past due" bound survives
    });
  });

  // ─── T1 (REG-B89) — day-window bounds, per column convention (L-047) ────────
  // `paidAt` is a REAL instant: its calendar-day bounds must be evaluated in the
  // TENANT's own timezone, never the host clock's. `issueDate` is a UTC-midnight
  // calendar-date stamp: its bounds are the LITERAL UTC instants of the
  // date-only strings, never a host-local `setHours` mutation (which silently
  // disagrees with both conventions off a UTC host — the zone is DATA here, not
  // read from the environment; see the pinned rewrite above for the sibling
  // dueDate leg).
  describe("REG-B89 — paidAt (tenant-local) vs issueDate (UTC-literal) day-window bounds", () => {
    beforeEach(() => {
      // Zone as DATA (L-047): the tenant is explicitly America/New_York regardless
      // of whatever timezone this test happens to run under.
      jest.spyOn(service as any, "resolveTenantInvoiceDefaults").mockResolvedValue({
        notes: null,
        terms: null,
        timezone: "America/New_York",
      });
    });

    it("listAllPayments: paidAt bounds are America/New_York calendar-day boundaries, not host-local midnight", async () => {
      prisma.invoicePayment.findMany.mockResolvedValue([]);
      prisma.invoicePayment.count.mockResolvedValue(0);

      await service.listAllPayments({ dateFrom: "2026-08-26", dateTo: "2026-08-26" });

      const where = prisma.invoicePayment.findMany.mock.calls[0][0].where;
      // NY is UTC-4 in August (EDT): local midnight Aug 26 = 04:00 UTC; local
      // day-end Aug 26 23:59:59.999 = 03:59:59.999 UTC the NEXT calendar day.
      expect(where.paidAt).toEqual({
        gte: new Date("2026-08-26T04:00:00.000Z"),
        lte: new Date("2026-08-27T03:59:59.999Z"),
      });
    });

    it("findAll: issueDate bounds are the literal UTC instants of the calendar-date strings", async () => {
      prisma.invoice.findMany.mockResolvedValue([]);
      prisma.invoice.count.mockResolvedValue(0);

      await service.findAll({ dateFrom: "2026-08-26", dateTo: "2026-08-26" } as any);

      const where = prisma.invoice.findMany.mock.calls[0][0].where;
      expect(where.issueDate).toEqual({
        gte: new Date("2026-08-26T00:00:00.000Z"),
        lte: new Date("2026-08-26T23:59:59.999Z"),
      });
    });

    // The CSV export is the SECOND paidAt site B89 changed; without this the
    // whole tenant-local window could be re-broken there alone and the suite
    // would stay green on a UTC host (CI included).
    it("exportPayments: paidAt bounds are America/New_York calendar-day boundaries", async () => {
      prisma.invoicePayment.findMany.mockResolvedValue([]);

      await service.exportPayments({ dateFrom: "2026-08-26", dateTo: "2026-08-26" });

      const where = prisma.invoicePayment.findMany.mock.calls[0][0].where;
      expect(where.paidAt).toEqual({
        gte: new Date("2026-08-26T04:00:00.000Z"),
        lte: new Date("2026-08-27T03:59:59.999Z"),
      });
    });

    // The day-end/day-start instants are composed by CONCATENATING a time
    // suffix onto the raw query param, so the param must be normalised to its
    // calendar day FIRST: `dueTo` is `@IsDateString()` (a full ISO datetime
    // passes validation) and the payments routes carry no DTO at all, so a raw
    // concatenation would hand Prisma an Invalid Date bound.
    it("findAll: a full ISO datetime dueTo still yields that calendar day's UTC day-end bound", async () => {
      prisma.invoice.findMany.mockResolvedValue([]);
      prisma.invoice.count.mockResolvedValue(0);

      await service.findAll({ dueTo: "2026-08-26T00:00:00.000Z" } as any);

      const where = prisma.invoice.findMany.mock.calls[0][0].where;
      expect(where.dueDate.lte).toEqual(new Date("2026-08-26T23:59:59.999Z"));
    });

    it("listAllPayments: a full ISO datetime dateFrom still yields that calendar day's tenant-local start", async () => {
      prisma.invoicePayment.findMany.mockResolvedValue([]);
      prisma.invoicePayment.count.mockResolvedValue(0);

      await service.listAllPayments({ dateFrom: "2026-08-26T12:00:00.000Z" });

      const where = prisma.invoicePayment.findMany.mock.calls[0][0].where;
      expect(where.paidAt.gte).toEqual(new Date("2026-08-26T04:00:00.000Z"));
    });

    it("findAll: an unparsable dateTo is rejected before any query runs", async () => {
      prisma.invoice.findMany.mockResolvedValue([]);
      prisma.invoice.count.mockResolvedValue(0);

      await expect(service.findAll({ dateTo: "not-a-date" } as any)).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.invoice.findMany).not.toHaveBeenCalled();
    });

    // The payments routes carry NO DTO (bare `@Query("dateTo")`), so the
    // service is the only gate: an unparsable value must 400 rather than reach
    // Prisma as an `Invalid Date` bound — the same guard the `dateFrom` leg
    // already had, on BOTH payments sites.
    it("listAllPayments: an unparsable dateTo is rejected before any query runs", async () => {
      prisma.invoicePayment.findMany.mockResolvedValue([]);
      prisma.invoicePayment.count.mockResolvedValue(0);

      await expect(service.listAllPayments({ dateTo: "not-a-date" })).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.invoicePayment.findMany).not.toHaveBeenCalled();
    });

    it("exportPayments: an unparsable dateTo is rejected before any query runs", async () => {
      prisma.invoicePayment.findMany.mockResolvedValue([]);

      await expect(service.exportPayments({ dateTo: "not-a-date" })).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.invoicePayment.findMany).not.toHaveBeenCalled();
    });

    it("listAllPayments: a full ISO datetime dateTo yields the same bound as its date-only form", async () => {
      prisma.invoicePayment.findMany.mockResolvedValue([]);
      prisma.invoicePayment.count.mockResolvedValue(0);

      await service.listAllPayments({ dateTo: "2026-08-26T12:00:00.000Z" });
      await service.listAllPayments({ dateTo: "2026-08-26" });

      const isoWhere = prisma.invoicePayment.findMany.mock.calls[0][0].where;
      const dayWhere = prisma.invoicePayment.findMany.mock.calls[1][0].where;
      expect(isoWhere.paidAt.lte).toEqual(new Date("2026-08-27T03:59:59.999Z"));
      expect(isoWhere.paidAt.lte).toEqual(dayWhere.paidAt.lte);
    });

    // The `gte` legs are UTC-midnight calendar stamps too: a full ISO
    // `dateFrom` used raw narrows the window past that day's own stamp and
    // drops every invoice issued on it.
    it("findAll: a full ISO datetime dateFrom/dueFrom still yields that calendar day's UTC day-start", async () => {
      prisma.invoice.findMany.mockResolvedValue([]);
      prisma.invoice.count.mockResolvedValue(0);

      await service.findAll({
        dateFrom: "2026-08-26T12:00:00.000Z",
        dueFrom: "2026-08-26T12:00:00.000Z",
      } as any);

      const where = prisma.invoice.findMany.mock.calls[0][0].where;
      expect(where.issueDate.gte).toEqual(new Date("2026-08-26T00:00:00.000Z"));
      expect(where.dueDate.gte).toEqual(new Date("2026-08-26T00:00:00.000Z"));
    });
  });

  // ─── T1-pin — duplicate() must stamp issueDate as a UTC-midnight calendar
  // stamp of "today", the same invariant every other issueDate write in this
  // file holds (L-047). Today `duplicate()`'s create() call omits issueDate
  // entirely, leaving it to whatever the schema default resolves to.
  describe("T1-pin — duplicate() stamps issueDate as UTC-midnight of today", () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    it("sets issueDate to the UTC-midnight stamp of the mocked clock's calendar day", async () => {
      jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
      jest.setSystemTime(new Date("2026-08-26T15:42:07.000Z"));

      const baseInv = {
        id: "inv-dup-1",
        orderId: null,
        customerId: "cust-1",
        invoiceNumber: "INV-2026-0099",
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
      prisma.invoice.create.mockResolvedValue({ ...baseInv, id: "inv-dup-2" });

      await service.duplicate("inv-dup-1");

      const data = prisma.invoice.create.mock.calls[0][0].data;
      expect(data.issueDate).toEqual(new Date("2026-08-26T00:00:00.000Z"));
    });
  });

  // ─── T2 (REG-B169) — orderBy carries an `id` tiebreaker. `issueDate`/`paidAt`
  // ties are STRUCTURAL (bulk imports, UTC-midnight stamps sharing a value), so
  // a single-key orderBy leaves page order unstable across identical requests —
  // a row can silently repeat or vanish across pages.
  describe("REG-B169 — orderBy carries an id tiebreaker", () => {
    it("findAll: default sort orders by issueDate desc, id desc", async () => {
      prisma.invoice.findMany.mockResolvedValue([]);
      prisma.invoice.count.mockResolvedValue(0);

      await service.findAll({} as any);

      expect(prisma.invoice.findMany.mock.calls[0][0].orderBy).toEqual([
        { issueDate: "desc" },
        { id: "desc" },
      ]);
    });

    it("findAll: sortBy=total&sortOrder=asc orders by total asc, id asc", async () => {
      prisma.invoice.findMany.mockResolvedValue([]);
      prisma.invoice.count.mockResolvedValue(0);

      await service.findAll({ sortBy: "total", sortOrder: "asc" } as any);

      expect(prisma.invoice.findMany.mock.calls[0][0].orderBy).toEqual([
        { total: "asc" },
        { id: "asc" },
      ]);
    });

    it("listAllPayments: default sort orders by paidAt desc, id desc", async () => {
      prisma.invoicePayment.findMany.mockResolvedValue([]);
      prisma.invoicePayment.count.mockResolvedValue(0);

      await service.listAllPayments({});

      expect(prisma.invoicePayment.findMany.mock.calls[0][0].orderBy).toEqual([
        { paidAt: "desc" },
        { id: "desc" },
      ]);
    });

    // m9 — the sort allowlists are plain object literals, so a bare index
    // lookup resolves INHERITED keys: `sortBy=constructor` returns Object's
    // constructor and `sortBy=__proto__` returns Object.prototype, either of
    // which reaches Prisma as a malformed orderBy (a 500 any unauthenticated-
    // ish caller with a query string can trigger). Both must fall back to the
    // same order the default does.
    it.each(["constructor", "__proto__", "toString", "valueOf"])(
      "findAll: sortBy=%s is not an allowlisted field — falls back to the default order",
      async (sortBy) => {
        prisma.invoice.findMany.mockResolvedValue([]);
        prisma.invoice.count.mockResolvedValue(0);

        await service.findAll({ sortBy } as any);

        expect(prisma.invoice.findMany.mock.calls[0][0].orderBy).toEqual([
          { issueDate: "desc" },
          { id: "desc" },
        ]);
      },
    );

    it.each(["constructor", "__proto__", "toString", "valueOf"])(
      "listAllPayments: sortBy=%s is not an allowlisted field — falls back to the default order",
      async (sortBy) => {
        prisma.invoicePayment.findMany.mockResolvedValue([]);
        prisma.invoicePayment.count.mockResolvedValue(0);

        await service.listAllPayments({ sortBy });

        expect(prisma.invoicePayment.findMany.mock.calls[0][0].orderBy).toEqual([
          { paidAt: "desc" },
          { id: "desc" },
        ]);
      },
    );

    // H3 — exportPayments carries the same sort allowlist as listAllPayments
    // (its own `Object.hasOwn` guard), so it needs the same prototype-key pin:
    // a bare index lookup there would hand Prisma `Object.prototype` as an
    // orderBy and 500 the CSV export.
    it.each(["constructor", "__proto__", "toString", "valueOf"])(
      "exportPayments: sortBy=%s is not an allowlisted field — falls back to the default order",
      async (sortBy) => {
        prisma.invoicePayment.findMany.mockResolvedValue([]);

        await expect(service.exportPayments({ sortBy })).resolves.toBeDefined();

        expect(prisma.invoicePayment.findMany.mock.calls[0][0].orderBy).toEqual([
          { paidAt: "desc" },
          { id: "desc" },
        ]);
      },
    );
  });

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

  // WP2 — a CREDIT_NOTE InvoicePayment is money-linked to a wallet (CreditNote.amountUsed);
  // deleting/voiding it directly would orphan that money. Both must refuse and point the
  // operator at the dedicated unapply endpoint instead.
  describe("WP2 — CREDIT_NOTE payments refuse delete/void", () => {
    it("deletePayment refuses to delete a CREDIT_NOTE payment", async () => {
      prisma.invoice.findUnique.mockResolvedValue({
        id: "inv-1",
        status: InvoiceStatus.PARTIAL,
        total: 100,
        dueDate: null,
        payments: [{ id: "pay-cn", amount: 40, status: "PAID", method: "CREDIT_NOTE" }],
      });

      await expect(service.deletePayment("inv-1", "pay-cn")).rejects.toThrow(BadRequestException);
      await expect(service.deletePayment("inv-1", "pay-cn")).rejects.toThrow(/un-apply/i);
      expect(prisma.invoicePayment.delete).not.toHaveBeenCalled();
    });

    it("voidPayment refuses to void a CREDIT_NOTE payment", async () => {
      prisma.invoicePayment.findFirst.mockResolvedValue({
        id: "pay-cn",
        invoiceId: "inv-1",
        status: "PAID",
        method: "CREDIT_NOTE",
      });

      await expect(service.voidPayment("inv-1", "pay-cn")).rejects.toThrow(BadRequestException);
      await expect(service.voidPayment("inv-1", "pay-cn")).rejects.toThrow(/un-apply/i);
      expect(prisma.invoicePayment.update).not.toHaveBeenCalled();
    });
  });

  // WP1 — an ADVANCE InvoicePayment debits AdvancePayment.balance when applied
  // (customers.service.applyAdvancePaymentToInvoice). Deleting/voiding that
  // application must restore the balance inline, in the same tx, or the
  // customer's advance wallet is silently understated while the invoice
  // re-opens. Advances have no status machinery, so a plain increment is the
  // complete inverse — unlike CREDIT_NOTE, which is refused outright above.
  describe("WP1 — ADVANCE payment balance restore on delete/void", () => {
    it("deletePayment restores AdvancePayment.balance when deleting an ADVANCE application", async () => {
      prisma.invoice.findUnique.mockResolvedValue({
        id: "inv-1",
        invoiceNumber: "INV-1",
        customerId: "cust-1",
        status: InvoiceStatus.PARTIAL,
        total: 100,
        dueDate: null,
        payments: [
          {
            id: "pay-adv",
            amount: 40,
            status: "PAID",
            method: "ADVANCE",
            advancePaymentId: "ap-1",
          },
        ],
      });
      prisma.invoice.update.mockResolvedValue({
        id: "inv-1",
        invoiceNumber: "INV-1",
        customerId: "cust-1",
        total: 100,
      });

      await service.deletePayment("inv-1", "pay-adv");

      expect(prisma.advancePayment.update).toHaveBeenCalledWith({
        where: { id: "ap-1" },
        data: { balance: { increment: 40 } },
      });
      expect(prisma.invoicePayment.delete).toHaveBeenCalledWith({ where: { id: "pay-adv" } });
    });

    it("deletePayment does not re-restore an already-VOID ADVANCE payment (voidPayment already did)", async () => {
      prisma.invoice.findUnique.mockResolvedValue({
        id: "inv-1",
        invoiceNumber: "INV-1",
        customerId: "cust-1",
        status: InvoiceStatus.SENT,
        total: 100,
        dueDate: null,
        payments: [
          {
            id: "pay-adv",
            amount: 40,
            status: "VOID",
            method: "ADVANCE",
            advancePaymentId: "ap-1",
          },
        ],
      });
      prisma.invoice.update.mockResolvedValue({
        id: "inv-1",
        invoiceNumber: "INV-1",
        customerId: "cust-1",
        total: 100,
      });

      await service.deletePayment("inv-1", "pay-adv");

      expect(prisma.advancePayment.update).not.toHaveBeenCalled();
      expect(prisma.invoicePayment.delete).toHaveBeenCalledWith({ where: { id: "pay-adv" } });
    });

    it("voidPayment restores AdvancePayment.balance when voiding an ADVANCE application", async () => {
      prisma.invoicePayment.findFirst.mockResolvedValue({
        id: "pay-adv",
        invoiceId: "inv-1",
        status: "PAID",
        method: "ADVANCE",
        amount: 25.5,
        advancePaymentId: "ap-2",
      });
      prisma.invoice.findUnique.mockResolvedValue({
        id: "inv-1",
        invoiceNumber: "INV-1",
        customerId: "cust-1",
        status: InvoiceStatus.PARTIAL,
        total: 100,
        dueDate: null,
        paidAt: null,
        payments: [],
      });

      await service.voidPayment("inv-1", "pay-adv");

      expect(prisma.advancePayment.update).toHaveBeenCalledWith({
        where: { id: "ap-2" },
        data: { balance: { increment: 25.5 } },
      });
      expect(prisma.invoicePayment.update).toHaveBeenCalledWith({
        where: { id: "pay-adv" },
        data: { status: "VOID" },
      });
    });

    it("deletePayment does not touch AdvancePayment for non-ADVANCE methods", async () => {
      prisma.invoice.findUnique.mockResolvedValue({
        id: "inv-1",
        invoiceNumber: "INV-1",
        customerId: "cust-1",
        status: InvoiceStatus.PARTIAL,
        total: 100,
        dueDate: null,
        payments: [{ id: "pay-cash", amount: 40, status: "PAID", method: "CASH" }],
      });
      prisma.invoice.update.mockResolvedValue({
        id: "inv-1",
        invoiceNumber: "INV-1",
        customerId: "cust-1",
        total: 100,
      });

      await service.deletePayment("inv-1", "pay-cash");

      expect(prisma.advancePayment.update).not.toHaveBeenCalled();
    });

    it("voidPayment does not touch AdvancePayment for non-ADVANCE methods", async () => {
      prisma.invoicePayment.findFirst.mockResolvedValue({
        id: "pay-cash",
        invoiceId: "inv-1",
        status: "PAID",
        method: "CASH",
        amount: 40,
      });
      prisma.invoice.findUnique.mockResolvedValue({
        id: "inv-1",
        invoiceNumber: "INV-1",
        customerId: "cust-1",
        status: InvoiceStatus.PARTIAL,
        total: 100,
        dueDate: null,
        paidAt: null,
        payments: [],
      });

      await service.voidPayment("inv-1", "pay-cash");

      expect(prisma.advancePayment.update).not.toHaveBeenCalled();
    });

    it("deletePayment still refuses a CREDIT_NOTE payment without touching AdvancePayment", async () => {
      prisma.invoice.findUnique.mockResolvedValue({
        id: "inv-1",
        status: InvoiceStatus.PARTIAL,
        total: 100,
        dueDate: null,
        payments: [{ id: "pay-cn", amount: 40, status: "PAID", method: "CREDIT_NOTE" }],
      });

      await expect(service.deletePayment("inv-1", "pay-cn")).rejects.toThrow(BadRequestException);
      expect(prisma.advancePayment.update).not.toHaveBeenCalled();
    });

    it("voidPayment still refuses a CREDIT_NOTE payment without touching AdvancePayment", async () => {
      prisma.invoicePayment.findFirst.mockResolvedValue({
        id: "pay-cn",
        invoiceId: "inv-1",
        status: "PAID",
        method: "CREDIT_NOTE",
      });

      await expect(service.voidPayment("inv-1", "pay-cn")).rejects.toThrow(BadRequestException);
      expect(prisma.advancePayment.update).not.toHaveBeenCalled();
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
      jest.spyOn(service, "reconcileOrderDeliveredInvoices").mockResolvedValue(undefined as any);
      jest.spyOn(service, "createInvoiceFromOrder").mockResolvedValue([] as any);
      prisma.paymentCounter.upsert.mockResolvedValue({ next: 2 } as any);
      prisma.invoice.update.mockResolvedValue({} as any);
      // T-B83 / R4 / REG-B83: deterministic id for the excess-advance assertions.
      prisma.advancePayment.create.mockResolvedValue({ id: "adv-1" } as any);
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

    // F03 (T-B11s / R1 / REG-B11) — the prior-payments read that decides how much of
    // the driver's cash each invoice can absorb is a payment SUM, so it is on the
    // CONFIRMED basis. This one CANNOT lean on `sumConfirmed`: the query selects
    // `{ amount: true }` only, so the row's status never reaches the reducer and the
    // WHERE clause is load-bearing. findMany therefore honours whatever `where.status`
    // the service passes, and the assertion pins the NUMBER.
    //
    // $130 invoice already carrying $80 confirmed + $50 unconfirmed DRAFT; the driver
    // collects the remaining $50 at the door. CONFIRMED basis ⇒ alreadyPaid $80,
    // remaining $50 ⇒ the $50 is recorded and the invoice lands PAID. A `not: VOID`
    // sum reads $130 already paid, computes $0 remaining, `continue`s — and the cash
    // the driver physically took is never recorded against anything.
    it("REG-B11: an unconfirmed DRAFT payment never eats the driver's collected cash", async () => {
      prisma.invoice.findFirst.mockResolvedValue({ id: "inv-1" });
      prisma.invoice.findMany.mockResolvedValue([inv({ total: 130 })]);
      stubPaymentReads([
        { id: "pay-confirmed", amount: 80, status: "PAID" },
        { id: "pay-draft", amount: 50, status: "DRAFT" },
      ]);

      const res = await service.recordDeliveryPaymentInTx(prisma as any, ["ord-1"], 50, "CASH");

      expect(res.applied).toBe(50);
      expect(prisma.invoicePayment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ invoiceId: "inv-1", amount: 50, status: "PAID" }),
        }),
      );
      // $80 confirmed + the $50 just taken = the whole $130.
      expect(prisma.invoice.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "inv-1" },
          data: expect.objectContaining({ status: InvoiceStatus.PAID }),
        }),
      );
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
      prisma.invoice.findMany.mockResolvedValue([inv({ status: InvoiceStatus.DRAFT })]);

      await service.recordDeliveryPaymentInTx(prisma as any, ["ord-1"], 100, "CASH");

      expect(service.createInvoiceFromOrder).toHaveBeenCalledWith("ord-1", prisma);
      // Sibling-aware delivered reconcile is what makes a short-pick bill delivered.
      expect(service.reconcileOrderDeliveredInvoices).toHaveBeenCalledWith("ord-1", prisma);
      expect(prisma.invoicePayment.create).toHaveBeenCalledTimes(1);
    });

    it("reconciles an EXISTING draft on the delivered basis (no re-create)", async () => {
      (service.findOpenOrderDraft as jest.Mock).mockReset().mockResolvedValue({ id: "inv-1" });
      prisma.invoice.findMany.mockResolvedValue([inv({ status: InvoiceStatus.DRAFT })]);

      await service.recordDeliveryPaymentInTx(prisma as any, ["ord-1"], 100, "CASH");

      expect(service.reconcileOrderDeliveredInvoices).toHaveBeenCalledWith("ord-1", prisma);
      expect(service.createInvoiceFromOrder).not.toHaveBeenCalled(); // a draft already existed
    });

    it("reconciles a SPLIT-invoice order too (sibling-aware — no gate, no double-bill)", async () => {
      // A SEPARATE_INVOICE regulated order has base + -R# sibling drafts. The
      // sibling-aware reconcile rebuilds each from ITS OWN lines, so it now runs
      // (the old invoiceCount<=1 skip is gone) without folding lines onto the base.
      (service.findOpenOrderDraft as jest.Mock).mockReset().mockResolvedValue({ id: "inv-base" });
      prisma.invoice.findMany.mockResolvedValue([
        inv({ id: "inv-base", invoiceNumber: "INV-9", total: 60 }),
        inv({ id: "inv-r1", invoiceNumber: "INV-9-R1", total: 40 }),
      ]);

      const res = await service.recordDeliveryPaymentInTx(prisma as any, ["ord-1"], 100, "CASH");

      expect(service.reconcileOrderDeliveredInvoices).toHaveBeenCalledWith("ord-1", prisma);
      // Both siblings still get paid — each billed once (no double).
      expect(res.applied).toBe(100);
      expect(prisma.invoicePayment.create).toHaveBeenCalledTimes(2);
    });

    // B2 (WP-D1): a deposit mirror issued at placement is SENT — there is no open
    // DRAFT to find, so the delivered-basis rebuild used to be skipped entirely and a
    // short delivery collected against the FULL pre-delivery total.
    it("rebuilds an ISSUED deposit mirror on the DELIVERED basis, preserving payments and recomputing status", async () => {
      // 10 units @ $100 = $1,000, issued SENT at placement with a 30% deposit ($300,
      // already paid). Only 6 are delivered → the bill must restate to $600.
      prisma.invoice.findFirst.mockResolvedValue({ id: "inv-dep" }); // a live invoice exists
      prisma.invoice.findMany.mockResolvedValue([
        {
          id: "inv-dep",
          invoiceNumber: "INV-DEP",
          customerId: "cust-1",
          status: InvoiceStatus.SENT,
          deliveryBatchId: null,
          depositPercent: 30,
          discount: 0,
          shippingFee: 0,
          dueDate: null,
          total: 1000,
          payments: [{ amount: 300, status: "PAID" }],
        },
      ]);
      prisma.order.findUnique.mockResolvedValue({
        id: "ord-1",
        customerId: "cust-1",
        subtotal: 1000,
        tax: 0,
        shippingFee: 0,
        lineItems: [
          {
            id: "li-1",
            productId: "p1",
            qty: 10,
            deliveredQty: 6,
            unitPrice: 100,
            subtotal: 1000,
            originalPrice: null,
            priceType: "STANDARD",
            product: { name: "Widget" },
            status: "PENDING",
          },
        ],
      });
      prisma.customer.findFirst.mockResolvedValue({ isTaxExempt: false });
      prisma.invoice.update.mockImplementation((args: any) =>
        Promise.resolve({ id: "inv-dep", ...args.data, items: [] }),
      );

      await service.recordDeliveryPaymentInTx(prisma as any, ["ord-1"], 300, "CASH");

      const rebuild = prisma.invoice.update.mock.calls[0][0];
      expect(rebuild.where).toEqual({ id: "inv-dep" });
      expect(rebuild.data.subtotal).toBeCloseTo(600, 2); // 6 of 10 × $100
      expect(rebuild.data.total).toBeCloseTo(600, 2);
      // Payment rows are never written by the rebuild; status recomputes from the
      // $300 already paid against the NEW $600 total.
      expect("payments" in rebuild.data).toBe(false);
      expect(rebuild.data.status).toBe(InvoiceStatus.PARTIAL);
      // The DRAFT-only delivered reconcile can't run here — there is no draft.
      expect(service.reconcileOrderDeliveredInvoices).not.toHaveBeenCalled();
    });

    it("leaves a plain SENT invoice (no deposit) alone when there is no draft — the fence", async () => {
      prisma.invoice.findFirst.mockResolvedValue({ id: "inv-1" });
      prisma.invoice.findMany.mockResolvedValue([inv({ deliveryBatchId: null })]);

      await service.recordDeliveryPaymentInTx(prisma as any, ["ord-1"], 100, "CASH");

      // Only the payment-status update ran — no rebuild of a non-deposit invoice.
      expect(prisma.invoiceItem.deleteMany).not.toHaveBeenCalled();
    });

    it("does NOT reconcile an order absent from reconcileOrderIds (not delivered this completion)", async () => {
      // An order merely linked to the stop but delivered elsewhere has deliveredQty
      // 0; reconciling it would zero its open draft. It must still be PAID, just not
      // reconciled.
      (service.findOpenOrderDraft as jest.Mock).mockReset().mockResolvedValue({ id: "inv-1" });
      prisma.invoice.findMany.mockResolvedValue([inv({ status: InvoiceStatus.DRAFT })]);

      await service.recordDeliveryPaymentInTx(prisma as any, ["ord-1"], 100, "CASH", []);

      expect(service.reconcileOrderDeliveredInvoices).not.toHaveBeenCalled();
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

    it("caps at the invoice's remaining and books the residual as a single-customer advance (T-B83 / R4 / REG-B83)", async () => {
      prisma.invoice.findFirst.mockResolvedValue({ id: "inv-1" });
      prisma.invoice.findMany.mockResolvedValue([inv()]);
      prisma.invoicePayment.findMany.mockResolvedValue([{ amount: 30 }]); // prior paid → remaining 70

      const res = await service.recordDeliveryPaymentInTx(
        prisma as any,
        ["ord-1"],
        100,
        "CASH",
        undefined,
        { runId: "run-1", stopId: "stop-1" },
      );

      expect(res.applied).toBe(70); // 30 residual not applied to the invoice
      expect(prisma.invoicePayment.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ amount: 70 }) }),
      );
      // REG-B83: the $30 residual is never dropped — 100 - 70 = 30 books as a
      // single-customer advance against the touched invoice's own customerId
      // (the inv() fixture: cust-1), tagged with the run/stop reference token.
      expect((res as any).excess).toBe(30);
      expect(prisma.advancePayment.create).toHaveBeenCalledTimes(1);
      expect(prisma.advancePayment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            customerId: "cust-1",
            amount: 30,
            balance: 30,
            method: "CASH",
            reference: "RUN:run-1:STOP:stop-1",
          }),
        }),
      );
      expect((res as any).advancePaymentId).toBe("adv-1");
    });

    it("REG-B83: zero payable invoices advances the WHOLE collected amount via an order-lookup fallback", async () => {
      // A live (non-payable, e.g. already-PAID) invoice exists for the order, so
      // no new DRAFT is created — but there is nothing payable to apply the cash
      // to. Today this returns { applied: 0, invoiceIds: [], paymentIds: [] } and
      // silently drops the entire $100; the fix must fall back to the order's own
      // customerId and advance the whole amount.
      prisma.invoice.findFirst.mockResolvedValue({ id: "inv-existing" });
      prisma.invoice.findMany.mockResolvedValue([]);
      prisma.order.findMany.mockResolvedValue([{ customerId: "cust-1" }]);

      const res = await service.recordDeliveryPaymentInTx(
        prisma as any,
        ["ord-1"],
        100,
        "CASH",
        undefined,
        { runId: "run-1", stopId: "stop-1" },
      );

      expect(res.applied).toBe(0);
      expect((res as any).excess).toBe(100);
      expect(prisma.advancePayment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            customerId: "cust-1",
            amount: 100,
            balance: 100,
            method: "CASH",
            reference: "RUN:run-1:STOP:stop-1",
          }),
        }),
      );
    });

    it("REG-B83: a multi-customer stop anomaly books NO advance but still returns the residual", async () => {
      prisma.invoice.findFirst.mockResolvedValue({ id: "inv-either" });
      prisma.invoice.findMany.mockResolvedValue([
        inv({ id: "inv-1", customerId: "cust-1", total: 60 }),
        inv({ id: "inv-2", customerId: "cust-2", total: 40 }),
      ]);
      prisma.invoicePayment.findMany.mockResolvedValue([]); // neither invoice has prior payments

      const res = await service.recordDeliveryPaymentInTx(
        prisma as any,
        ["ord-1", "ord-2"],
        150,
        "CASH",
        undefined,
        { runId: "run-1", stopId: "stop-1" },
      );

      expect(res.applied).toBe(100); // 60 + 40 fully paid across the two siblings
      expect((res as any).excess).toBe(50); // 150 - 100, never dropped from the response
      expect(prisma.advancePayment.create).not.toHaveBeenCalled();
    });

    it("REG-B83: an exact-match payment (excess ≤ 0.001) books no advance", async () => {
      prisma.invoice.findFirst.mockResolvedValue({ id: "inv-1" });
      prisma.invoice.findMany.mockResolvedValue([inv()]); // total 100, no prior payment
      prisma.invoicePayment.findMany.mockResolvedValue([]);

      const res = await service.recordDeliveryPaymentInTx(
        prisma as any,
        ["ord-1"],
        100,
        "CASH",
        undefined,
        { runId: "run-1", stopId: "stop-1" },
      );

      expect(res.applied).toBe(100);
      expect((res as any).excess).toBe(0);
      expect(prisma.advancePayment.create).not.toHaveBeenCalled();
      expect((res as any).advancePaymentId).toBeNull();
    });

    it("row-locks the invoice and reads prior paid CONFIRMED-only (F03/R1)", async () => {
      prisma.invoice.findFirst.mockResolvedValue({ id: "inv-1" });
      prisma.invoice.findMany.mockResolvedValue([inv()]);
      prisma.invoicePayment.findMany.mockResolvedValue([]);

      const res = await service.recordDeliveryPaymentInTx(prisma as any, ["ord-1"], 100, "CASH");

      expect(res.applied).toBe(100);
      // FOR UPDATE lock taken (serializes a concurrent back-office payment).
      expect(prisma.$executeRaw).toHaveBeenCalled();
      // prior-paid read is CONFIRMED (PAID) only — excludes both VOID and DRAFT.
      expect(prisma.invoicePayment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ status: "PAID" }) }),
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

  // reconcileOrderDeliveredInvoices rebuilds EACH open draft from ONLY its own lines
  // (orderItemId provenance) on the delivered qty — sibling-aware, so a regulated
  // SEPARATE_INVOICE order never double-bills its -R# line onto the base.
  describe("reconcileOrderDeliveredInvoices (sibling-aware delivered basis)", () => {
    // A non-boxed order line; subtotal = qty * unitPrice, delivered subtotal prorates.
    const line = (over: any = {}) => ({
      id: "oi-std",
      productId: "p-std",
      qty: 10,
      deliveredQty: 10,
      unitPrice: 5,
      subtotal: 50,
      unitsPerBox: null,
      boxes: null,
      originalPrice: null,
      priceType: "STANDARD",
      notes: null,
      categoryTaxAmount: 0,
      trackedCategoryId: null,
      product: { name: "Std", unitsPerBox: null, trackedCategoryId: null },
      ...over,
    });
    const regLine = (over: any = {}) =>
      line({
        id: "oi-reg",
        productId: "p-reg",
        trackedCategoryId: "cat-reg",
        product: { name: "Cigarettes", unitsPerBox: null, trackedCategoryId: "cat-reg" },
        ...over,
      });
    // A split order: base draft owns the standard line, -R1 owns the regulated line.
    // Shape mirrors the `invoice.findMany({status: not VOID})` select the method runs.
    const draft = (over: any = {}) => ({
      status: InvoiceStatus.DRAFT,
      deliveryBatchId: null,
      discount: 0,
      shippingFee: 0,
      ...over,
    });
    const splitDrafts = () => [
      draft({ id: "d-base", items: [{ orderItemId: "oi-std" }] }),
      draft({ id: "d-r1", items: [{ orderItemId: "oi-reg" }] }),
    ];
    const mockOrder = (lines: any[], over: any = {}) => ({
      id: "ord-1",
      customerId: "cust-1",
      subtotal: 100,
      tax: 0,
      lineItems: lines,
      ...over,
    });
    // Pull the invoice.update payload for a given draft id.
    const updOf = (id: string) =>
      prisma.invoice.update.mock.calls.find((c: any) => c[0].where.id === id)?.[0];
    const oiUpdOf = (id: string) =>
      prisma.orderItem.update.mock.calls.find((c: any) => c[0].where.id === id)?.[0];

    beforeEach(() => {
      prisma.customer.findUnique.mockResolvedValue({ isTaxExempt: false } as any);
      prisma.invoiceItem.deleteMany.mockResolvedValue({ count: 1 } as any);
      prisma.invoice.update.mockResolvedValue({} as any);
      prisma.orderItem.update.mockResolvedValue({} as any);
    });

    it("split clean delivery — base + R1 each billed ONCE at delivered qty (no double-bill)", async () => {
      prisma.invoice.findMany.mockResolvedValue(splitDrafts() as any);
      prisma.order.findUnique.mockResolvedValue(mockOrder([line(), regLine()]) as any);

      await service.reconcileOrderDeliveredInvoices("ord-1", prisma);

      // Base bills ONLY the standard line; R1 bills ONLY the regulated line.
      const base = updOf("d-base");
      const r1 = updOf("d-r1");
      expect(base.data.subtotal).toBe(50);
      expect(base.data.items.create).toHaveLength(1);
      expect(base.data.items.create[0].orderItemId).toBe("oi-std");
      expect(r1.data.subtotal).toBe(50);
      expect(r1.data.items.create).toHaveLength(1);
      expect(r1.data.items.create[0].orderItemId).toBe("oi-reg");
      // The regulated line appears on exactly ONE invoice (no fold onto the base).
      expect(base.data.items.create.some((i: any) => i.orderItemId === "oi-reg")).toBe(false);
      // invoicedQty reset to delivered on each line's own sibling.
      expect(oiUpdOf("oi-std").data.invoicedQty).toBe(10);
      expect(oiUpdOf("oi-reg").data.invoicedQty).toBe(10);
    });

    it("re-syncs the regulated-sales ledger to the DELIVERED qty (reverse old SALE + write new)", async () => {
      prisma.invoice.findMany.mockResolvedValue(splitDrafts() as any);
      // R1's regulated line is short-picked: delivered 4 of 10.
      prisma.order.findUnique.mockResolvedValue(
        mockOrder([line({ deliveredQty: 10 }), regLine({ deliveredQty: 4 })]) as any,
      );
      // Echo the created items back with ids so the ledger sync sees real invoice lines.
      prisma.invoice.update.mockImplementation((args: any) =>
        Promise.resolve({
          id: args.where.id,
          items: (args.data.items?.create ?? []).map((it: any, i: number) => ({
            ...it,
            id: `${args.where.id}-item-${i}`,
          })),
        }),
      );
      const ledger = (service as any).ledger;

      await service.reconcileOrderDeliveredInvoices("ord-1", prisma);

      // Prior SALE rows reversed for BOTH drafts (nets the full-qty entries to 0).
      expect(ledger.reverseInvoiceEntries).toHaveBeenCalledWith(
        expect.objectContaining({ invoiceId: "d-base" }),
      );
      expect(ledger.reverseInvoiceEntries).toHaveBeenCalledWith(
        expect.objectContaining({ invoiceId: "d-r1" }),
      );
      // Fresh SALE rows written; the regulated line (R1) now reports the DELIVERED qty (4)
      // and its prorated netSales (20 = 4/10 of 50), not the full 10 / 50.
      const r1Write = ledger.writeSaleEntries.mock.calls.find(
        (c: any) => c[0].invoiceId === "d-r1",
      )?.[0];
      expect(r1Write).toBeDefined();
      const regLedgerLine = r1Write.lines.find((l: any) => l.trackedCategoryId === "cat-reg");
      expect(regLedgerLine.qty).toBe(4);
      expect(regLedgerLine.netSales).toBe(20);
    });

    it("split short-picked regulated line — R1 bills the DELIVERED qty, not full", async () => {
      prisma.invoice.findMany.mockResolvedValue(splitDrafts() as any);
      prisma.order.findUnique.mockResolvedValue(
        mockOrder([line({ deliveredQty: 10 }), regLine({ deliveredQty: 4 })]) as any,
      );

      await service.reconcileOrderDeliveredInvoices("ord-1", prisma);

      // R1: delivered 4 of 10 @ stored subtotal 50 → round(50*4/10) = 20.
      expect(updOf("d-r1").data.subtotal).toBe(20);
      expect(updOf("d-r1").data.items.create).toHaveLength(1);
      expect(oiUpdOf("oi-reg").data.invoicedQty).toBe(4);
      // Base (fully delivered) unchanged.
      expect(updOf("d-base").data.subtotal).toBe(50);
      expect(oiUpdOf("oi-std").data.invoicedQty).toBe(10);
    });

    it("split refused regulated line — R1 → 0 (no items, invoicedQty 0)", async () => {
      prisma.invoice.findMany.mockResolvedValue(splitDrafts() as any);
      prisma.order.findUnique.mockResolvedValue(
        mockOrder([line({ deliveredQty: 10 }), regLine({ deliveredQty: 0 })]) as any,
      );

      await service.reconcileOrderDeliveredInvoices("ord-1", prisma);

      expect(updOf("d-r1").data.subtotal).toBe(0);
      expect(updOf("d-r1").data.items.create).toHaveLength(0); // refused → no line
      expect(oiUpdOf("oi-reg").data.invoicedQty).toBe(0);
      // Base still bills its delivered standard line.
      expect(updOf("d-base").data.subtotal).toBe(50);
    });

    it("split clean delivery WITH tax — Σ(sibling total) == order total to the cent", async () => {
      prisma.invoice.findMany.mockResolvedValue(splitDrafts() as any);
      prisma.order.findUnique.mockResolvedValue(
        mockOrder([line(), regLine()], { subtotal: 100, tax: 10 }) as any,
      );

      await service.reconcileOrderDeliveredInvoices("ord-1", prisma);

      const base = updOf("d-base");
      const r1 = updOf("d-r1");
      // tax 10 allocated by subtotal (50/100 each) → 5 + 5; totals 55 + 55 = 110 = order total.
      expect(base.data.taxAmount + r1.data.taxAmount).toBe(10);
      expect(base.data.total + r1.data.total).toBe(110);
    });

    it("single-group order — one draft billed at the delivered qty", async () => {
      prisma.invoice.findMany.mockResolvedValue([
        draft({ id: "d-1", items: [{ orderItemId: "oi-std" }] }),
      ] as any);
      prisma.order.findUnique.mockResolvedValue(mockOrder([line({ deliveredQty: 6 })]) as any);

      await service.reconcileOrderDeliveredInvoices("ord-1", prisma);

      // delivered 6 of 10 @ subtotal 50 → 30; invoicedQty 6.
      expect(updOf("d-1").data.subtotal).toBe(30);
      expect(oiUpdOf("oi-std").data.invoicedQty).toBe(6);
    });

    it("no open draft — returns null, writes nothing", async () => {
      prisma.invoice.findMany.mockResolvedValue([] as any);

      const res = await service.reconcileOrderDeliveredInvoices("ord-1", prisma);

      expect(res).toBeNull();
      expect(prisma.invoice.update).not.toHaveBeenCalled();
      expect(prisma.orderItem.update).not.toHaveBeenCalled();
    });

    it("BAILS when a line is shared across two open drafts (operator partials) — no double-bill", async () => {
      // Two partial DRAFTs bill the SAME line (createPartialFromOrder ×2). Provenance
      // is not a clean partition; rebuilding each from prior 0 would double-bill.
      prisma.invoice.findMany.mockResolvedValue([
        draft({ id: "d-a", items: [{ orderItemId: "oi-std" }] }),
        draft({ id: "d-b", items: [{ orderItemId: "oi-std" }] }),
      ] as any);

      const res = await service.reconcileOrderDeliveredInvoices("ord-1", prisma);

      expect(res).toBeNull();
      expect(prisma.invoice.update).not.toHaveBeenCalled(); // left as created
      expect(prisma.order.findUnique).not.toHaveBeenCalled(); // bailed before loading
    });

    it("BAILS when a draft line is also billed by a finalized invoice — no over-bill", async () => {
      // A SENT invoice already bills oi-std; an open DRAFT bills it again. Rebuilding
      // the draft from prior 0 would ignore the SENT portion and over-bill.
      prisma.invoice.findMany.mockResolvedValue([
        {
          id: "d-sent",
          status: InvoiceStatus.SENT,
          deliveryBatchId: null,
          items: [{ orderItemId: "oi-std" }],
        },
        draft({ id: "d-draft", items: [{ orderItemId: "oi-std" }] }),
      ] as any);

      const res = await service.reconcileOrderDeliveredInvoices("ord-1", prisma);

      expect(res).toBeNull();
      expect(prisma.invoice.update).not.toHaveBeenCalled();
    });

    it("BAILS when a finalized invoice bills a line with NO orderItemId provenance (legacy/manual)", async () => {
      // A SENT invoice has a hand-added / legacy line (orderItemId null) that can't be
      // matched to an order line — provenance can't be proven clean → bail.
      prisma.invoice.findMany.mockResolvedValue([
        {
          id: "d-sent",
          status: InvoiceStatus.SENT,
          deliveryBatchId: null,
          items: [{ orderItemId: null }],
        },
        draft({ id: "d-draft", items: [{ orderItemId: "oi-std" }] }),
      ] as any);

      const res = await service.reconcileOrderDeliveredInvoices("ord-1", prisma);

      expect(res).toBeNull();
      expect(prisma.invoice.update).not.toHaveBeenCalled();
    });

    it("reconciles a -R# sibling even when the BASE is already SENT (different lines, clean)", async () => {
      // base SENT bills the standard line; -R1 DRAFT bills the regulated line. No line
      // is shared, so provenance is clean → the sibling is still reconciled to delivered.
      prisma.invoice.findMany.mockResolvedValue([
        {
          id: "d-base",
          status: InvoiceStatus.SENT,
          deliveryBatchId: null,
          items: [{ orderItemId: "oi-std" }],
        },
        draft({ id: "d-r1", items: [{ orderItemId: "oi-reg" }] }),
      ] as any);
      prisma.order.findUnique.mockResolvedValue(
        mockOrder([line({ deliveredQty: 10 }), regLine({ deliveredQty: 4 })]) as any,
      );

      await service.reconcileOrderDeliveredInvoices("ord-1", prisma);

      // Only the DRAFT sibling is rebuilt (base SENT is untouched), on delivered qty.
      expect(updOf("d-base")).toBeUndefined();
      expect(updOf("d-r1").data.subtotal).toBe(20); // 4/10 of 50
      expect(oiUpdOf("oi-reg").data.invoicedQty).toBe(4);
    });

    // ─── Sibling shipping-fee placement (WP2, rebuildSiblingDrafts) ────────────

    it("stability: sibling fees already sum to the order fee → placement KEPT (no ping-pong)", async () => {
      // d-base already carries the whole $6 fee (e.g. from a prior invoice-side
      // edit that back-synced the order); d-r1 carries 0. Sums agree with the
      // order's fee (6), so the existing placement is preserved verbatim.
      prisma.invoice.findMany.mockResolvedValue([
        draft({ id: "d-base", items: [{ orderItemId: "oi-std" }], shippingFee: 6 }),
        draft({ id: "d-r1", items: [{ orderItemId: "oi-reg" }], shippingFee: 0 }),
      ] as any);
      prisma.order.findUnique.mockResolvedValue(
        mockOrder([line(), regLine()], { shippingFee: 6 }) as any,
      );

      await service.reconcileOrderDeliveredInvoices("ord-1", prisma);

      expect(updOf("d-base").data.shippingFee).toBe(6);
      expect(updOf("d-r1").data.shippingFee).toBe(0);
    });

    it("re-seed: order fee changed → the WHOLE new fee lands on the largest-subtotal sibling", async () => {
      // Siblings currently show a stale placement {6,0}, but the order's fee
      // changed to 9 — sums no longer agree (6 ≠ 9) → re-seed the whole new fee
      // onto whichever sibling has the larger DELIVERED subtotal this time.
      prisma.invoice.findMany.mockResolvedValue([
        draft({ id: "d-base", items: [{ orderItemId: "oi-std" }], shippingFee: 6 }),
        draft({ id: "d-r1", items: [{ orderItemId: "oi-reg" }], shippingFee: 0 }),
      ] as any);
      prisma.order.findUnique.mockResolvedValue(
        mockOrder([line(), regLine({ deliveredQty: 5 })], { shippingFee: 9 }) as any,
      );

      await service.reconcileOrderDeliveredInvoices("ord-1", prisma);

      // std billed $50 (full) > reg billed $25 (half-delivered) → the whole $9
      // fee re-seeds onto d-base; d-r1 is zeroed.
      expect(updOf("d-base").data.shippingFee).toBe(9);
      expect(updOf("d-r1").data.shippingFee).toBe(0);
    });
  });

  // R1 — a POST-DELIVERY edit re-syncs the order's FINALIZED / PAID / delivery-batch
  // invoice(s) IN PLACE at the edited order qty: keep payments, recompute status from
  // them, re-sync the ledger, bill new lines on the primary invoice, and BAIL on an
  // unclean partition (never double-bill).
  describe("resyncOrderInvoicesForEdit (R1 — post-delivery in-place resync)", () => {
    const line = (over: any = {}) => ({
      id: "oi-std",
      productId: "p-std",
      qty: 10,
      deliveredQty: 10,
      unitPrice: 5,
      subtotal: 50,
      unitsPerBox: null,
      boxes: null,
      originalPrice: null,
      priceType: "STANDARD",
      notes: null,
      categoryTaxAmount: 0,
      trackedCategoryId: null,
      product: { name: "Std", unitsPerBox: null, trackedCategoryId: null },
      ...over,
    });
    const mockOrder = (lines: any[], over: any = {}) => ({
      id: "ord-1",
      customerId: "cust-1",
      subtotal: 50,
      tax: 0,
      lineItems: lines,
      ...over,
    });
    const inv = (over: any = {}) => ({
      id: "inv-1",
      status: InvoiceStatus.SENT,
      deliveryBatchId: null,
      discount: 0,
      shippingFee: 0,
      dueDate: null,
      items: [{ orderItemId: "oi-std" }],
      payments: [],
      ...over,
    });
    const updOf = (id: string) =>
      prisma.invoice.update.mock.calls.find((c: any) => c[0].where.id === id)?.[0];

    beforeEach(() => {
      prisma.customer.findUnique.mockResolvedValue({ isTaxExempt: false } as any);
      prisma.invoiceItem.deleteMany.mockResolvedValue({ count: 1 } as any);
      prisma.invoice.update.mockImplementation((args: any) =>
        Promise.resolve({
          id: args.where.id,
          items: (args.data.items?.create ?? []).map((it: any, i: number) => ({
            ...it,
            id: `${args.where.id}-item-${i}`,
          })),
        }),
      );
      prisma.orderItem.update.mockResolvedValue({} as any);
      prisma.orderItem.findMany.mockResolvedValue([{ id: "oi-std" }] as any);
    });

    it("no linked invoice — returns null, writes nothing", async () => {
      prisma.invoice.findMany.mockResolvedValue([] as any);
      const res = await service.resyncOrderInvoicesForEdit("ord-1", prisma);
      expect(res).toBeNull();
      expect(prisma.invoice.update).not.toHaveBeenCalled();
    });

    it("rebuilds a SENT invoice at the edited order qty, keeps the payment, recomputes to PARTIAL", async () => {
      prisma.invoice.findMany.mockResolvedValue([
        inv({ payments: [{ amount: 30, status: "PAID" }] }),
      ] as any);
      prisma.order.findUnique.mockResolvedValue(mockOrder([line()]) as any);

      await service.resyncOrderInvoicesForEdit("ord-1", prisma);

      const upd = updOf("inv-1");
      expect(upd.data.subtotal).toBe(50);
      // paid 30 < total 50 → PARTIAL (never forced to DRAFT; payment is untouched).
      expect(upd.data.status).toBe(InvoiceStatus.PARTIAL);
    });

    it("a PAID invoice edited to a lower total stays PAID (over-paid / credit balance)", async () => {
      prisma.invoice.findMany.mockResolvedValue([
        inv({ status: InvoiceStatus.PAID, payments: [{ amount: 50, status: "PAID" }] }),
      ] as any);
      // Edited down: qty 6 @ 5 = 30.
      prisma.order.findUnique.mockResolvedValue(
        mockOrder([line({ qty: 6, subtotal: 30 })], { subtotal: 30 }) as any,
      );

      await service.resyncOrderInvoicesForEdit("ord-1", prisma);

      const upd = updOf("inv-1");
      expect(upd.data.subtotal).toBe(30);
      // paid 50 >= total 30 → PAID (customer over-paid; balance is a credit).
      expect(upd.data.status).toBe(InvoiceStatus.PAID);
    });

    it("VOID payments are excluded when recomputing status", async () => {
      prisma.invoice.findMany.mockResolvedValue([
        inv({ payments: [{ amount: 50, status: "VOID" }] }),
      ] as any);
      prisma.order.findUnique.mockResolvedValue(mockOrder([line()]) as any);

      await service.resyncOrderInvoicesForEdit("ord-1", prisma);

      // The only payment is VOID → paid 0 → SENT (not PAID/PARTIAL).
      expect(updOf("inv-1").data.status).toBe(InvoiceStatus.SENT);
    });

    it("bills a NEW (unprovenanced) line on the primary invoice", async () => {
      prisma.invoice.findMany.mockResolvedValue([inv()] as any);
      prisma.orderItem.findMany.mockResolvedValue([{ id: "oi-std" }, { id: "oi-new" }] as any);
      prisma.order.findUnique.mockResolvedValue(
        mockOrder([line(), line({ id: "oi-new", productId: "p-new" })], { subtotal: 100 }) as any,
      );

      await service.resyncOrderInvoicesForEdit("ord-1", prisma);

      const upd = updOf("inv-1");
      expect(upd.data.subtotal).toBe(100);
      expect(upd.data.items.create).toHaveLength(2);
      expect(upd.data.items.create.map((i: any) => i.orderItemId).sort()).toEqual([
        "oi-new",
        "oi-std",
      ]);
    });

    it("re-syncs the regulated ledger for the rebuilt invoice", async () => {
      prisma.invoice.findMany.mockResolvedValue([inv()] as any);
      prisma.order.findUnique.mockResolvedValue(mockOrder([line()]) as any);
      const ledger = (service as any).ledger;

      await service.resyncOrderInvoicesForEdit("ord-1", prisma);

      expect(ledger.reverseInvoiceEntries).toHaveBeenCalledWith(
        expect.objectContaining({ invoiceId: "inv-1", preserveReturns: true }),
      );
      expect(ledger.writeSaleEntries).toHaveBeenCalledWith(
        expect.objectContaining({ invoiceId: "inv-1" }),
      );
    });

    it("BAILS when a line is billed by two invoices (unclean partition) — writes nothing", async () => {
      prisma.invoice.findMany.mockResolvedValue([
        inv({ id: "inv-a", items: [{ orderItemId: "oi-std" }] }),
        inv({ id: "inv-b", items: [{ orderItemId: "oi-std" }] }),
      ] as any);

      const res = await service.resyncOrderInvoicesForEdit("ord-1", prisma);

      expect(res).toBeNull();
      expect(prisma.invoice.update).not.toHaveBeenCalled();
      expect(prisma.order.findUnique).not.toHaveBeenCalled();
    });

    it("BAILS when an invoice line has no orderItemId provenance (manual/legacy)", async () => {
      prisma.invoice.findMany.mockResolvedValue([inv({ items: [{ orderItemId: null }] })] as any);

      const res = await service.resyncOrderInvoicesForEdit("ord-1", prisma);

      expect(res).toBeNull();
      expect(prisma.invoice.update).not.toHaveBeenCalled();
    });

    it("places a NEW regulated line on its category's -R# sibling, not the base invoice", async () => {
      prisma.invoice.findMany.mockResolvedValue([
        inv({ id: "inv-base", items: [{ orderItemId: "oi-std" }] }),
        inv({ id: "inv-r1", items: [{ orderItemId: "oi-reg" }] }),
      ] as any);
      prisma.orderItem.findMany.mockResolvedValue([
        { id: "oi-std" },
        { id: "oi-reg" },
        { id: "oi-newreg" },
      ] as any);
      const reg = (id: string, name: string) =>
        line({
          id,
          productId: `p-${id}`,
          trackedCategoryId: "cat-reg",
          product: { name, unitsPerBox: null, trackedCategoryId: "cat-reg" },
        });
      prisma.order.findUnique.mockResolvedValue(
        mockOrder([line(), reg("oi-reg", "Cig"), reg("oi-newreg", "Cig2")], {
          subtotal: 150,
        }) as any,
      );

      await service.resyncOrderInvoicesForEdit("ord-1", prisma);

      // Base keeps only its standard line; the NEW regulated line joins the cat-reg
      // sibling (inv-r1) instead of co-mingling onto the base.
      expect(
        updOf("inv-base")
          .data.items.create.map((i: any) => i.orderItemId)
          .sort(),
      ).toEqual(["oi-std"]);
      expect(
        updOf("inv-r1")
          .data.items.create.map((i: any) => i.orderItemId)
          .sort(),
      ).toEqual(["oi-newreg", "oi-reg"]);
    });
  });

  // reconcileOrderDraftInvoice(basis:"order") is now sibling-aware for a regulated
  // SEPARATE_INVOICE split (base + -R# drafts) via CATEGORY grouping of the CURRENT
  // lines (so an edit that added a line still bills it), falling back to the legacy
  // single-draft rebuild for single-group / unclean cases.
  describe("reconcileOrderDraftInvoice — split order (basis:order) sibling-aware", () => {
    const line = (over: any = {}) => ({
      id: "oi-std",
      productId: "p-std",
      qty: 10,
      deliveredQty: 10,
      unitPrice: 5,
      subtotal: 50,
      unitsPerBox: null,
      boxes: null,
      originalPrice: null,
      priceType: "STANDARD",
      notes: null,
      categoryTaxAmount: 0,
      trackedCategoryId: null,
      product: { name: "Std", unitsPerBox: null, trackedCategoryId: null },
      ...over,
    });
    const regLine = (over: any = {}) =>
      line({
        id: "oi-reg",
        productId: "p-reg",
        qty: 4,
        subtotal: 40,
        unitPrice: 10,
        trackedCategoryId: "cat-reg",
        product: { name: "Cigarettes", unitsPerBox: null, trackedCategoryId: "cat-reg" },
        ...over,
      });
    const draft = (over: any = {}) => ({
      status: InvoiceStatus.DRAFT,
      deliveryBatchId: null,
      discount: 0,
      shippingFee: 0,
      ...over,
    });
    // items here carry trackedCategoryId (the select the split path reads).
    const splitDrafts = () => [
      draft({ id: "d-base", items: [{ orderItemId: "oi-std", trackedCategoryId: null }] }),
      draft({ id: "d-r1", items: [{ orderItemId: "oi-reg", trackedCategoryId: "cat-reg" }] }),
    ];
    const mockOrder = (lines: any[], over: any = {}) => ({
      id: "ord-1",
      customerId: "cust-1",
      subtotal: 90,
      tax: 0,
      lineItems: lines,
      ...over,
    });
    const updOf = (id: string) =>
      prisma.invoice.update.mock.calls.find((c: any) => c[0].where.id === id)?.[0];
    const oiUpdOf = (id: string) =>
      prisma.orderItem.update.mock.calls.find((c: any) => c[0].where.id === id)?.[0];

    beforeEach(() => {
      prisma.customer.findUnique.mockResolvedValue({ isTaxExempt: false } as any);
      prisma.invoiceItem.deleteMany.mockResolvedValue({ count: 1 } as any);
      prisma.invoice.update.mockResolvedValue({} as any);
      prisma.orderItem.update.mockResolvedValue({} as any);
      // groupOrderLinesForInvoicing resolves cat-reg as a SEPARATE_INVOICE category.
      prisma.trackedCategory.findMany.mockResolvedValue([
        {
          id: "cat-reg",
          name: "Tobacco",
          invoiceTreatment: "SEPARATE_INVOICE",
          taxType: "NONE",
          rate: 0,
        },
      ] as any);
    });

    it("rebuilds base + R1 EACH from its own category group at full qty (no double-bill)", async () => {
      prisma.invoice.findMany.mockResolvedValue(splitDrafts() as any);
      prisma.order.findUnique.mockResolvedValue(mockOrder([line(), regLine()]) as any);

      await service.reconcileOrderDraftInvoice("ord-1", { basis: "order", tx: prisma as any });

      const base = updOf("d-base");
      const r1 = updOf("d-r1");
      expect(base.data.items.create).toHaveLength(1);
      expect(base.data.items.create[0].orderItemId).toBe("oi-std");
      expect(base.data.subtotal).toBe(50);
      // The regulated line is NOT folded onto the base (the double-bill this fixes).
      expect(base.data.items.create.some((i: any) => i.orderItemId === "oi-reg")).toBe(false);
      expect(r1.data.items.create).toHaveLength(1);
      expect(r1.data.items.create[0].orderItemId).toBe("oi-reg");
      expect(r1.data.subtotal).toBe(40);
      expect(oiUpdOf("oi-std").data.invoicedQty).toBe(10);
      expect(oiUpdOf("oi-reg").data.invoicedQty).toBe(4);
      // The regulated-sales ledger is re-synced on the order basis too.
      expect((service as any).ledger.reverseInvoiceEntries).toHaveBeenCalled();
      expect((service as any).ledger.writeSaleEntries).toHaveBeenCalled();
    });

    it("an edit that ADDED a standard line bills it on the base (grouping, not provenance)", async () => {
      // oi-std2 is on the CURRENT order but not yet on any draft's items — provenance
      // would drop it; category grouping bills it on the base.
      const added = line({
        id: "oi-std2",
        productId: "p-std2",
        qty: 2,
        subtotal: 10,
        product: { name: "Std2", unitsPerBox: null, trackedCategoryId: null },
      });
      prisma.invoice.findMany.mockResolvedValue(splitDrafts() as any);
      prisma.order.findUnique.mockResolvedValue(
        mockOrder([line(), added, regLine()], { subtotal: 100 }) as any,
      );

      await service.reconcileOrderDraftInvoice("ord-1", { basis: "order", tx: prisma as any });

      const baseIds = updOf("d-base")
        .data.items.create.map((i: any) => i.orderItemId)
        .sort();
      expect(baseIds).toEqual(["oi-std", "oi-std2"]);
      expect(updOf("d-base").data.subtotal).toBe(60); // 50 + 10
      expect(oiUpdOf("oi-std2").data.invoicedQty).toBe(2);
    });

    it("single-group order → falls through to the legacy single-draft rebuild", async () => {
      prisma.invoice.findMany.mockResolvedValue([
        draft({ id: "d-only", items: [{ orderItemId: "oi-std", trackedCategoryId: null }] }),
      ] as any);
      prisma.invoice.findFirst.mockResolvedValue({
        id: "d-only",
        discount: 0,
        shippingFee: 0,
      } as any);
      prisma.order.findUnique.mockResolvedValue(mockOrder([line()]) as any);
      prisma.orderItem.findMany.mockResolvedValue([{ id: "oi-std" }] as any);

      await service.reconcileOrderDraftInvoice("ord-1", { basis: "order", tx: prisma as any });

      expect(updOf("d-only").data.items.create).toHaveLength(1);
      expect(updOf("d-only").data.subtotal).toBe(50);
    });

    it("bails to legacy when a finalized invoice already bills part of the order", async () => {
      prisma.invoice.findMany.mockResolvedValue([
        ...splitDrafts(),
        {
          id: "d-sent",
          status: InvoiceStatus.SENT,
          deliveryBatchId: null,
          discount: 0,
          shippingFee: 0,
          items: [{ orderItemId: "oi-x", trackedCategoryId: null }],
        },
      ] as any);
      prisma.invoice.findFirst.mockResolvedValue({
        id: "d-base",
        discount: 0,
        shippingFee: 0,
      } as any);
      prisma.order.findUnique.mockResolvedValue(mockOrder([line(), regLine()]) as any);
      prisma.orderItem.findMany.mockResolvedValue([{ id: "oi-std" }, { id: "oi-reg" }] as any);

      await service.reconcileOrderDraftInvoice("ord-1", { basis: "order", tx: prisma as any });

      // Legacy single-draft path took over → exactly ONE invoice.update (the base), not
      // the two-sibling rebuild.
      expect(prisma.invoice.update).toHaveBeenCalledTimes(1);
      expect(updOf("d-base")).toBeDefined();
      // The legacy group-unaware path must NOT touch the ledger (folding the regulated
      // line onto the base + writing a SALE would double-count vs the live -R1 SALE).
      expect((service as any).ledger.writeSaleEntries).not.toHaveBeenCalled();
    });
  });

  // ─── RF-2-lite: regulated category/subcategory NAME on the invoice payload ──
  describe("findOne — regulated category name on items", () => {
    it("returns items[].trackedCategory.name and requests the category/subcategory include", async () => {
      prisma.invoice.findUnique.mockResolvedValue({
        id: "inv-1",
        status: InvoiceStatus.SENT,
        total: 100,
        dueDate: null,
        payments: [],
        items: [
          {
            id: "item-1",
            trackedCategoryId: "cat-1",
            trackedCategory: {
              id: "cat-1",
              name: "Tobacco",
              invoiceTreatment: "SEPARATE_INVOICE",
            },
            trackedSubcategoryId: "sub-1",
            trackedSubcategory: { id: "sub-1", name: "Cigarettes" },
          },
        ],
      });

      const res = await service.findOne("inv-1");

      // findOne now pulls the regulated category + subcategory into the items include.
      const includeArg = (prisma.invoice.findUnique as jest.Mock).mock.calls[0][0].include;
      expect(includeArg.items.include.trackedCategory).toBeDefined();
      expect(includeArg.items.include.trackedSubcategory).toBeDefined();
      // …and the NAME flows straight through onto the returned payload.
      expect((res.items as any[])[0].trackedCategory.name).toBe("Tobacco");
      expect((res.items as any[])[0].trackedSubcategory.name).toBe("Cigarettes");
    });
  });

  // ─── createPartialFromOrder — remaining-fee seeding (WP2) ──────────────────
  describe("createPartialFromOrder — shipping fee seeding", () => {
    const baseOrder = (over: any = {}) => ({
      id: "ord-p1",
      customerId: "cust-1",
      orderNumber: "ORD-P1",
      subtotal: 50,
      tax: 5,
      shippingFee: 7,
      lineItems: [
        {
          id: "oi-1",
          productId: "p-1",
          qty: 10,
          invoicedQty: 0,
          boxes: null,
          pieces: null,
          unitsPerBox: null,
          unitPrice: 5,
          subtotal: 50,
          product: { name: "Widget", unitsPerBox: null },
        },
      ],
      ...over,
    });

    beforeEach(() => {
      prisma.customer.findUnique.mockResolvedValue({ isTaxExempt: false } as any);
      prisma.invoice.create.mockImplementation((args: any) =>
        Promise.resolve({ ...args.data, items: [], payments: [], customer: {} }),
      );
      prisma.orderItem.update.mockResolvedValue({} as any);
    });

    it("first partial carries the WHOLE remaining order fee", async () => {
      prisma.order.findUnique.mockResolvedValue(baseOrder());
      // No prior non-void invoice for this order carries any fee yet.
      prisma.invoice.aggregate.mockResolvedValue({ _sum: { shippingFee: 0 } });

      const invoice = (await service.createPartialFromOrder("ord-p1", {
        items: [{ orderItemId: "oi-1", qty: 10 }],
      } as any)) as any;

      expect(Number(invoice.shippingFee)).toBe(7);
      // subtotal 50 + regular tax (5 × 50/50 = 5) + fee 7 = 62.
      expect(Number(invoice.total)).toBe(62);
    });

    it("a second partial (a prior invoice already carries the fee) gets 0", async () => {
      prisma.order.findUnique.mockResolvedValue(baseOrder());
      // A prior partial already billed the entire $7 fee.
      prisma.invoice.aggregate.mockResolvedValue({ _sum: { shippingFee: 7 } });

      const invoice = (await service.createPartialFromOrder("ord-p1", {
        items: [{ orderItemId: "oi-1", qty: 5 }],
      } as any)) as any;

      expect(Number(invoice.shippingFee)).toBe(0);
    });
  });

  // F03 (T-B85 / R7 / REG-B85): createPartialFromOrder never settles order-level
  // credit-note selections, and doesn't run inside a transaction at all — a
  // leftover explicit-amount OrderCreditNote selection is neither auto-applied
  // (send()'s explicitIds exclusion assumes settle already ran) nor settled by
  // this path, and is stranded. R7 wraps the create + orderItem.update loop in a
  // tenantTransaction (mirroring createSplitInvoices's runCreation(tx) shape) and
  // calls settleOrderCreditsInTx(tx, order.id, tenantId) inside it.
  // See .claude/pipeline/2026-08-31-f03-payment-truth/{spec,test-plan}.md R7/T-B85.
  describe("createPartialFromOrder — credit-note settle hook (T-B85 / R7 / REG-B85)", () => {
    it("wraps creation in a tenantTransaction and calls settleOrderCreditsInTx with THAT SAME tx object", async () => {
      prisma.order.findUnique.mockResolvedValue({
        id: "ord-b85",
        customerId: "cust-b85",
        orderNumber: "ORD-B85",
        subtotal: 50,
        tax: 0,
        shippingFee: 0,
        lineItems: [
          {
            id: "oi-b85",
            productId: "p-1",
            qty: 10,
            invoicedQty: 0,
            boxes: null,
            pieces: null,
            unitsPerBox: null,
            unitPrice: 5,
            subtotal: 50,
            product: { name: "Widget", unitsPerBox: null },
          },
        ],
      } as any);
      prisma.customer.findUnique.mockResolvedValue({ isTaxExempt: false } as any);

      // Fake-store-driven tenantTransaction (the #506 spec shape): ONE stable,
      // identity-distinct tx object, NOT createMockPrisma()'s default (a fresh
      // `{...models}` spread manufactured PER CALL) and NOT a bare pass-through
      // to `this.prisma`/`forTenant()`. Either of those would make the identity
      // assertion below pass vacuously — a pass-through mock proves nothing,
      // because settle receiving `this.prisma.forTenant()` instead of the real
      // tx would look identical to it receiving the tx. Only a genuinely
      // separate, call-stable object can distinguish "tx threaded through" from
      // "settle ran on the wrong client".
      const txClient = {
        invoice: {
          create: jest.fn(async (args: any) => ({
            ...args.data,
            id: "inv-b85",
            items: [],
            payments: [],
            customer: {},
          })),
          findFirst: jest.fn().mockResolvedValue(null),
        },
        orderItem: { update: jest.fn().mockResolvedValue({}) },
        $executeRaw: jest.fn().mockResolvedValue(0),
        $queryRaw: jest.fn().mockResolvedValue([]),
      };
      prisma.tenantTransaction.mockImplementation((fn: any) => fn(txClient));

      await service.createPartialFromOrder("ord-b85", {
        items: [{ orderItemId: "oi-b85", qty: 10 }],
      } as any);

      // R7: settle must run INSIDE the same transaction that creates the
      // invoice — never on a separately-scoped client. Today createPartialFromOrder
      // has no settle call at all and isn't a transaction, so this is red on an
      // empty mock-calls list (mutation: moving the call outside the tx — e.g.
      // calling it with `this.prisma.forTenant()` after the tx resolves — fails
      // this same identity assertion).
      expect(mockCreditNotes.settleOrderCreditsInTx).toHaveBeenCalledWith(
        txClient,
        "ord-b85",
        "test-tenant",
      );
    });
  });

  // ─── Payment image attachment (clone of the expense-receipt pattern) ──────
  // uploadPaymentImage/getPaymentImageUrl/deletePaymentImage + recordPayment's
  // createdPaymentId + deletePayment's best-effort storage cleanup.
  describe("Payment image attachment", () => {
    describe("uploadPaymentImage", () => {
      it("solo payment: uploads under payments/<id>/image.<ext>, updates the row by id, returns the presigned url", async () => {
        prisma.invoicePayment.findUnique.mockResolvedValue({
          id: "pay-1",
          paymentGroupId: null,
        });

        const result = await service.uploadPaymentImage(
          "pay-1",
          Buffer.from("raw-bytes"),
          "receipt.png",
          "image/png",
        );

        expect(mockCompressDocument).toHaveBeenCalledWith(Buffer.from("raw-bytes"), "image/png");
        expect(mockStorage.upload).toHaveBeenCalledWith(
          "payments/pay-1/image.jpg",
          Buffer.from("compressed-bytes"),
          "image/jpeg",
        );
        expect(prisma.invoicePayment.update).toHaveBeenCalledWith({
          where: { id: "pay-1" },
          data: {
            imageKey: "payments/pay-1/image.jpg",
            imageOriginalName: "receipt.png",
            imageMimeType: "image/jpeg",
          },
        });
        expect(prisma.invoicePayment.updateMany).not.toHaveBeenCalled();
        expect(mockStorage.presignedUrl).toHaveBeenCalledWith("payments/pay-1/image.jpg");
        expect(result).toEqual({ url: "https://signed/url" });
      });

      it("grouped payment: keys the object by the group id and updateMany's every row in the group", async () => {
        prisma.invoicePayment.findUnique.mockResolvedValue({
          id: "pay-2",
          paymentGroupId: "grp-1",
        });

        const result = await service.uploadPaymentImage(
          "pay-2",
          Buffer.from("raw-bytes"),
          "slip.jpg",
          "image/jpeg",
        );

        expect(mockStorage.upload).toHaveBeenCalledWith(
          "payments/grp-1/image.jpg",
          Buffer.from("compressed-bytes"),
          "image/jpeg",
        );
        expect(prisma.invoicePayment.updateMany).toHaveBeenCalledWith({
          where: { paymentGroupId: "grp-1" },
          data: {
            imageKey: "payments/grp-1/image.jpg",
            imageOriginalName: "slip.jpg",
            imageMimeType: "image/jpeg",
          },
        });
        expect(prisma.invoicePayment.update).not.toHaveBeenCalled();
        expect(result).toEqual({ url: "https://signed/url" });
      });

      it("throws NotFoundException for an unknown payment", async () => {
        prisma.invoicePayment.findUnique.mockResolvedValue(null);

        await expect(
          service.uploadPaymentImage("missing", Buffer.from("x"), "x.jpg", "image/jpeg"),
        ).rejects.toThrow(NotFoundException);
        expect(mockCompressDocument).not.toHaveBeenCalled();
        expect(mockStorage.upload).not.toHaveBeenCalled();
      });
    });

    describe("getPaymentImageUrl", () => {
      it("throws NotFoundException when the payment has no image attached", async () => {
        prisma.invoicePayment.findUnique.mockResolvedValue({ id: "pay-3", imageKey: null });

        await expect(service.getPaymentImageUrl("pay-3")).rejects.toThrow(NotFoundException);
        expect(mockStorage.presignedUrl).not.toHaveBeenCalled();
      });

      it("returns the presigned url for an attached image", async () => {
        prisma.invoicePayment.findUnique.mockResolvedValue({
          id: "pay-3",
          imageKey: "payments/pay-3/image.jpg",
        });

        const result = await service.getPaymentImageUrl("pay-3");

        expect(mockStorage.presignedUrl).toHaveBeenCalledWith("payments/pay-3/image.jpg");
        expect(result).toEqual({ url: "https://signed/url" });
      });
    });

    describe("deletePaymentImage", () => {
      it("grouped payment: clears every row in the group and deletes the storage object once", async () => {
        prisma.invoicePayment.findUnique.mockResolvedValue({
          id: "pay-4",
          paymentGroupId: "grp-2",
          imageKey: "payments/grp-2/image.jpg",
        });

        const result = await service.deletePaymentImage("pay-4");

        expect(prisma.invoicePayment.updateMany).toHaveBeenCalledWith({
          where: { paymentGroupId: "grp-2" },
          data: { imageKey: null, imageOriginalName: null, imageMimeType: null },
        });
        expect(prisma.invoicePayment.update).not.toHaveBeenCalled();
        expect(mockStorage.delete).toHaveBeenCalledTimes(1);
        expect(mockStorage.delete).toHaveBeenCalledWith("payments/grp-2/image.jpg");
        expect(result).toEqual({ success: true });
      });

      it("throws NotFoundException when there is no image to delete", async () => {
        prisma.invoicePayment.findUnique.mockResolvedValue({ id: "pay-5", imageKey: null });

        await expect(service.deletePaymentImage("pay-5")).rejects.toThrow(NotFoundException);
        expect(mockStorage.delete).not.toHaveBeenCalled();
      });
    });

    describe("deletePayment — best-effort payment-image cleanup", () => {
      const invoiceWithImagedPayment = (paymentId: string, imageKey: string) => ({
        id: "inv-img",
        status: InvoiceStatus.PARTIAL,
        total: 100,
        dueDate: null,
        payments: [
          {
            id: paymentId,
            amount: 40,
            status: "PAID",
            method: "CASH",
            imageKey,
          },
        ],
      });

      it("deletes the stored object when no sibling payment still references it (count 0)", async () => {
        prisma.invoice.findUnique.mockResolvedValue(
          invoiceWithImagedPayment("pay-img-1", "payments/grp-3/image.jpg"),
        );
        prisma.invoice.update.mockResolvedValue({
          id: "inv-img",
          invoiceNumber: "INV-IMG",
          customerId: "cust-1",
          total: 100,
        });
        prisma.invoicePayment.count.mockResolvedValue(0);

        await service.deletePayment("inv-img", "pay-img-1");

        expect(prisma.invoicePayment.count).toHaveBeenCalledWith({
          where: { imageKey: "payments/grp-3/image.jpg" },
        });
        expect(mockStorage.delete).toHaveBeenCalledWith("payments/grp-3/image.jpg");
      });

      it("keeps the stored object when a sibling payment still references it (count 1)", async () => {
        prisma.invoice.findUnique.mockResolvedValue(
          invoiceWithImagedPayment("pay-img-2", "payments/grp-4/image.jpg"),
        );
        prisma.invoice.update.mockResolvedValue({
          id: "inv-img",
          invoiceNumber: "INV-IMG",
          customerId: "cust-1",
          total: 100,
        });
        prisma.invoicePayment.count.mockResolvedValue(1);

        await service.deletePayment("inv-img", "pay-img-2");

        expect(prisma.invoicePayment.count).toHaveBeenCalledWith({
          where: { imageKey: "payments/grp-4/image.jpg" },
        });
        expect(mockStorage.delete).not.toHaveBeenCalled();
      });

      it("skips the storage lookup entirely when the deleted payment carried no image", async () => {
        prisma.invoice.findUnique.mockResolvedValue({
          id: "inv-1",
          status: InvoiceStatus.PARTIAL,
          total: 100,
          dueDate: null,
          payments: [{ id: "pay-plain", amount: 40, status: "PAID", method: "CASH" }],
        });
        prisma.invoice.update.mockResolvedValue({
          id: "inv-1",
          invoiceNumber: "INV-1",
          customerId: "cust-1",
          total: 100,
        });

        await service.deletePayment("inv-1", "pay-plain");

        expect(prisma.invoicePayment.count).not.toHaveBeenCalled();
        expect(mockStorage.delete).not.toHaveBeenCalled();
      });
    });

    describe("recordPayment — createdPaymentId", () => {
      it("returns createdPaymentId alongside the updated invoice", async () => {
        prisma.invoice.findUnique.mockResolvedValue({
          id: "inv-1",
          status: InvoiceStatus.SENT,
          total: 100,
          dueDate: null,
          payments: [],
        });
        prisma.paymentCounter.upsert.mockResolvedValue({ id: "test-tenant", next: 2 });
        prisma.invoicePayment.create.mockResolvedValue({ id: "pay-new-1" });
        prisma.invoice.update.mockResolvedValue({
          id: "inv-1",
          invoiceNumber: "INV-0001",
          customerId: "cust-1",
          total: 100,
          payments: [],
        });

        const result = (await service.recordPayment("inv-1", {
          amount: 100,
          method: "CASH",
        } as any)) as any;

        expect(result.createdPaymentId).toBe("pay-new-1");
        // Existing consumers reading Invoice fields off the response are unaffected.
        expect(result.id).toBe("inv-1");
      });
    });
  });

  // ─── Backdated orders drive invoice dating ────────────────────────────────

  describe("invoice dating follows the order's business date", () => {
    const backdated = new Date(Date.now() - 40 * 86_400_000);

    const seedDatingSpies = () => {
      jest
        .spyOn(service as any, "resolveDefaultTerms")
        .mockResolvedValue({ terms: "Net 30", dueDays: 30 });
      jest
        .spyOn(service as any, "resolveTenantInvoiceDefaults")
        .mockResolvedValue({ notes: null, terms: null, timezone: null });
      jest.spyOn(service as any, "generateInvoiceNumber").mockResolvedValue("INV-1");
      prisma.customer.findUnique.mockResolvedValue({ isTaxExempt: false });
      prisma.orderItem.update.mockResolvedValue({});
      prisma.invoice.aggregate.mockResolvedValue({ _sum: { shippingFee: 0 } });
      prisma.invoice.create.mockImplementation((args: any) =>
        Promise.resolve({ ...args.data, id: "inv-1", items: [], payments: [], customer: {} }),
      );
    };

    const orderWith = (over: any = {}) => ({
      id: "ord-1",
      customerId: "cust-1",
      orderNumber: "ORD-9",
      subtotal: 20,
      tax: 0,
      shippingFee: 0,
      lineItems: [
        {
          id: "li-1",
          productId: "p1",
          name: null,
          qty: 2,
          invoicedQty: 0,
          boxes: null,
          pieces: null,
          unitPrice: 10,
          subtotal: 20,
          originalPrice: null,
          priceType: "STANDARD",
          product: { name: "Widget", unitsPerBox: 0 },
        },
      ],
      ...over,
    });

    /** Whole days between two invoice dates, tolerant of a DST hour. */
    const daysBetween = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / 86_400_000);

    /**
     * A same-day sale is dated at UTC MIDNIGHT of the current calendar day (tenant
     * timezone; UTC here, since the mocked config carries none) — not at the wall-clock
     * instant. Every render surface formats these with timeZone: "UTC", so a raw
     * new Date() after 8pm US-Eastern would print the invoice one day late.
     */
    const expectDatedToday = (issueDate: Date) => {
      expect(issueDate.toISOString()).toMatch(/T00:00:00\.000Z$/);
      expect(issueDate.toISOString().slice(0, 10)).toBe(new Date().toISOString().slice(0, 10));
    };

    it("createInvoiceFromOrder issues on the order date and runs the term from it", async () => {
      seedDatingSpies();
      prisma.order.findUnique.mockResolvedValue(orderWith({ orderDate: backdated }));

      await service.createInvoiceFromOrder("ord-1");

      const data = (prisma.invoice.create.mock.calls[0][0] as any).data;
      expect(data.issueDate).toEqual(backdated);
      expect(daysBetween(data.issueDate, data.dueDate)).toBe(30);
    });

    it("createInvoiceFromOrder falls back to today when the order has no business date", async () => {
      seedDatingSpies();
      prisma.order.findUnique.mockResolvedValue(orderWith({ orderDate: null }));

      await service.createInvoiceFromOrder("ord-1");

      const data = (prisma.invoice.create.mock.calls[0][0] as any).data;
      expectDatedToday(data.issueDate);
      expect(daysBetween(data.issueDate, data.dueDate)).toBe(30);
      // No override, so the persisted T&C falls back to the tenant default, then the term.
      expect(data.terms).toBe("Net 30");
    });

    it("createInvoiceFromOrder honors an explicit dueDate/terms override", async () => {
      seedDatingSpies();
      prisma.order.findUnique.mockResolvedValue(orderWith({ orderDate: backdated }));

      await service.createInvoiceFromOrder("ord-1", undefined, {
        dueDate: "2026-10-03",
        terms: "  Payment due in 60 days.  ",
      });

      const data = (prisma.invoice.create.mock.calls[0][0] as any).data;
      // The operator's chosen due date is stored verbatim, NOT recomputed from the term.
      expect(data.dueDate).toEqual(new Date("2026-10-03T00:00:00.000Z"));
      expect(data.terms).toBe("Payment due in 60 days.");
      // The override moves the due date only; the invoice still bills on its business date.
      expect(data.issueDate).toEqual(backdated);
    });

    it("createInvoiceFromOrderWithTenant issues on the order date", async () => {
      seedDatingSpies();
      prisma.systemConfig.findFirst.mockResolvedValue(null);
      prisma.tenantConfig.findUnique.mockResolvedValue(null);
      prisma.order.findFirst.mockResolvedValue(orderWith({ orderDate: backdated }));
      prisma.customer.findFirst.mockResolvedValue({ isTaxExempt: false });

      await service.createInvoiceFromOrderWithTenant("ord-1", "test-tenant");

      const data = (prisma.invoice.create.mock.calls[0][0] as any).data;
      expect(data.issueDate).toEqual(backdated);
      expect(daysBetween(data.issueDate, data.dueDate)).toBe(30);
    });

    it("the regulated ledger books the sale in the backdated period", async () => {
      seedDatingSpies();
      const ledger = (service as any).ledger;
      prisma.order.findUnique.mockResolvedValue(orderWith({ orderDate: backdated }));

      await service.createInvoiceFromOrder("ord-1");

      expect(ledger.writeSaleEntries).toHaveBeenCalledWith(
        expect.objectContaining({ soldAt: backdated }),
      );
    });

    it("createPartialFromOrder issues on the order date and runs its default term from it", async () => {
      seedDatingSpies();
      prisma.order.findUnique.mockResolvedValue(
        orderWith({
          orderDate: backdated,
          lineItems: [{ ...orderWith().lineItems[0], id: "oi-1" }],
        }),
      );

      const invoice = (await service.createPartialFromOrder("ord-1", {
        items: [{ orderItemId: "oi-1", qty: 2 }],
      } as any)) as any;

      expect(invoice.issueDate).toEqual(backdated);
      expect(daysBetween(invoice.issueDate, invoice.dueDate)).toBe(30);
    });

    it("createPartialFromOrder falls back to today without a business date", async () => {
      seedDatingSpies();
      prisma.order.findUnique.mockResolvedValue(
        orderWith({ orderDate: null, lineItems: [{ ...orderWith().lineItems[0], id: "oi-1" }] }),
      );

      const invoice = (await service.createPartialFromOrder("ord-1", {
        items: [{ orderItemId: "oi-1", qty: 2 }],
      } as any)) as any;

      expectDatedToday(invoice.issueDate);
    });

    it("createPartialFromOrder labels the split with the Net-N the modal picked", async () => {
      seedDatingSpies();
      prisma.order.findUnique.mockResolvedValue(
        orderWith({ orderDate: null, lineItems: [{ ...orderWith().lineItems[0], id: "oi-1" }] }),
      );

      // What SplitInvoiceModal posts: the derived date AND the term that derived it.
      const invoice = (await service.createPartialFromOrder("ord-1", {
        items: [{ orderItemId: "oi-1", qty: 2 }],
        dueDate: "2026-10-03",
        paymentTermsLabel: "Net 60",
      } as any)) as any;

      expect(invoice.paymentTermsLabel).toBe("Net 60");
      expect(invoice.dueDate).toEqual(new Date("2026-10-03T00:00:00.000Z"));
      // The Net-N never lands in the long-form T&C column.
      expect(invoice.terms).toBe("Net 30");
    });

    it("createPartialFromOrder leaves the label null for a bare dueDate override", async () => {
      seedDatingSpies();
      prisma.order.findUnique.mockResolvedValue(
        orderWith({ orderDate: null, lineItems: [{ ...orderWith().lineItems[0], id: "oi-1" }] }),
      );

      const invoice = (await service.createPartialFromOrder("ord-1", {
        items: [{ orderItemId: "oi-1", qty: 2 }],
        dueDate: "2026-10-03",
      } as any)) as any;

      expect(invoice.paymentTermsLabel).toBeNull();
    });
  });

  // ─── settledAt: when the money actually landed in the bank ────────────────

  describe("payment settledAt", () => {
    const futureSettlement = "2027-01-15";

    const seedInvoiceForPayment = () => {
      prisma.invoice.findUnique.mockResolvedValue({
        id: "inv-1",
        status: InvoiceStatus.SENT,
        total: 100,
        dueDate: null,
        payments: [],
      });
      prisma.paymentCounter.upsert.mockResolvedValue({ id: "test-tenant", next: 2 });
      prisma.invoicePayment.create.mockResolvedValue({ id: "pay-new-1" });
      prisma.invoice.update.mockResolvedValue({
        id: "inv-1",
        invoiceNumber: "INV-0001",
        customerId: "cust-1",
        total: 100,
        payments: [],
      });
    };

    it("recordPayment stores a post-dated settlement without clamping it to today", async () => {
      seedInvoiceForPayment();

      await service.recordPayment("inv-1", {
        amount: 100,
        method: "CHECK",
        settledAt: futureSettlement,
      } as any);

      expect(prisma.invoicePayment.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ settledAt: new Date(futureSettlement) }),
      });
    });

    it("recordPayment leaves settledAt null when the bank date is unknown", async () => {
      seedInvoiceForPayment();

      await service.recordPayment("inv-1", { amount: 100, method: "CASH" } as any);

      expect(prisma.invoicePayment.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ settledAt: null }),
      });
    });

    describe("updatePayment", () => {
      const seedExistingPayment = () => {
        prisma.invoice.findUnique.mockResolvedValue({
          id: "inv-1",
          status: InvoiceStatus.SENT,
          total: 100,
          dueDate: null,
          payments: [
            { id: "pay-1", status: "PAID", amount: 100, settledAt: new Date("2026-07-01") },
          ],
        });
        prisma.invoice.update.mockResolvedValue({
          id: "inv-1",
          invoiceNumber: "INV-0001",
          customerId: "cust-1",
          total: 100,
          payments: [],
        });
      };

      const updateData = () => (prisma.invoicePayment.update.mock.calls[0][0] as any).data;

      it("sets the bank date when supplied", async () => {
        seedExistingPayment();

        await service.updatePayment("inv-1", "pay-1", {
          amount: 100,
          method: "CHECK",
          settledAt: futureSettlement,
        } as any);

        expect(updateData().settledAt).toEqual(new Date(futureSettlement));
      });

      it("clears the bank date when explicitly null", async () => {
        seedExistingPayment();

        await service.updatePayment("inv-1", "pay-1", {
          amount: 100,
          method: "CHECK",
          settledAt: null,
        } as any);

        expect(updateData().settledAt).toBeNull();
      });

      it("preserves the stored bank date when the key is absent", async () => {
        seedExistingPayment();

        await service.updatePayment("inv-1", "pay-1", { amount: 100, method: "CHECK" } as any);

        expect(updateData()).not.toHaveProperty("settledAt");
      });

      // F03: deletePayment (:4653) and voidPayment (:4941) both guard on the
      // STORED payment.method before letting a CREDIT_NOTE/ADVANCE payment be
      // undone any way but its dedicated reversal path. updatePayment is the
      // one sibling with no such guard — it checks only the INCOMING dto.method
      // (rejecting a PATCH that sets method TO CREDIT_NOTE/ADVANCE) and never
      // reads the row's stored method, so a PATCH with method "CASH" on a
      // payment stored as CREDIT_NOTE silently rewrites it with no balance
      // compensation, permanently orphaning the credit note's amountUsed. See
      // .claude/pipeline/2026-08-31-f03-payment-truth/{spec,test-plan}.md R5/T-B81.
      describe("stored-method guard (T-B81 / R5 / REG-B81)", () => {
        it("rejects (409) a PATCH that changes method away from a STORED CREDIT_NOTE payment, and touches nothing", async () => {
          prisma.invoice.findUnique.mockResolvedValue({
            id: "inv-b81",
            status: InvoiceStatus.PARTIAL,
            total: 500,
            dueDate: null,
            payments: [
              {
                id: "pay-b81",
                status: "PAID",
                amount: 200,
                method: "CREDIT_NOTE",
                creditNoteId: "cn-b81",
              },
            ],
          });

          // Today: the upfront guard only checks dto.method ("CASH" isn't
          // CREDIT_NOTE/ADVANCE, so it passes) and the stored method is never
          // read — this resolves successfully and silently overwrites the row.
          // Red now.
          await expect(
            service.updatePayment("inv-b81", "pay-b81", { amount: 200, method: "CASH" } as any),
          ).rejects.toThrow(ConflictException);

          expect(prisma.invoicePayment.update).not.toHaveBeenCalled();
          // Wallet untouched: the guard must abort BEFORE any balance compensation,
          // the same way its two siblings do.
          expect(prisma.creditNote.update).not.toHaveBeenCalled();
        });
      });

      // F03 (R1 / REG-B11): updatePayment narrowed the OTHER payments to
      // sumConfirmed but folded the row under edit in at full value for anything
      // but VOID. So un-confirming a payment (PAID -> DRAFT), or merely correcting
      // a reference on an already-DRAFT one, recomputed the invoice to PAID and
      // stamped paidAt off money nobody confirmed — while sumConfirmed still
      // reported the full balance in findAll/findOne and on the PDF. VOID and DRAFT
      // must both contribute $0, exactly as recordPayment already does.
      describe("un-confirmed rows never fund the recomputed status (R1 / REG-B11)", () => {
        const seedSinglePayment = (storedStatus: string) => {
          prisma.invoice.findUnique.mockResolvedValue({
            id: "inv-b11u",
            status: InvoiceStatus.SENT,
            total: 500,
            dueDate: null,
            payments: [{ id: "pay-b11u", status: storedStatus, amount: 500, method: "ACH" }],
          });
          prisma.invoicePayment.update.mockResolvedValue({});
          prisma.invoice.update.mockResolvedValue({
            id: "inv-b11u",
            invoiceNumber: "INV-0009",
            customerId: "cust-1",
            total: 500,
            payments: [],
          });
        };

        const invoiceData = () => (prisma.invoice.update.mock.calls[0][0] as any).data;

        it("REG-B11: PATCHing the only payment to DRAFT takes the invoice off PAID and clears paidAt", async () => {
          seedSinglePayment("PAID");

          await service.updatePayment("inv-b11u", "pay-b11u", {
            amount: 500,
            method: "ACH",
            status: "DRAFT",
          } as any);

          expect(invoiceData().status).toBe(InvoiceStatus.SENT);
          expect(invoiceData().paidAt).toBeNull();
        });

        it("REG-B11: editing an already-DRAFT payment leaves the invoice unpaid", async () => {
          seedSinglePayment("DRAFT");

          // No status key in the dto, so newPaymentStatus falls back to the STORED
          // "DRAFT" — a not-VOID effectiveAmount would cash the full $500 here.
          await service.updatePayment("inv-b11u", "pay-b11u", {
            amount: 500,
            method: "ACH",
            reference: "corrected-ref",
          } as any);

          expect(invoiceData().status).toBe(InvoiceStatus.SENT);
          expect(invoiceData().paidAt).toBeNull();
        });
      });
    });

    it("recordStandalonePayment stamps the bank date on every row of the group", async () => {
      prisma.paymentCounter.upsert.mockResolvedValue({ id: "test-tenant", next: 3 });
      prisma.invoice.findFirst.mockResolvedValue({
        id: "inv-1",
        status: InvoiceStatus.SENT,
        total: 100,
        dueDate: null,
        payments: [],
      });
      prisma.invoicePayment.findMany.mockResolvedValue([]);

      await service.recordStandalonePayment({
        customerId: "cust-1",
        totalAmount: 60,
        method: "CHECK",
        settledAt: futureSettlement,
        allocations: [
          { invoiceId: "inv-1", amount: 40 },
          { invoiceId: "inv-2", amount: 20 },
        ],
      } as any);

      const calls = prisma.invoicePayment.create.mock.calls;
      expect(calls).toHaveLength(2);
      for (const [args] of calls) {
        expect((args as any).data.settledAt).toEqual(new Date(futureSettlement));
      }
    });

    describe("setCheckStatus CLEARED", () => {
      const basePayment = {
        id: "pay-1",
        invoiceId: "inv-1",
        method: "CHECK",
        status: "PAID",
        checkStatus: CheckStatus.DEPOSITED,
        amount: 100,
        paymentNumber: "PAY-0001",
        reference: null,
        settledAt: null,
      };

      const seedInvoiceLookup = () =>
        prisma.invoice.findFirst.mockResolvedValue({
          invoiceNumber: "INV-0001",
          customerId: "cust-1",
          status: InvoiceStatus.PAID,
          total: 100,
        });

      const updateData = () => (prisma.invoicePayment.update.mock.calls[0][0] as any).data;

      // The cash-basis reporting window in BookkeepingService keys on this
      // expression, so it is the seam a fabricated settledAt would shift.
      const reportingDate = (row: { settledAt: Date | null; paidAt: Date }) =>
        row.settledAt ?? row.paidAt;

      it("an explicit landing date drives both clearedAt and settledAt", async () => {
        prisma.invoicePayment.findFirst.mockResolvedValue(basePayment);
        seedInvoiceLookup();

        await service.setCheckStatus("inv-1", "pay-1", {
          status: CheckStatus.CLEARED,
          settledAt: "2026-07-20",
        } as any);

        expect(updateData().clearedAt).toEqual(new Date("2026-07-20"));
        expect(updateData().settledAt).toEqual(new Date("2026-07-20"));
      });

      it("without one, a NULL bank date stays NULL while clearedAt is still stamped", async () => {
        const before = Date.now();
        prisma.invoicePayment.findFirst.mockResolvedValue(basePayment);
        seedInvoiceLookup();

        await service.setCheckStatus("inv-1", "pay-1", { status: CheckStatus.CLEARED });

        expect(updateData()).not.toHaveProperty("settledAt");
        expect(updateData().clearedAt.getTime()).toBeGreaterThanOrEqual(before);
      });

      it("without one, a bank date already entered on the payment is left untouched", async () => {
        const entered = new Date("2026-07-05");
        prisma.invoicePayment.findFirst.mockResolvedValue({ ...basePayment, settledAt: entered });
        seedInvoiceLookup();

        await service.setCheckStatus("inv-1", "pay-1", { status: CheckStatus.CLEARED });

        expect(updateData()).not.toHaveProperty("settledAt");
        expect(updateData().clearedAt).not.toEqual(entered);
      });

      it("clearing a legacy check does not move it out of its original period", async () => {
        const paidAt = new Date("2025-11-14T00:00:00.000Z");
        prisma.invoicePayment.findFirst.mockResolvedValue({ ...basePayment, paidAt });
        seedInvoiceLookup();

        await service.setCheckStatus("inv-1", "pay-1", { status: CheckStatus.CLEARED });

        const after = { ...basePayment, paidAt, ...updateData() };
        expect(reportingDate(after)).toEqual(paidAt);
      });
    });

    it("exportPayments carries a Bank Date column right after Date", async () => {
      prisma.invoicePayment.findMany.mockResolvedValue([
        {
          paymentNumber: "PAY-0001",
          paidAt: new Date("2026-07-01T00:00:00.000Z"),
          settledAt: new Date("2027-01-15T00:00:00.000Z"),
          method: "CHECK",
          reference: null,
          bankCharges: null,
          amount: 100,
          status: "PAID",
          invoice: { invoiceNumber: "INV-0001", customer: { businessName: "Acme" } },
        },
        {
          paymentNumber: "PAY-0002",
          paidAt: new Date("2026-07-02T00:00:00.000Z"),
          settledAt: null,
          method: "CASH",
          reference: null,
          bankCharges: null,
          amount: 50,
          status: "PAID",
          invoice: { invoiceNumber: "INV-0002", customer: { businessName: "Acme" } },
        },
      ]);

      const [header, first, second] = (await service.exportPayments({})).split("\n");

      expect(header).toBe(
        "Payment#,Date,Bank Date,Customer,Invoice#,Method,Reference,Bank Charges,Amount,Status",
      );
      expect(first.split(",").slice(0, 3)).toEqual(["PAY-0001", "2026-07-01", "2027-01-15"]);
      expect(second.split(",").slice(0, 3)).toEqual(["PAY-0002", "2026-07-02", ""]);
    });

    // Harness fix (REG-B169, T2): both orderBy expectations rewritten from a
    // single-key object to the array-with-id-tiebreaker form — listAllPayments'
    // orderBy is now `[{ <sortField>: <dir> }, { id: <dir> }]` for a custom
    // sortBy, same convention as the default-sort T2 pin above.
    it("settledAt is an accepted sort field on both the list and the export", async () => {
      prisma.invoicePayment.findMany.mockResolvedValue([]);
      prisma.invoicePayment.count.mockResolvedValue(0);

      await service.listAllPayments({ sortBy: "settledAt", sortDir: "asc" });
      expect(prisma.invoicePayment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: [{ settledAt: "asc" }, { id: "asc" }] }),
      );

      prisma.invoicePayment.findMany.mockClear();
      await service.exportPayments({ sortBy: "settledAt", sortDir: "desc" });
      expect(prisma.invoicePayment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: [{ settledAt: "desc" }, { id: "desc" }] }),
      );
    });
  });

  // ─── B7: applyPriceAdjustment() must fold categoryTaxAmount (excise/regulated
  // tax) into the recomputed taxAmount/total, same as every other recompute
  // site in this file. Before the fix this silently dropped the excise amount
  // and propagated the shortfall to any linked order. ───────────────────────

  describe("B7 — applyPriceAdjustment() folds category (excise) tax", () => {
    it("keeps categoryTaxAmount in the recomputed taxAmount/total on a SINGLE-scope adjustment", async () => {
      const invoiceItem = {
        id: "li-1",
        invoiceId: "inv-adj-1",
        productId: "prod-1",
        unitPrice: 10,
        discount: 0,
        subtotal: 100,
        qty: 10,
        taxRate: 0.1,
        // Regulated/excise tax snapshot on the line — NOT part of taxRate.
        categoryTaxAmount: 5,
      };
      const invoice = {
        id: "inv-adj-1",
        customerId: "cust-1",
        orderId: null,
        status: InvoiceStatus.SENT,
        discount: 0,
        shippingFee: 0,
        internalNotes: null,
        items: [invoiceItem],
      };

      prisma.invoice.findUnique.mockResolvedValue(invoice);
      prisma.invoiceItem.update.mockResolvedValue({});
      // Post-update read inside applyToInvoice: the price change lands on
      // subtotal; categoryTaxAmount is a fixed per-line snapshot untouched by
      // the price adjustment.
      prisma.invoiceItem.findMany.mockResolvedValue([
        { ...invoiceItem, unitPrice: 12, subtotal: 120 },
      ]);
      prisma.invoice.update.mockResolvedValue({});

      await service.applyPriceAdjustment("inv-adj-1", {
        items: [{ itemId: "li-1", newUnitPrice: 12 }],
        scope: "SINGLE",
      });

      // regularTax = 120 * 0.1 = 12; categoryTaxTotal = 5 (excise). Before the
      // fix taxAmount was just regularTax (12) and total was 132 — silently
      // dropping the $5 excise amount from the bill.
      expect(prisma.invoice.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "inv-adj-1" },
          data: expect.objectContaining({
            subtotal: 120,
            taxAmount: 17,
            total: 137,
          }),
        }),
      );
    });
  });

  // F03 (T-B57 / R3 / REG-B57): applyPriceAdjustment's item loop writes only
  // unitPrice/subtotal — categoryTaxAmount is never recomputed, so a PERCENT_OF_SALE
  // line keeps its pre-adjustment excise amount even though the taxable subtotal
  // changed, mirroring recomputeLineCategoryTaxes (orders.service.ts :212-256) is
  // the fix. See .claude/pipeline/2026-08-31-f03-payment-truth/{spec,test-plan}.md
  // R3/T-B57.
  describe("applyPriceAdjustment — recomputes PERCENT_OF_SALE categoryTax (T-B57 / R3 / REG-B57)", () => {
    it("re-derives categoryTaxAmount from the NEW subtotal (7% of $50 = $3.50) and resums invoice.taxAmount", async () => {
      const invoiceItem = {
        id: "li-b57",
        invoiceId: "inv-b57",
        productId: "prod-reg",
        trackedCategoryId: "cat-1",
        unitPrice: 10,
        discount: 0,
        subtotal: 100,
        qty: 10,
        taxRate: 0,
        // Stale: 7% of the OLD $100 subtotal.
        categoryTaxAmount: 7,
      };
      const invoice = {
        id: "inv-b57",
        customerId: "cust-1",
        orderId: null,
        status: InvoiceStatus.SENT,
        discount: 0,
        shippingFee: 0,
        internalNotes: null,
        items: [invoiceItem],
      };

      prisma.invoice.findUnique.mockResolvedValue(invoice);
      // Whichever query shape the fix uses to look up the category's tax config.
      prisma.trackedCategory.findMany.mockResolvedValue([
        { id: "cat-1", taxType: "PERCENT_OF_SALE", rate: 0.07, priceIncludesTax: false },
      ]);
      prisma.trackedCategory.findUnique.mockResolvedValue({
        id: "cat-1",
        taxType: "PERCENT_OF_SALE",
        rate: 0.07,
        priceIncludesTax: false,
      });

      // A tiny live "store" for categoryTaxAmount: the post-update totals read
      // (invoiceItem.findMany) must reflect whatever the item-update loop
      // actually PERSISTED, not a value this test hands it for free — otherwise
      // the test would pass regardless of what the service computes.
      let persistedCategoryTax = invoiceItem.categoryTaxAmount;
      prisma.invoiceItem.update.mockImplementation(async (args: any) => {
        if (args?.data && "categoryTaxAmount" in args.data) {
          persistedCategoryTax = args.data.categoryTaxAmount;
        }
        return {};
      });
      prisma.invoiceItem.findMany.mockImplementation(async () => [
        { ...invoiceItem, unitPrice: 5, subtotal: 50, categoryTaxAmount: persistedCategoryTax },
      ]);
      prisma.invoice.update.mockResolvedValue({});

      await service.applyPriceAdjustment("inv-b57", {
        items: [{ itemId: "li-b57", newUnitPrice: 5 }],
        scope: "SINGLE",
      });

      // Today: applyToInvoice never touches categoryTaxAmount, so
      // persistedCategoryTax stays at the stale $7 and taxAmount keeps $7 (not
      // resummed to $3.50) — red now.
      expect(prisma.invoiceItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "li-b57" },
          data: expect.objectContaining({ categoryTaxAmount: 3.5 }),
        }),
      );
      // What the item loop actually PERSISTED, read back off the little live store
      // above rather than off a mock's call list — this is the value the post-update
      // invoiceItem.findMany hands back, so it is also what makes the taxAmount
      // assertion below load-bearing instead of a constant this test supplied.
      expect(persistedCategoryTax).toBe(3.5);
      expect(prisma.invoice.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "inv-b57" },
          data: expect.objectContaining({ subtotal: 50, taxAmount: 3.5, total: 53.5 }),
        }),
      );
    });

    // The recompute must mirror orders.service.recomputeLineCategoryTaxes on BOTH of
    // its non-obvious inputs, or it corrupts the very numbers it exists to keep
    // fresh: the per-unit piece basis (a boxed line ordered in SELLING UNITS stores
    // unitsPerBox NULL, so the levy collapses by unitsPerBox without the product
    // fallback) and the customer's tax exemption (foldCategoryTax zeroes every line
    // at creation; re-deriving here bills excise an exempt customer does not owe).
    const seedExciseLine = (opts: { isTaxExempt?: boolean } = {}) => {
      const invoiceItem = {
        id: "li-b57e",
        invoiceId: "inv-b57e",
        productId: "prod-reg",
        trackedCategoryId: "cat-2",
        unitPrice: 10,
        discount: 0,
        subtotal: 100,
        qty: 10,
        // Boxed product ordered as SELLING UNITS: create snapshots unitsPerBox only
        // on box-split lines, so both are null here — the hole the fallback fills.
        boxes: null,
        unitsPerBox: null,
        taxRate: 0,
        // 0.50 x (10 x 20 pieces) — what creation billed off the PRODUCT's box size.
        categoryTaxAmount: 100,
      };
      prisma.invoice.findUnique.mockResolvedValue({
        id: "inv-b57e",
        customerId: "cust-2",
        orderId: null,
        status: InvoiceStatus.SENT,
        discount: 0,
        shippingFee: 0,
        internalNotes: null,
        dueDate: null,
        items: [invoiceItem],
        payments: [],
      });
      prisma.customer.findFirst.mockResolvedValue({ isTaxExempt: !!opts.isTaxExempt });
      prisma.trackedCategory.findMany.mockResolvedValue([
        { id: "cat-2", taxType: "EXCISE_PER_UNIT", rate: 0.5, priceIncludesTax: false },
      ]);
      prisma.product.findMany.mockResolvedValue([{ id: "prod-reg", unitsPerBox: 20 }]);
      prisma.invoiceItem.update.mockResolvedValue({});
      prisma.invoiceItem.findMany.mockResolvedValue([
        { ...invoiceItem, unitPrice: 5, subtotal: 50, categoryTaxAmount: 0 },
      ]);
      prisma.invoice.update.mockResolvedValue({});
    };

    const itemUpdateData = () => (prisma.invoiceItem.update.mock.calls[0][0] as any).data;

    it("REG-B57: an EXCISE_PER_UNIT line with no unitsPerBox snapshot keeps its per-PIECE basis (product fallback)", async () => {
      seedExciseLine();

      await service.applyPriceAdjustment("inv-b57e", {
        items: [{ itemId: "li-b57e", newUnitPrice: 5 }],
        scope: "SINGLE",
      });

      // 0.50 x 200 pieces. Without the product fallback the basis collapses to the
      // 10 selling units and the levy drops to $5 — $95 of excise silently lost, and
      // pushed to the linked order by recomputeOrderFromInvoices.
      expect(itemUpdateData().categoryTaxAmount).toBe(100);
    });

    it("REG-B57: a TAX-EXEMPT customer's line stays at $0 category tax after a re-price", async () => {
      seedExciseLine({ isTaxExempt: true });

      await service.applyPriceAdjustment("inv-b57e", {
        items: [{ itemId: "li-b57e", newUnitPrice: 5 }],
        scope: "SINGLE",
      });

      // foldCategoryTax zeroed this line at creation; the recompute must preserve
      // that, not re-derive $100 of excise onto an exempt customer's invoice.
      expect(itemUpdateData().categoryTaxAmount).toBe(0);
    });
  });

  // ─── F03: CONFIRMED-basis payment fixtures ───────────────────────────────────
  // Several F03 cases turn on WHICH payment rows a read returns. Handing the service
  // a pre-filtered list would pass no matter which predicate it used, so these helpers
  // reproduce the database instead: they honour whatever `where.status` the service
  // actually passes — in the invoice `include`, in invoicePayment.findMany, or in an
  // aggregate — and the assertions then pin the resulting NUMBER. A `status: { not:
  // "VOID" }` predicate cannot reach those numbers; only PAID-only can.
  type FakePaymentRow = { id: string; amount: number; status: string };

  const matchesPaymentStatus = (value: string, cond: any): boolean => {
    if (cond === undefined) return true;
    if (typeof cond === "string") return value === cond;
    if (cond.equals !== undefined) return value === cond.equals;
    if (cond.not !== undefined) return value !== cond.not;
    if (cond.in !== undefined) return (cond.in as string[]).includes(value);
    return true;
  };

  const filterPayments = (rows: FakePaymentRow[], where: any): FakePaymentRow[] =>
    rows.filter((p) => matchesPaymentStatus(p.status, where?.status));

  /** Point invoicePayment.findMany/aggregate at the same simulated rows. */
  const stubPaymentReads = (rows: FakePaymentRow[]) => {
    prisma.invoicePayment.findMany.mockImplementation(async (args: any) =>
      filterPayments(rows, args?.where),
    );
    prisma.invoicePayment.aggregate.mockImplementation(async (args: any) => ({
      _sum: { amount: filterPayments(rows, args?.where).reduce((s, p) => s + p.amount, 0) },
    }));
  };

  // F03 (T-B74 / R4 / REG-B74): applyPriceAdjustment blocks PAID/WRITTEN_OFF/VOID
  // up front and rewrites subtotal/taxAmount/total, but never calls recomputeStatus
  // — the helper ~15 other totals-changing sites in this file call afterward. A
  // PARTIAL invoice whose lowered total falls at/below what's already paid keeps
  // its stale status instead of flipping to PAID, mis-gating write-off/reminder
  // eligibility (both branch on status). See
  // .claude/pipeline/2026-08-31-f03-payment-truth/{spec,test-plan}.md R4/T-B74.
  //
  // Two cases over the SAME $150 -> $80 adjustment, because one alone cannot tell the
  // CONFIRMED basis apart from the buggy non-VOID one: case (a) fixes that the status
  // is recomputed at all, case (b) fixes that it is recomputed from CONFIRMED payments
  // only — the DRAFT row there is what a `not: VOID` sum would wrongly cash in.
  describe("applyPriceAdjustment — recomputes invoice status on CONFIRMED payments (T-B74 / R4 / REG-B74)", () => {
    const runAdjustment = async (status: InvoiceStatus, payments: FakePaymentRow[]) => {
      const invoiceItem = {
        id: "li-b74",
        invoiceId: "inv-b74",
        productId: "prod-1",
        unitPrice: 15,
        discount: 0,
        subtotal: 150,
        qty: 10,
        taxRate: 0,
        categoryTaxAmount: 0,
      };
      const invoice = {
        id: "inv-b74",
        customerId: "cust-1",
        orderId: null,
        status,
        discount: 0,
        shippingFee: 0,
        internalNotes: null,
        dueDate: null,
        items: [invoiceItem],
      };

      stubPaymentReads(payments);
      prisma.invoice.findUnique.mockImplementation(async (args: any) => ({
        ...invoice,
        payments: filterPayments(payments, args?.include?.payments?.where),
      }));
      prisma.invoiceItem.update.mockResolvedValue({});
      prisma.invoiceItem.findMany.mockResolvedValue([
        { ...invoiceItem, unitPrice: 8, subtotal: 80 },
      ]);
      prisma.invoice.update.mockResolvedValue({});

      await service.applyPriceAdjustment("inv-b74", {
        items: [{ itemId: "li-b74", newUnitPrice: 8 }],
        scope: "SINGLE",
      });
    };

    it("(a) flips PARTIAL -> PAID once the lowered total ($150 -> $80) is met by CONFIRMED payments ($80 PAID)", async () => {
      await runAdjustment(InvoiceStatus.PARTIAL, [{ id: "pay-paid", amount: 80, status: "PAID" }]);

      // Today: applyPriceAdjustment never calls recomputeStatus at all, so the
      // invoice.update call carries no `status` key whatsoever and the invoice
      // stays PARTIAL — red now.
      expect(prisma.invoice.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "inv-b74" },
          data: expect.objectContaining({ status: InvoiceStatus.PAID }),
        }),
      );
    });

    it("(c) stamps paidAt alongside that PAID flip, so the invoice still lands in the revenue window", async () => {
      await runAdjustment(InvoiceStatus.PARTIAL, [{ id: "pay-paid", amount: 80, status: "PAID" }]);

      // Every sibling status writer pairs status with paidAt. A PAID row with a NULL
      // paidAt is invisible to bookkeeping's getSummary totalRevenue, the P&L window
      // and getTimeToGetPaid — all of which filter on status PAID *and* paidAt.
      const data = (prisma.invoice.update.mock.calls[0][0] as any).data;
      expect(data.paidAt).toBeInstanceOf(Date);
    });

    it("(b) lands PARTIAL, not PAID, when only an unconfirmed DRAFT payment would clear the lowered total ($60 PAID + $50 DRAFT)", async () => {
      await runAdjustment(InvoiceStatus.SENT, [
        { id: "pay-paid", amount: 60, status: "PAID" },
        { id: "pay-draft", amount: 50, status: "DRAFT" },
      ]);

      // CONFIRMED basis: $60 of an $80 total -> PARTIAL (a real change from SENT, so
      // it is written whether the fix persists the status unconditionally or only on
      // change). Red today for the same reason as (a) — no status key at all.
      //
      // This is the case the mutation dies on: summing non-VOID payments gives
      // $110 >= $80 and marks the invoice PAID off a payment nobody has confirmed,
      // closing it to reminders and write-off while $20 is genuinely outstanding.
      expect(prisma.invoice.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "inv-b74" },
          data: expect.objectContaining({ status: InvoiceStatus.PARTIAL }),
        }),
      );
    });
  });

  // F03 (T-B102 / R8 / REG-B102) — the CALLER half of the email fix. The rendering
  // half lives in email.service.spec.ts; it is handed totalPaid/balanceDue directly,
  // so a build that renders the tfoot perfectly while feeding it DRAFT-inflated
  // numbers would still pass there. These two cases pin what invoices.service
  // actually computes and passes at :3501 (send) and :3666 (reminder).
  describe("sendEmail / sendReminder pass CONFIRMED totalPaid + balanceDue (T-B102 / R8 / REG-B102)", () => {
    // $500 invoice, $300 CONFIRMED + $100 DRAFT. The DRAFT row is the discriminator:
    // a non-VOID sum reports $400 paid / $100 due and would dun the customer for the
    // wrong number; the truth is $300 paid / $200 due.
    const PAYMENTS: FakePaymentRow[] = [
      { id: "pay-confirmed", amount: 300, status: "PAID" },
      { id: "pay-draft", amount: 100, status: "DRAFT" },
    ];

    const invoiceFixture = (status: InvoiceStatus) => ({
      id: "inv-b102",
      orderId: null, // standalone → assertOrderInvoiceUnlocked skips the order check
      invoiceNumber: "INV-2001",
      status,
      deliveryBatchId: null,
      total: 500,
      subtotal: 500,
      taxAmount: 0,
      discount: 0,
      shippingFee: 0,
      depositPercent: null,
      depositDueDate: null,
      paymentTermsLabel: null,
      issueDate: new Date("2026-01-01"),
      dueDate: new Date("2026-01-31"),
      customer: { id: "c-b102", businessName: "Acme Buyer", email: "buyer@example.com" },
      items: [{ description: "Widget", qty: 10, unitPrice: 50, subtotal: 500, msrp: null }],
    });

    beforeEach(() => {
      stubPaymentReads(PAYMENTS);
      prisma.invoice.findUnique.mockImplementation(async (args: any) => ({
        ...invoiceFixture(InvoiceStatus.PARTIAL),
        payments: filterPayments(PAYMENTS, args?.include?.payments?.where),
      }));
      prisma.invoice.update.mockResolvedValue({
        id: "inv-b102",
        invoiceNumber: "INV-2001",
        customerId: "c-b102",
        orderId: null,
        status: InvoiceStatus.PARTIAL,
        total: 500,
        dueDate: null,
      });
      mockEmailService.sendInvoice.mockClear();
      mockEmailService.isEmailConfigured.mockResolvedValue(true);
      mockEmailService.sendInvoice.mockResolvedValue({ delivered: true, transport: "resend" });
    });

    it("REG-B102: sendEmail passes totalPaid 300 / balanceDue 200 on a $500 invoice with a $100 DRAFT payment", async () => {
      await service.sendEmail("inv-b102");

      // Today: the payload carries `total` only — no totalPaid, no balanceDue — so
      // the email can only show "Amount Due $500.00". Red now.
      expect(mockEmailService.sendInvoice).toHaveBeenCalledWith(
        expect.objectContaining({
          total: 500,
          totalPaid: 300,
          balanceDue: 200,
          isReminder: false,
        }),
      );
    });

    it("REG-B102: sendReminder demands the CONFIRMED balance ($200), not the total and not the DRAFT-inflated $100", async () => {
      await service.sendReminder("inv-b102");

      expect(mockEmailService.sendInvoice).toHaveBeenCalledWith(
        expect.objectContaining({
          total: 500,
          totalPaid: 300,
          balanceDue: 200,
          isReminder: true,
        }),
      );
    });
  });

  // F03 (T-B103 / R9 / REG-B103) — the CALLER half of the promo/BOGO email display.
  // email.service.spec.ts hands `sendInvoice` the promo scalars directly, so a build
  // whose renderer is perfect but whose caller drops them still passes there while the
  // customer sees neither the "1 free" note nor the struck original price. These two
  // cases pin what invoices.service actually puts on the wire out of `inv.items`.
  describe("sendEmail / sendReminder pass the promo item scalars (T-B103 / R9 / REG-B103)", () => {
    // Mirrors email.service.spec.ts's BOGO fixture: qty 6 with 1 free at $10/unit
    // against a $12 pre-promo price — 10*(6-1) reconciles to the $50 stored subtotal.
    const BOGO_ITEM = {
      description: "Widget (BOGO)",
      qty: 6,
      unitPrice: 10,
      subtotal: 50,
      msrp: null,
      originalPrice: 12,
      priceType: "PROMO",
      promoFreeUnits: 1,
    };

    const expectedItem = () =>
      expect.objectContaining({
        description: "Widget (BOGO)",
        qty: 6,
        unitPrice: 10,
        subtotal: 50,
        originalPrice: 12,
        priceType: "PROMO",
        promoFreeUnits: 1,
      });

    beforeEach(() => {
      stubPaymentReads([]);
      prisma.invoice.findUnique.mockImplementation(async (args: any) => ({
        id: "inv-b103",
        orderId: null, // standalone → assertOrderInvoiceUnlocked skips the order check
        invoiceNumber: "INV-2002",
        status: InvoiceStatus.SENT,
        deliveryBatchId: null,
        total: 50,
        subtotal: 50,
        taxAmount: 0,
        discount: 0,
        shippingFee: 0,
        depositPercent: null,
        depositDueDate: null,
        paymentTermsLabel: null,
        issueDate: new Date("2026-01-01"),
        dueDate: new Date("2026-01-31"),
        customer: { id: "c-b103", businessName: "Acme Buyer", email: "buyer@example.com" },
        items: [BOGO_ITEM],
        payments: filterPayments([], args?.include?.payments?.where),
      }));
      prisma.invoice.update.mockResolvedValue({
        id: "inv-b103",
        invoiceNumber: "INV-2002",
        customerId: "c-b103",
        orderId: null,
        status: InvoiceStatus.SENT,
        total: 50,
        dueDate: null,
      });
      mockEmailService.sendInvoice.mockClear();
      mockEmailService.isEmailConfigured.mockResolvedValue(true);
      mockEmailService.sendInvoice.mockResolvedValue({ delivered: true, transport: "resend" });
      // mockSystemConfig is a shared jest.fn() across the whole spec file (never
      // re-created) — pin the tenant answer explicitly so these cases don't inherit
      // another describe's `invoice.hideOriginalPrice` value.
      mockSystemConfig.get.mockResolvedValue(null);
    });

    it("REG-B103: sendEmail forwards originalPrice / priceType / promoFreeUnits on the item row", async () => {
      await service.sendEmail("inv-b103");

      expect(mockEmailService.sendInvoice).toHaveBeenCalledWith(
        expect.objectContaining({ items: [expectedItem()], isReminder: false }),
      );
    });

    it("REG-B103: sendReminder forwards them too — the reminder shows the same line", async () => {
      await service.sendReminder("inv-b103");

      expect(mockEmailService.sendInvoice).toHaveBeenCalledWith(
        expect.objectContaining({ items: [expectedItem()], isReminder: true }),
      );
    });

    // Forwarding originalPrice is only safe while the tenant's hide-original-price
    // setting rides along: the PDF attached to this very send and the web detail page
    // both honour it, so an ungated email body would be the ONE surface leaking the
    // struck pre-promo price a tenant configured away.
    it("REG-B103: sendEmail carries the tenant's hideOriginalPrice through to the email", async () => {
      mockSystemConfig.get.mockImplementation(async (key: string) =>
        key === "invoice.hideOriginalPrice" ? "true" : null,
      );

      await service.sendEmail("inv-b103");

      expect(mockEmailService.sendInvoice).toHaveBeenCalledWith(
        expect.objectContaining({ hideOriginalPrice: true, isReminder: false }),
      );
    });

    it("REG-B103: sendReminder carries it too, and both default to false when unset", async () => {
      mockSystemConfig.get.mockImplementation(async (key: string) =>
        key === "invoice.hideOriginalPrice" ? "true" : null,
      );
      await service.sendReminder("inv-b103");
      expect(mockEmailService.sendInvoice).toHaveBeenCalledWith(
        expect.objectContaining({ hideOriginalPrice: true, isReminder: true }),
      );

      // Unset (the default tenant) still shows the strike — the gate must not
      // silently suppress promo transparency for everyone.
      mockSystemConfig.get.mockResolvedValue(null);
      mockEmailService.sendInvoice.mockClear();
      await service.sendReminder("inv-b103");
      expect(mockEmailService.sendInvoice).toHaveBeenCalledWith(
        expect.objectContaining({ hideOriginalPrice: false }),
      );
    });
  });

  // ─── WP2: payment-terms model — durable label + customer defaults + deposit ─

  describe("WP2 — payment terms model", () => {
    describe("create() — paymentTermsLabel + deposit fields", () => {
      it("persists paymentTermsLabel, depositPercent, and depositDueDate verbatim", async () => {
        prisma.customer.findUnique.mockResolvedValue({ id: "cust-1", isTaxExempt: false });
        prisma.invoice.create.mockImplementation((args: any) =>
          Promise.resolve({ ...args.data, id: "inv-new", items: [], payments: [], customer: {} }),
        );

        await service.create({
          customerId: "cust-1",
          items: [{ description: "Widget", qty: 1, unitPrice: 100 }],
          paymentTermsLabel: "Net 45",
          depositPercent: 50,
          depositDueDate: "2026-09-01",
        } as any);

        const data = (prisma.invoice.create.mock.calls[0][0] as any).data;
        expect(data.paymentTermsLabel).toBe("Net 45");
        expect(Number(data.depositPercent)).toBe(50);
        expect(data.depositDueDate).toEqual(new Date("2026-09-01"));
      });

      it("defaults paymentTermsLabel/deposit fields to null when omitted", async () => {
        prisma.customer.findUnique.mockResolvedValue({ id: "cust-1", isTaxExempt: false });
        prisma.invoice.findFirst.mockResolvedValue(null);
        prisma.invoice.create.mockImplementation((args: any) =>
          Promise.resolve({ ...args.data, id: "inv-new2", items: [], payments: [], customer: {} }),
        );

        await service.create({
          customerId: "cust-1",
          items: [{ description: "Widget", qty: 1, unitPrice: 100 }],
        } as any);

        const data = (prisma.invoice.create.mock.calls[0][0] as any).data;
        expect(data.paymentTermsLabel).toBeNull();
        expect(data.depositPercent).toBeNull();
        expect(data.depositDueDate).toBeNull();
      });
    });

    describe("resolveDefaultTerms(customerId) — customer default beats tenant default", () => {
      it("uses the customer's defaultPaymentTerms when set, ignoring the tenant SystemConfig", async () => {
        prisma.customer.findFirst.mockResolvedValue({ defaultPaymentTerms: "Net 60" });
        mockSystemConfig.get.mockResolvedValue("Net 30"); // tenant default — must be beaten
        // mockSystemConfig is a shared jest.fn() across the whole spec file (never
        // reset between tests), so clear ITS call history right before the act —
        // otherwise the assertions below inherit calls from unrelated earlier tests.
        mockSystemConfig.get.mockClear();

        const result = await service.resolveDefaultTerms("cust-1");

        expect(result).toEqual({
          terms: "Net 60",
          dueDays: 60,
          customerDepositPercent: null,
          effectiveDepositPercent: null,
        });
        // The customer's terms override short-circuits the TERMS tenant lookup — but
        // WP-D1's deposit resolution always reads the tenant deposit default
        // regardless (a customer with no deposit override still needs to know
        // whether one applies), so exactly one call happens, and it's for the
        // deposit key, never "invoice.defaultTerms". "Net 30" isn't numeric, so it
        // resolves to no tenant deposit (effectiveDepositPercent stays null above).
        expect(mockSystemConfig.get).toHaveBeenCalledTimes(1);
        expect(mockSystemConfig.get).toHaveBeenCalledWith("invoice.depositDefaultPercent");
      });

      it("falls back to the tenant default when the customer has no override", async () => {
        prisma.customer.findFirst.mockResolvedValue({ defaultPaymentTerms: null });
        mockSystemConfig.get.mockResolvedValue("Net 45");

        const result = await service.resolveDefaultTerms("cust-1");

        expect(result).toEqual({
          terms: "Net 45",
          dueDays: 45,
          customerDepositPercent: null,
          effectiveDepositPercent: null, // "Net 45" isn't numeric -> no tenant deposit
        });
      });

      it("keeps the existing tenant-only behavior when called with no customerId", async () => {
        mockSystemConfig.get.mockResolvedValue(null);

        const result = await service.resolveDefaultTerms();

        expect(result).toEqual({
          terms: "Net 30",
          dueDays: 30,
          customerDepositPercent: null,
          effectiveDepositPercent: null,
        });
        expect(prisma.customer.findFirst).not.toHaveBeenCalled();
      });

      it("carries the customer's defaultDepositPercent off the SAME row (no extra query)", async () => {
        prisma.customer.findFirst.mockResolvedValue({
          defaultPaymentTerms: "Net 60",
          defaultDepositPercent: 50,
        });
        prisma.customer.findFirst.mockClear();
        mockSystemConfig.get.mockResolvedValue(null); // no tenant default — customer's 50 wins anyway

        const result = await service.resolveDefaultTerms("cust-1");

        expect(result).toEqual({
          terms: "Net 60",
          dueDays: 60,
          customerDepositPercent: 50,
          effectiveDepositPercent: 50,
        });
        expect(prisma.customer.findFirst).toHaveBeenCalledTimes(1);
      });

      it("effective-deposit resolution matrix: customer 0 is an explicit opt-out even when the tenant default is set", async () => {
        prisma.customer.findFirst.mockResolvedValue({
          defaultPaymentTerms: null,
          defaultDepositPercent: 0,
        });
        mockSystemConfig.get.mockResolvedValue("30");

        const result = await service.resolveDefaultTerms("cust-1");

        expect(result.customerDepositPercent).toBe(0);
        expect(result.effectiveDepositPercent).toBeNull();
      });

      it("effective-deposit resolution matrix: customer null + tenant 30 -> 30 (inherits the tenant default)", async () => {
        prisma.customer.findFirst.mockResolvedValue({
          defaultPaymentTerms: null,
          defaultDepositPercent: null,
        });
        mockSystemConfig.get.mockResolvedValue("30");

        const result = await service.resolveDefaultTerms("cust-1");

        expect(result.customerDepositPercent).toBeNull();
        expect(result.effectiveDepositPercent).toBe(30);
      });

      it("effective-deposit resolution matrix: customer null + tenant unset -> none", async () => {
        prisma.customer.findFirst.mockResolvedValue({
          defaultPaymentTerms: null,
          defaultDepositPercent: null,
        });
        mockSystemConfig.get.mockResolvedValue(null);

        const result = await service.resolveDefaultTerms("cust-1");

        expect(result.effectiveDepositPercent).toBeNull();
      });
    });

    describe("createInvoiceFromOrder / createSale — label always matches the derived dueDate", () => {
      const orderWith = (over: any = {}) => ({
        id: "ord-terms",
        customerId: "cust-1",
        orderNumber: "ORD-T1",
        subtotal: 20,
        tax: 0,
        lineItems: [
          {
            id: "li-1",
            productId: "p1",
            name: null,
            qty: 2,
            invoicedQty: 0,
            unitPrice: 10,
            originalPrice: null,
            priceType: "STANDARD",
            product: { name: "Widget", unitsPerBox: 0 },
          },
        ],
        ...over,
      });

      it("labels an order-generated invoice with the resolved default term when no override is given", async () => {
        jest
          .spyOn(service as any, "resolveTenantInvoiceDefaults")
          .mockResolvedValue({ notes: null, terms: null, timezone: null });
        jest.spyOn(service as any, "generateInvoiceNumber").mockResolvedValue("INV-T1");
        // Customer override resolves the default term to "Net 45" (45 days). Both
        // the isTaxExempt read (createInvoiceFromOrder) and the defaultPaymentTerms
        // read (resolveDefaultTerms) hit the same converted customer.findFirst mock.
        prisma.customer.findFirst.mockResolvedValue({ defaultPaymentTerms: "Net 45" });
        prisma.order.findUnique.mockResolvedValue(orderWith());
        prisma.invoice.create.mockImplementation((args: any) =>
          Promise.resolve({ ...args.data, items: [], payments: [], customer: {} }),
        );

        await service.createInvoiceFromOrder("ord-terms");

        const data = (prisma.invoice.create.mock.calls[0][0] as any).data;
        // INVARIANT: the label equals exactly the string that drove the dueDate math.
        expect(data.paymentTermsLabel).toBe("Net 45");
        const days = Math.round(
          (new Date(data.dueDate).getTime() - new Date(data.issueDate).getTime()) / 86_400_000,
        );
        expect(days).toBe(45);
      });

      it("labels an order-generated invoice with the New-Sale operator's chosen term (createSale override)", async () => {
        jest
          .spyOn(service as any, "resolveTenantInvoiceDefaults")
          .mockResolvedValue({ notes: null, terms: null, timezone: null });
        jest.spyOn(service as any, "generateInvoiceNumber").mockResolvedValue("INV-T2");
        prisma.customer.findFirst.mockResolvedValue({ defaultPaymentTerms: null });
        mockSystemConfig.get.mockResolvedValue(null); // tenant default -> "Net 30", unused here
        prisma.order.findUnique.mockResolvedValue(orderWith());
        prisma.invoice.create.mockImplementation((args: any) =>
          Promise.resolve({ ...args.data, items: [], payments: [], customer: {} }),
        );

        // Mirrors what orders.service.createSale threads through from CreateSaleDto.
        await service.createInvoiceFromOrder("ord-terms", undefined, {
          dueDate: "2026-10-03",
          paymentTermsLabel: "Net 60",
        });

        const data = (prisma.invoice.create.mock.calls[0][0] as any).data;
        expect(data.paymentTermsLabel).toBe("Net 60");
        expect(data.dueDate).toEqual(new Date("2026-10-03T00:00:00.000Z"));
      });

      it("leaves the label null when a dueDate is supplied WITHOUT one (no term drove that date)", async () => {
        jest
          .spyOn(service as any, "resolveTenantInvoiceDefaults")
          .mockResolvedValue({ notes: null, terms: null, timezone: null });
        jest.spyOn(service as any, "generateInvoiceNumber").mockResolvedValue("INV-T3");
        // Resolved default is "Net 45" — it must NOT be stamped on a hand-typed date.
        prisma.customer.findFirst.mockResolvedValue({ defaultPaymentTerms: "Net 45" });
        prisma.order.findUnique.mockResolvedValue(orderWith());
        prisma.invoice.create.mockImplementation((args: any) =>
          Promise.resolve({ ...args.data, items: [], payments: [], customer: {} }),
        );

        // Operator hand-typed a Due Date and never touched the Terms dropdown.
        await service.createInvoiceFromOrder("ord-terms", undefined, { dueDate: "2026-10-03" });

        const data = (prisma.invoice.create.mock.calls[0][0] as any).data;
        expect(data.paymentTermsLabel).toBeNull();
        expect(data.dueDate).toEqual(new Date("2026-10-03T00:00:00.000Z"));
      });
    });

    // WP2: per-customer deposit default ("50% upfront, remainder on terms")
    // auto-applies to invoices generated from orders.
    describe("createInvoiceFromOrder* / createPartialFromOrder — deposit default auto-apply", () => {
      const orderWith = (over: any = {}) => ({
        id: "ord-terms",
        customerId: "cust-1",
        orderNumber: "ORD-T1",
        subtotal: 20,
        tax: 0,
        lineItems: [
          {
            id: "li-1",
            productId: "p1",
            name: null,
            qty: 2,
            invoicedQty: 0,
            unitPrice: 10,
            originalPrice: null,
            priceType: "STANDARD",
            product: { name: "Widget", unitsPerBox: 0 },
          },
        ],
        ...over,
      });

      beforeEach(() => {
        jest
          .spyOn(service as any, "resolveTenantInvoiceDefaults")
          .mockResolvedValue({ notes: null, terms: null, timezone: null });
        jest.spyOn(service as any, "generateInvoiceNumber").mockResolvedValue("INV-DEP");
        prisma.invoice.create.mockImplementation((args: any) =>
          Promise.resolve({ ...args.data, items: [], payments: [], customer: {} }),
        );
        // mockSystemConfig is a shared jest.fn() across the whole spec file (never
        // reset between tests) — WP-D1's resolveDefaultTerms now ALWAYS reads
        // "invoice.depositDefaultPercent" too, so pin it to "no tenant default" here.
        // Each test below is about the CUSTOMER's own default; tests that also want a
        // tenant default set it explicitly.
        mockSystemConfig.get.mockResolvedValue(null);
      });

      it("(a) createInvoiceFromOrder: customer default 50 + Net 60 -> depositPercent 50, depositDueDate = issueDate, dueDate +60d", async () => {
        prisma.customer.findFirst.mockResolvedValue({
          isTaxExempt: false,
          defaultPaymentTerms: "Net 60",
          defaultDepositPercent: 50,
        });
        prisma.order.findUnique.mockResolvedValue(orderWith());

        await service.createInvoiceFromOrder("ord-terms");

        const data = (prisma.invoice.create.mock.calls[0][0] as any).data;
        expect(data.depositPercent).toBe(50);
        expect(data.depositDueDate).toEqual(data.issueDate);
        expect(data.paymentTermsLabel).toBe("Net 60");
        const days = Math.round(
          (new Date(data.dueDate).getTime() - new Date(data.issueDate).getTime()) / 86_400_000,
        );
        expect(days).toBe(60);
      });

      it("(b) createInvoiceFromOrder: customer WITHOUT a deposit default omits depositPercent/depositDueDate entirely (byte-identical guard)", async () => {
        prisma.customer.findFirst.mockResolvedValue({
          isTaxExempt: false,
          defaultPaymentTerms: null,
          defaultDepositPercent: null,
        });
        prisma.order.findUnique.mockResolvedValue(orderWith());

        await service.createInvoiceFromOrder("ord-terms");

        const data = (prisma.invoice.create.mock.calls[0][0] as any).data;
        expect("depositPercent" in data).toBe(false);
        expect("depositDueDate" in data).toBe(false);
      });

      it("(b') a defaultDepositPercent of 0 does not auto-apply (must be > 0)", async () => {
        prisma.customer.findFirst.mockResolvedValue({
          isTaxExempt: false,
          defaultPaymentTerms: "Net 30",
          defaultDepositPercent: 0,
        });
        prisma.order.findUnique.mockResolvedValue(orderWith());

        await service.createInvoiceFromOrder("ord-terms");

        const data = (prisma.invoice.create.mock.calls[0][0] as any).data;
        expect("depositPercent" in data).toBe(false);
        expect("depositDueDate" in data).toBe(false);
      });

      it("(c) createInvoiceFromOrder: an explicit deposit override wins over the customer default (explicit ≠ overwritten)", async () => {
        prisma.customer.findFirst.mockResolvedValue({
          isTaxExempt: false,
          defaultPaymentTerms: "Net 60",
          defaultDepositPercent: 50,
        });
        prisma.order.findUnique.mockResolvedValue(orderWith());

        await service.createInvoiceFromOrder("ord-terms", undefined, {
          depositPercent: 25,
          depositDueDate: "2026-09-01",
        });

        const data = (prisma.invoice.create.mock.calls[0][0] as any).data;
        expect(data.depositPercent).toBe(25);
        expect(data.depositDueDate).toEqual(new Date("2026-09-01T00:00:00.000Z"));
      });

      it("createInvoiceFromOrderWithTenant: applies the customer's deposit default off the same select (no extra query)", async () => {
        prisma.systemConfig.findFirst.mockResolvedValue(null);
        prisma.tenantConfig.findUnique.mockResolvedValue(null);
        prisma.order.findFirst.mockResolvedValue(orderWith());
        prisma.customer.findFirst.mockResolvedValue({
          isTaxExempt: false,
          defaultPaymentTerms: "Net 45",
          defaultDepositPercent: 20,
        });

        await service.createInvoiceFromOrderWithTenant("ord-terms", "test-tenant");

        const data = (prisma.invoice.create.mock.calls[0][0] as any).data;
        expect(data.depositPercent).toBe(20);
        expect(data.depositDueDate).toEqual(data.issueDate);
        expect(prisma.customer.findFirst).toHaveBeenCalledTimes(1);
      });

      it("createInvoiceFromOrderWithTenant: customer without a default omits the deposit keys entirely", async () => {
        prisma.systemConfig.findFirst.mockResolvedValue(null);
        prisma.tenantConfig.findUnique.mockResolvedValue(null);
        prisma.order.findFirst.mockResolvedValue(orderWith());
        prisma.customer.findFirst.mockResolvedValue({
          isTaxExempt: false,
          defaultPaymentTerms: null,
          defaultDepositPercent: null,
        });

        await service.createInvoiceFromOrderWithTenant("ord-terms", "test-tenant");

        const data = (prisma.invoice.create.mock.calls[0][0] as any).data;
        expect("depositPercent" in data).toBe(false);
        expect("depositDueDate" in data).toBe(false);
      });

      it("createPartialFromOrder: applies the customer's deposit default to a split invoice", async () => {
        prisma.customer.findFirst.mockResolvedValue({
          isTaxExempt: false,
          defaultPaymentTerms: "Net 60",
          defaultDepositPercent: 50,
        });
        prisma.order.findUnique.mockResolvedValue(orderWith());

        const invoice = (await service.createPartialFromOrder("ord-terms", {
          items: [{ orderItemId: "li-1", qty: 2 }],
        } as any)) as any;

        expect(invoice.depositPercent).toBe(50);
        expect(invoice.depositDueDate).toEqual(invoice.issueDate);
      });

      it("createPartialFromOrder: customer WITHOUT a default omits the deposit keys entirely (byte-identical guard)", async () => {
        prisma.customer.findFirst.mockResolvedValue({
          isTaxExempt: false,
          defaultPaymentTerms: null,
          defaultDepositPercent: null,
        });
        prisma.order.findUnique.mockResolvedValue(orderWith());

        await service.createPartialFromOrder("ord-terms", {
          items: [{ orderItemId: "li-1", qty: 2 }],
        } as any);

        const data = (prisma.invoice.create.mock.calls[0][0] as any).data;
        expect("depositPercent" in data).toBe(false);
        expect("depositDueDate" in data).toBe(false);
      });

      it("createPartialFromOrder: an explicit dto deposit wins over the customer default", async () => {
        prisma.customer.findFirst.mockResolvedValue({
          isTaxExempt: false,
          defaultPaymentTerms: "Net 60",
          defaultDepositPercent: 50,
        });
        prisma.order.findUnique.mockResolvedValue(orderWith());

        const invoice = (await service.createPartialFromOrder("ord-terms", {
          items: [{ orderItemId: "li-1", qty: 2 }],
          depositPercent: 10,
          depositDueDate: "2026-09-05",
        } as any)) as any;

        expect(invoice.depositPercent).toBe(10);
        expect(invoice.depositDueDate).toEqual(new Date("2026-09-05T00:00:00.000Z"));
      });
    });

    // WP-D1: tenant deposit policy — effectiveDepositPercent (tenant default, since
    // these customers carry no override of their own) drives createInvoiceFromOrder's
    // deposit fields, and invoice.depositCollectAtOrder gates whether the mirror is
    // issued (SENT, no email) right at creation.
    describe("createInvoiceFromOrder — deposit-collect-at-order issuance", () => {
      const orderWith = (over: any = {}) => ({
        id: "ord-issue",
        customerId: "cust-1",
        orderNumber: "ORD-ISSUE",
        subtotal: 100,
        tax: 0,
        status: "PENDING",
        lineItems: [
          {
            id: "li-1",
            productId: "p1",
            name: null,
            qty: 2,
            invoicedQty: 0,
            unitPrice: 50,
            originalPrice: null,
            priceType: "STANDARD",
            product: { name: "Widget", unitsPerBox: 0 },
          },
        ],
        ...over,
      });

      let row: any;

      beforeEach(() => {
        jest
          .spyOn(service as any, "resolveTenantInvoiceDefaults")
          .mockResolvedValue({ notes: null, terms: null, timezone: null });
        jest.spyOn(service as any, "generateInvoiceNumber").mockResolvedValue("INV-ISSUE");
        prisma.customer.findFirst.mockResolvedValue({
          isTaxExempt: false,
          defaultPaymentTerms: null,
          defaultDepositPercent: null,
        });
        row = undefined;
        prisma.invoice.create.mockImplementation((args: any) => {
          row = { id: "inv-issue-1", ...args.data, items: [], payments: [], customer: {} };
          return Promise.resolve(row);
        });
        // send()'s findOneOrThrow + its own mid-flight re-fetches all read through
        // this same mutable `row` reference.
        prisma.invoice.findUnique.mockImplementation(() => Promise.resolve(row));
        prisma.invoice.update.mockImplementation((args: any) => {
          row = { ...row, ...args.data };
          return Promise.resolve(row);
        });
      });

      it("effective tenant deposit + collectAtOrder=true + non-delivered order -> mirror issued SENT at create, no email", async () => {
        mockSystemConfig.get.mockImplementation((key: string) => {
          if (key === "invoice.depositDefaultPercent") return Promise.resolve("30");
          if (key === "invoice.depositCollectAtOrder") return Promise.resolve("true");
          return Promise.resolve(null);
        });
        prisma.order.findUnique.mockResolvedValue(orderWith());
        // mockEmailService is a shared jest.fn() across the whole spec file (never
        // reset between tests) — clear its call history right before the act so the
        // "no email" assertion below isn't inherited from an unrelated earlier test.
        mockEmailService.sendInvoice.mockClear();

        const result = (await service.createInvoiceFromOrder("ord-issue")) as any[];

        expect(result).toHaveLength(1);
        expect(result[0].depositPercent).toBe(30);
        expect(result[0].status).toBe(InvoiceStatus.SENT);
        expect(mockEmailService.sendInvoice).not.toHaveBeenCalled();
        // send() never checks the order-delivered gate for this call — the invoice
        // update actually happened (proves send() ran, not just a passthrough).
        expect(prisma.invoice.update).toHaveBeenCalled();
      });

      it("collectAtOrder unset (default) leaves the mirror DRAFT even with an effective deposit — byte-identical", async () => {
        mockSystemConfig.get.mockImplementation((key: string) =>
          key === "invoice.depositDefaultPercent" ? Promise.resolve("30") : Promise.resolve(null),
        );
        prisma.order.findUnique.mockResolvedValue(orderWith());

        const result = (await service.createInvoiceFromOrder("ord-issue")) as any[];

        expect(result[0].depositPercent).toBe(30);
        expect(result[0].status).toBe(InvoiceStatus.DRAFT);
        expect(prisma.invoice.update).not.toHaveBeenCalled();
      });

      it("does not issue when the order is already DELIVERED (the van-sale flow issues via its own explicit send())", async () => {
        mockSystemConfig.get.mockImplementation((key: string) => {
          if (key === "invoice.depositDefaultPercent") return Promise.resolve("30");
          if (key === "invoice.depositCollectAtOrder") return Promise.resolve("true");
          return Promise.resolve(null);
        });
        prisma.order.findUnique.mockResolvedValue(orderWith({ status: "DELIVERED" }));

        const result = (await service.createInvoiceFromOrder("ord-issue")) as any[];

        expect(result[0].status).toBe(InvoiceStatus.DRAFT);
        expect(prisma.invoice.update).not.toHaveBeenCalled();
      });

      // S1: only open DRAFTs get sibling-aware rebuilds, so a regulated
      // SEPARATE_INVOICE split (base + -R#) deliberately keeps DRAFT mirrors.
      it("does NOT issue a split order's siblings — base + -R# stay DRAFT (deliberate limitation)", async () => {
        mockSystemConfig.get.mockImplementation((key: string) => {
          if (key === "invoice.depositDefaultPercent") return Promise.resolve("30");
          if (key === "invoice.depositCollectAtOrder") return Promise.resolve("true");
          return Promise.resolve(null);
        });
        prisma.order.findUnique.mockResolvedValue(orderWith());
        jest.spyOn(service as any, "createSplitInvoices").mockResolvedValue([
          { id: "inv-base", status: InvoiceStatus.DRAFT },
          { id: "inv-r1", status: InvoiceStatus.DRAFT },
        ]);

        const result = (await service.createInvoiceFromOrder("ord-issue")) as any[];

        expect(result.map((i) => i.status)).toEqual([InvoiceStatus.DRAFT, InvoiceStatus.DRAFT]);
        expect(prisma.invoice.update).not.toHaveBeenCalled();
      });

      // S6: send() runs on its own connection/transaction, so it can't see rows a
      // caller's still-open transaction just created.
      it("does NOT issue when running inside a caller's transaction (cross-connection hazard)", async () => {
        mockSystemConfig.get.mockImplementation((key: string) => {
          if (key === "invoice.depositDefaultPercent") return Promise.resolve("30");
          if (key === "invoice.depositCollectAtOrder") return Promise.resolve("true");
          return Promise.resolve(null);
        });
        prisma.order.findUnique.mockResolvedValue(orderWith());

        const result = (await service.createInvoiceFromOrder("ord-issue", prisma as any)) as any[];

        expect(result[0].depositPercent).toBe(30); // the deposit still applies…
        expect(result[0].status).toBe(InvoiceStatus.DRAFT); // …but it is not issued here
        expect(prisma.invoice.update).not.toHaveBeenCalled();
      });

      it("no effective deposit at all -> never issues, regardless of the collectAtOrder flag", async () => {
        mockSystemConfig.get.mockImplementation((key: string) =>
          key === "invoice.depositCollectAtOrder" ? Promise.resolve("true") : Promise.resolve(null),
        );
        prisma.order.findUnique.mockResolvedValue(orderWith());

        const result = (await service.createInvoiceFromOrder("ord-issue")) as any[];

        expect("depositPercent" in result[0]).toBe(false);
        expect(result[0].status).toBe(InvoiceStatus.DRAFT);
        expect(prisma.invoice.update).not.toHaveBeenCalled();
      });

      // The fire-and-forget path is REGULAR order placement (buyer portal + operator
      // create) — the mainline case. It has no request context, so it resolves the
      // tenant policy off SystemConfig by tenantId and flips the mirror inline.
      describe("createInvoiceFromOrderWithTenant (regular order placement)", () => {
        const armTenantConfig = (values: Record<string, string>) => {
          prisma.tenantConfig.findUnique.mockResolvedValue(null);
          prisma.systemConfig.findFirst.mockImplementation((args: any) =>
            Promise.resolve(
              values[args?.where?.key] != null ? { value: values[args.where.key] } : null,
            ),
          );
        };

        it("inherits the tenant deposit percent (customer has none) and issues the mirror SENT + payable, no email", async () => {
          prisma.order.findFirst.mockResolvedValue(orderWith());
          armTenantConfig({
            "invoice.depositDefaultPercent": "30",
            "invoice.depositCollectAtOrder": "true",
          });
          mockEmailService.sendInvoice.mockClear();

          const result = (await service.createInvoiceFromOrderWithTenant(
            "ord-issue",
            "test-tenant",
          )) as any[];

          const data = (prisma.invoice.create.mock.calls[0][0] as any).data;
          expect(data.depositPercent).toBe(30);
          expect(result).toHaveLength(1);
          // SENT + sentAt is everything payability needs (canRecordPayment is
          // status-driven), and nothing was emailed.
          expect(result[0].status).toBe(InvoiceStatus.SENT);
          expect(result[0].sentAt).toBeInstanceOf(Date);
          expect(mockEmailService.sendInvoice).not.toHaveBeenCalled();
        });

        it("leaves the mirror DRAFT when collect-at-order is off (percent still applies)", async () => {
          prisma.order.findFirst.mockResolvedValue(orderWith());
          armTenantConfig({ "invoice.depositDefaultPercent": "30" });

          const result = (await service.createInvoiceFromOrderWithTenant(
            "ord-issue",
            "test-tenant",
          )) as any[];

          expect((prisma.invoice.create.mock.calls[0][0] as any).data.depositPercent).toBe(30);
          expect(result[0].status).toBe(InvoiceStatus.DRAFT);
          expect(prisma.invoice.update).not.toHaveBeenCalled();
        });

        it("a customer deposit of 0 opts out even when the tenant default is set", async () => {
          prisma.order.findFirst.mockResolvedValue(orderWith());
          prisma.customer.findFirst.mockResolvedValue({
            isTaxExempt: false,
            defaultPaymentTerms: null,
            defaultDepositPercent: 0,
          });
          armTenantConfig({
            "invoice.depositDefaultPercent": "30",
            "invoice.depositCollectAtOrder": "true",
          });

          const result = (await service.createInvoiceFromOrderWithTenant(
            "ord-issue",
            "test-tenant",
          )) as any[];

          const data = (prisma.invoice.create.mock.calls[0][0] as any).data;
          expect("depositPercent" in data).toBe(false);
          expect(result[0].status).toBe(InvoiceStatus.DRAFT);
        });

        // REG-B100 pin (harness note 4, cause-ruling.md §2 D2): this fire-and-forget
        // path has no AsyncLocalStorage request context, so it must pass its
        // explicit tenantId straight through to NumberingService rather than
        // relying on prisma.getTenantId(). TODAY generateInvoiceNumber never calls
        // numbering.reserveNext at all, so this fails on "was not called".
        it("REG-B100 pin: passes the explicit tenantId to numbering with no request context", async () => {
          // This describe's beforeEach stubs generateInvoiceNumber wholesale (the
          // deposit-issuance tests don't care what it mints); restore the real one
          // so the mint actually reaches NumberingService and the tenantId claim
          // is exercised end-to-end.
          ((service as any).generateInvoiceNumber as jest.SpyInstance).mockRestore();
          prisma.order.findFirst.mockResolvedValue(orderWith());
          armTenantConfig({});

          await service.createInvoiceFromOrderWithTenant("ord-issue", "qa-fire-and-forget-tenant");

          expect(mockNumbering.reserveNext).toHaveBeenCalledWith(
            "INVOICE",
            expect.objectContaining({ tenantId: "qa-fire-and-forget-tenant" }),
          );
        });
      });
    });

    describe("findOne/findAll — derived depositAmount/depositOverdue", () => {
      it("rounds the deposit amount to the cent (50% of a non-round total)", async () => {
        prisma.invoice.findUnique.mockResolvedValue({
          id: "inv-dep-1",
          status: InvoiceStatus.SENT,
          total: 1234.5678,
          dueDate: null,
          depositPercent: 50,
          depositDueDate: null,
          payments: [],
          items: [],
        });

        const res = await service.findOne("inv-dep-1");

        // 1234.5678 * 50% = 617.2839 -> rounds to the cent via roundMoney.
        expect((res as any).depositAmount).toBeCloseTo(617.28, 2);
      });

      it("flags depositOverdue only when the deposit due date has passed and it isn't covered yet", async () => {
        const yesterday = new Date(Date.now() - 86_400_000).toISOString();
        prisma.invoice.findUnique.mockResolvedValue({
          id: "inv-dep-2",
          status: InvoiceStatus.SENT,
          total: 1000,
          dueDate: null,
          depositPercent: 20, // deposit = $200
          depositDueDate: yesterday,
          payments: [],
          items: [],
        });

        const overdue = await service.findOne("inv-dep-2");
        expect((overdue as any).depositAmount).toBe(200);
        expect((overdue as any).depositOverdue).toBe(true);

        // A payment covering the deposit clears the flag even though the invoice
        // as a whole is still open.
        prisma.invoice.findUnique.mockResolvedValue({
          id: "inv-dep-3",
          status: InvoiceStatus.PARTIAL,
          total: 1000,
          dueDate: null,
          depositPercent: 20,
          depositDueDate: yesterday,
          payments: [{ status: "PAID", amount: 200 }],
          items: [],
        });
        const covered = await service.findOne("inv-dep-3");
        expect((covered as any).depositOverdue).toBe(false);
      });

      it("returns depositAmount null and depositOverdue false when no deposit is configured", async () => {
        prisma.invoice.findUnique.mockResolvedValue({
          id: "inv-no-dep",
          status: InvoiceStatus.SENT,
          total: 500,
          dueDate: null,
          depositPercent: null,
          depositDueDate: null,
          payments: [],
          items: [],
        });

        const res = await service.findOne("inv-no-dep");
        expect((res as any).depositAmount).toBeNull();
        expect((res as any).depositOverdue).toBe(false);
      });
    });

    // ─── WP3 note (item 6 of this package): updateTerms ────────────────────
    describe("updateTerms — narrow post-issue correction", () => {
      it("rejects a VOID invoice", async () => {
        prisma.invoice.findUnique.mockResolvedValue({
          id: "inv-void",
          status: InvoiceStatus.VOID,
          total: 100,
          dueDate: null,
          internalNotes: null,
          payments: [],
        });

        await expect(
          service.updateTerms("inv-void", { paymentTermsLabel: "Net 45" }),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(prisma.invoice.update).not.toHaveBeenCalled();
      });

      it("rejects a WRITTEN_OFF invoice", async () => {
        prisma.invoice.findUnique.mockResolvedValue({
          id: "inv-wo",
          status: InvoiceStatus.WRITTEN_OFF,
          total: 100,
          dueDate: null,
          internalNotes: null,
          payments: [],
        });

        await expect(
          service.updateTerms("inv-wo", { paymentTermsLabel: "Net 45" }),
        ).rejects.toBeInstanceOf(BadRequestException);
      });

      it("a PAID invoice accepts a label fix and stays PAID", async () => {
        prisma.invoice.findUnique.mockResolvedValue({
          id: "inv-paid",
          status: InvoiceStatus.PAID,
          total: 100,
          dueDate: new Date("2026-06-01"),
          internalNotes: null,
          payments: [{ status: "PAID", amount: 100 }],
        });
        prisma.invoice.update.mockResolvedValue({ id: "inv-paid", status: InvoiceStatus.PAID });

        await service.updateTerms("inv-paid", { paymentTermsLabel: "Net 45 (corrected)" });

        const data = (prisma.invoice.update.mock.calls[0][0] as any).data;
        expect(data.paymentTermsLabel).toBe("Net 45 (corrected)");
        expect(data.status).toBe(InvoiceStatus.PAID);
      });

      it("a dueDate edit flips OVERDUE back to SENT when the new date is in the future", async () => {
        prisma.invoice.findUnique.mockResolvedValue({
          id: "inv-over",
          status: InvoiceStatus.OVERDUE,
          total: 100,
          dueDate: new Date("2026-01-01"), // long past
          internalNotes: null,
          payments: [],
        });
        prisma.invoice.update.mockResolvedValue({ id: "inv-over", status: InvoiceStatus.SENT });

        const future = new Date(Date.now() + 30 * 86_400_000).toISOString();
        await service.updateTerms("inv-over", { dueDate: future });

        const data = (prisma.invoice.update.mock.calls[0][0] as any).data;
        expect(data.status).toBe(InvoiceStatus.SENT);
      });

      it("a dueDate edit flips SENT to OVERDUE when the new date is in the past", async () => {
        prisma.invoice.findUnique.mockResolvedValue({
          id: "inv-sent",
          status: InvoiceStatus.SENT,
          total: 100,
          dueDate: new Date(Date.now() + 30 * 86_400_000),
          internalNotes: null,
          payments: [],
        });
        prisma.invoice.update.mockResolvedValue({ id: "inv-sent", status: InvoiceStatus.OVERDUE });

        const past = new Date(Date.now() - 5 * 86_400_000).toISOString();
        await service.updateTerms("inv-sent", { dueDate: past });

        const data = (prisma.invoice.update.mock.calls[0][0] as any).data;
        expect(data.status).toBe(InvoiceStatus.OVERDUE);
      });

      it("appends an internalNotes breadcrumb noting the dueDate change", async () => {
        prisma.invoice.findUnique.mockResolvedValue({
          id: "inv-note",
          status: InvoiceStatus.SENT,
          total: 100,
          dueDate: new Date("2026-06-01T00:00:00.000Z"),
          internalNotes: "existing note",
          payments: [],
        });
        prisma.invoice.update.mockResolvedValue({ id: "inv-note" });

        await service.updateTerms("inv-note", { dueDate: "2026-07-01" });

        const data = (prisma.invoice.update.mock.calls[0][0] as any).data;
        expect(data.internalNotes).toContain("existing note");
        expect(data.internalNotes).toContain("Terms updated: 2026-06-01 → 2026-07-01");
      });

      it("a bare terms edit does NOT trigger the order back-sync (recomputeOrderFromInvoices)", async () => {
        const resyncSpy = jest
          .spyOn(service as any, "recomputeOrderFromInvoices")
          .mockResolvedValue(undefined);
        prisma.invoice.findUnique.mockResolvedValue({
          id: "inv-order-linked",
          orderId: "ord-1",
          status: InvoiceStatus.SENT,
          total: 100,
          dueDate: new Date("2026-06-01"),
          internalNotes: null,
          payments: [],
        });
        prisma.invoice.update.mockResolvedValue({ id: "inv-order-linked" });

        await service.updateTerms("inv-order-linked", { referenceNumber: "PO-42" });

        expect(resyncSpy).not.toHaveBeenCalled();
      });

      it('clears a mislabeled term / stale reference when the modal sends "" (never leaves it unchanged)', async () => {
        prisma.invoice.findUnique.mockResolvedValue({
          id: "inv-clear",
          status: InvoiceStatus.SENT,
          total: 100,
          dueDate: new Date("2026-06-01"),
          paymentTermsLabel: "Net 45",
          referenceNumber: "PO-42",
          internalNotes: null,
          payments: [],
        });
        prisma.invoice.update.mockResolvedValue({ id: "inv-clear" });

        await service.updateTerms("inv-clear", {
          paymentTermsLabel: "",
          referenceNumber: "",
          subject: "",
        });

        const data = (prisma.invoice.update.mock.calls[0][0] as any).data;
        expect(data.paymentTermsLabel).toBeNull();
        expect(data.referenceNumber).toBeNull();
        expect(data.subject).toBeNull();
      });
    });
  });

  // ─── T6 (REG-B12) — getKpiSummary(): the invoices page's six KPI tiles must
  // be computed by the DATABASE over the whole OPEN set, never the client's
  // `useInvoices({ limit: 999 })` fetch-all-then-reduce (which silently drops
  // whichever rows page 1000+ would have held — exactly the oldest, most
  // delinquent invoices). NOTE: this method does not exist yet — every one of
  // these calls throws a TypeError today (structural red).
  describe("REG-B12 — getKpiSummary()", () => {
    // The bar renders on `/invoices`, which BUYERS are allowed to open, so the
    // summary is role-aware: an OPERATOR sees the tenant's receivables, a
    // CUSTOMER only their own. Every case names the caller.
    const OPERATOR = { sub: "user-op", role: UserRole.OPERATOR };
    const BUYER = { sub: "user-buyer", role: UserRole.CUSTOMER };

    // Precedent: "REG-B78 (T14): OrdersService owns the helper at all — its
    // absence is an assertion, not a TypeError" (orders.update-items-guards.spec.ts).
    // Without this the behavioral `it` below dies on `service.getKpiSummary is
    // not a function` and none of its six figures is ever exercised at red time.
    it("InvoicesService owns getKpiSummary at all — its absence is an assertion, not a TypeError", () => {
      expect(typeof (service as unknown as Record<string, unknown>).getKpiSummary).toBe("function");
    });

    it("buckets the OPEN set by dueDate against the viewer's `today`, and threads through the count/avgDays reads", async () => {
      prisma.invoice.findMany.mockResolvedValue([
        // overdue: dueDate < today
        {
          id: "inv-overdue",
          total: 100,
          dueDate: new Date("2026-08-25T00:00:00.000Z"),
          payments: [],
        },
        // due today: dueDate === today
        { id: "inv-today", total: 50, dueDate: new Date("2026-08-26T00:00:00.000Z"), payments: [] },
        // due in 30: today < dueDate <= today+30d
        { id: "inv-30", total: 25, dueDate: new Date("2026-09-10T00:00:00.000Z"), payments: [] },
        // later: counts toward totalOutstanding only, no bucket
        { id: "inv-later", total: 10, dueDate: new Date("2026-10-30T00:00:00.000Z"), payments: [] },
        // CONFIRMED basis (F03): only the PAID row reduces the balance — the
        // DRAFT (unconfirmed) and VOID rows never do. 100 − 20 = 80 → overdue.
        {
          id: "inv-partial",
          total: 100,
          dueDate: new Date("2026-08-24T00:00:00.000Z"),
          payments: [
            { amount: 40, status: "DRAFT" },
            { amount: 30, status: "VOID" },
            { amount: 20, status: "PAID" },
          ],
        },
        // null dueDate: counts toward totalOutstanding, lands in NO bucket
        { id: "inv-no-due", total: 7, dueDate: null, payments: [] },
        // m5: status OVERDUE with a FUTURE dueDate → OVERDUE, never dueIn30.
        // The client memo's basis is a DISJUNCT (`status === "OVERDUE" || due <
        // today`), so an invoice the server already flipped to OVERDUE stays
        // overdue whatever its dueDate says.
        {
          id: "inv-status-overdue",
          total: 11,
          status: InvoiceStatus.OVERDUE,
          dueDate: new Date("2026-09-05T00:00:00.000Z"),
          payments: [],
        },
        // boundary: today+30 is INSIDE dueIn30 (inclusive)
        { id: "inv-day30", total: 13, dueDate: new Date("2026-09-25T00:00:00.000Z"), payments: [] },
        // boundary: today+31 is OUTSIDE every bucket
        { id: "inv-day31", total: 17, dueDate: new Date("2026-09-26T00:00:00.000Z"), payments: [] },
      ]);
      prisma.invoicePayment.count.mockResolvedValue(3);
      prisma.$queryRaw.mockResolvedValue([{ avgDays: 12.5 }]);

      const svc = service as unknown as {
        getKpiSummary?: (
          today: string,
          user: { sub: string; role: UserRole },
        ) => Promise<Record<string, number>>;
      };
      // Assert-then-call: the missing method reads as an assertion failure here
      // too, never a TypeError that skips every oracle below.
      expect(typeof svc.getKpiSummary).toBe("function");
      const result = await svc.getKpiSummary!("2026-08-26", OPERATOR);

      expect(result).toEqual({
        totalOutstanding: 313, // 100 + 50 + 25 + 10 + 80 + 7 + 11 + 13 + 17
        // 100 + 80 (the PARTIAL row's CONFIRMED-only balance) + 11 (m5: the
        // status-OVERDUE row, whose dueDate is in the future)
        overdue: 191,
        dueToday: 50,
        dueIn30: 38, // 25 + 13 (day 30) — the status-OVERDUE row is NOT here
        avgDays: 12.5,
        awaitingConfirmationCount: 3,
      });

      // No `take` — the OPEN set is read whole, not capped like a rendering page.
      const call = prisma.invoice.findMany.mock.calls[0][0];
      expect(call.take).toBeUndefined();
      // Restricted to the OPEN set: PAID/VOID/WRITTEN_OFF/DRAFT excluded (the
      // page.tsx memo's own exclusion list this replaces — B12 design §2).
      expect(new Set(call.where.status.notIn)).toEqual(
        new Set([
          InvoiceStatus.PAID,
          InvoiceStatus.VOID,
          InvoiceStatus.WRITTEN_OFF,
          InvoiceStatus.DRAFT,
        ]),
      );

      // The tenant id reaches the raw avgDays query as a bound parameter, not
      // string-interpolated into the query text.
      expect(prisma.$queryRaw.mock.calls[0]).toContain("test-tenant");

      // …and the POPULATION it averages is pinned: the pass-through oracle
      // above cannot tell a correctly-scoped average from one taken over the
      // wrong rows.
      const sql = (prisma.$queryRaw.mock.calls[0][0] as string[]).join("?");
      expect(sql).toContain("status = 'PAID'");
      expect(sql).toContain('"paidAt" IS NOT NULL');
      expect(sql).toContain('"sentAt" IS NOT NULL');
      expect(sql).toContain('"paidAt" >= "sentAt"');
    });

    // m5 — the `overdue` bucket's basis is the client memo's DISJUNCT, not a
    // date-only rule: an invoice the server has already flipped to OVERDUE
    // counts as overdue whatever its dueDate says. A date-only implementation
    // buckets the future-dated row into dueIn30 and drops the null-dated one
    // out of every bucket — both under-report the tile the operator collects
    // against.
    it("counts a status-OVERDUE invoice as overdue regardless of its dueDate (m5)", async () => {
      prisma.invoice.findMany.mockResolvedValue([
        // dueDate 10 days in the FUTURE — a date-only rule buckets this in dueIn30.
        {
          id: "inv-future-overdue",
          total: 40,
          status: InvoiceStatus.OVERDUE,
          dueDate: new Date("2026-09-05T00:00:00.000Z"),
          payments: [],
        },
        // no dueDate at all — a date-only rule drops this out of every bucket.
        {
          id: "inv-nodue-overdue",
          total: 60,
          status: InvoiceStatus.OVERDUE,
          dueDate: null,
          payments: [],
        },
      ]);
      prisma.invoicePayment.count.mockResolvedValue(0);
      prisma.$queryRaw.mockResolvedValue([{ avgDays: 0 }]);

      const svc = service as unknown as {
        getKpiSummary?: (
          today: string,
          user: { sub: string; role: UserRole },
        ) => Promise<Record<string, number>>;
      };
      expect(typeof svc.getKpiSummary).toBe("function");
      const result = await svc.getKpiSummary!("2026-08-26", OPERATOR);

      expect({
        overdue: result.overdue,
        dueIn30: result.dueIn30,
        dueToday: result.dueToday,
        totalOutstanding: result.totalOutstanding,
      }).toEqual({ overdue: 100, dueIn30: 0, dueToday: 0, totalOutstanding: 100 });
    });

    // m7 (F16 hotfix) — the awaiting-confirmation tile does NOT share the money
    // tiles' OPEN basis. It reproduces the client memo it replaced, whose count
    // ran above and outside every status branch:
    //
    //   for (const p of inv.payments ?? []) {
    //     if (p.status === "DRAFT") awaitingConfirmationCount++;
    //   }
    //
    // over `useInvoices({ limit: 999 })` — i.e. every invoice of every status.
    // Scoping it to KPI_SUMMARY_EXCLUDED zeroed the tile for the commonest
    // case: a DRAFT payment on a still-DRAFT invoice, which `recordPayment`
    // deliberately leaves DRAFT. So for staff the count carries NO
    // invoice-status filter at all.
    it("counts DRAFT payments across EVERY invoice status for staff (m7 — the memo's basis)", async () => {
      prisma.invoice.findMany.mockResolvedValue([]);
      prisma.invoicePayment.count.mockResolvedValue(2);
      prisma.$queryRaw.mockResolvedValue([{ avgDays: 0 }]);

      const svc = service as unknown as {
        getKpiSummary?: (
          today: string,
          user: { sub: string; role: UserRole },
        ) => Promise<Record<string, number>>;
      };
      expect(typeof svc.getKpiSummary).toBe("function");
      const result = await svc.getKpiSummary!("2026-08-26", OPERATOR);
      expect(result.awaitingConfirmationCount).toBe(2);

      const countWhere = prisma.invoicePayment.count.mock.calls[0][0].where;
      expect(countWhere.status).toBe("DRAFT");
      // The regression this pins: ANY invoice-status narrowing here drops the
      // draft payments the E2E's own fixture creates (a DRAFT invoice), which
      // is what made the tile read 0. The money tiles' OPEN set must not leak
      // into this count.
      expect(countWhere.invoice).toBeUndefined();
    });

    // avgDays feeds the tile's `avgDays > 0 ? … : "N/A"` render, so it must be
    // a NUMBER even when nothing qualifies: Postgres AVG() over an empty
    // population returns NULL, and a narrowed query can return no row at all.
    // `?? null` would render "N/A" only by the accident of `null > 0`.
    it("reports avgDays 0 when the aging query averages NULL", async () => {
      prisma.invoice.findMany.mockResolvedValue([]);
      prisma.invoicePayment.count.mockResolvedValue(0);
      prisma.$queryRaw.mockResolvedValue([{ avgDays: null }]);

      const svc = service as unknown as {
        getKpiSummary?: (
          today: string,
          user: { sub: string; role: UserRole },
        ) => Promise<Record<string, number>>;
      };
      expect(typeof svc.getKpiSummary).toBe("function");
      expect((await svc.getKpiSummary!("2026-08-26", OPERATOR)).avgDays).toBe(0);
    });

    it("reports avgDays 0 when the aging query returns no row at all", async () => {
      prisma.invoice.findMany.mockResolvedValue([]);
      prisma.invoicePayment.count.mockResolvedValue(0);
      prisma.$queryRaw.mockResolvedValue([]);

      const svc = service as unknown as {
        getKpiSummary?: (
          today: string,
          user: { sub: string; role: UserRole },
        ) => Promise<Record<string, number>>;
      };
      expect(typeof svc.getKpiSummary).toBe("function");
      expect((await svc.getKpiSummary!("2026-08-26", OPERATOR)).avgDays).toBe(0);
    });

    // The DTO's `@Matches(/^\d{4}-\d{2}-\d{2}$/)` pins the SHAPE only. A value
    // that matches it but is not a real calendar day must be rejected BEFORE
    // any query runs: `2026-13-01` would otherwise 500 on `.toISOString()`
    // after three reads, and `2026-02-30` would silently roll to Mar 2 and
    // bucket the tiles against a day the caller never asked for.
    it.each(["2026-13-01", "2026-02-30"])(
      "rejects a shape-valid but non-existent calendar day (%s) before any query runs",
      async (today) => {
        const svc = service as unknown as {
          getKpiSummary?: (
            today: string,
            user: { sub: string; role: UserRole },
          ) => Promise<Record<string, number>>;
        };
        expect(typeof svc.getKpiSummary).toBe("function");
        await expect(svc.getKpiSummary!(today, OPERATOR)).rejects.toThrow(BadRequestException);
        expect(prisma.invoice.findMany).not.toHaveBeenCalled();
      },
    );

    // With no tenant context `forTenant()` reads UNSCOPED while the raw query's
    // `"tenantId" = NULL` matches nothing — one response mixing all-tenant
    // totals with a zeroed average. All three reads must agree instead.
    it("returns a zeroed summary — and reads nothing — when there is no tenant context", async () => {
      prisma.getTenantId.mockReturnValue(null);

      const svc = service as unknown as {
        getKpiSummary?: (
          today: string,
          user: { sub: string; role: UserRole },
        ) => Promise<Record<string, number>>;
      };
      expect(typeof svc.getKpiSummary).toBe("function");
      expect(await svc.getKpiSummary!("2026-08-26", OPERATOR)).toEqual({
        totalOutstanding: 0,
        overdue: 0,
        dueToday: 0,
        dueIn30: 0,
        avgDays: 0,
        awaitingConfirmationCount: 0,
      });
      expect(prisma.invoice.findMany).not.toHaveBeenCalled();
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    // The invoices page is CUSTOMER-allowed and the bar renders on it, so a
    // buyer must get their OWN figures — never the tenant's whole receivables.
    // All THREE reads carry the scope: the totals, the awaiting-confirmation
    // count, and the raw avgDays average.
    it("scopes all three reads to the caller's own customer when the viewer is a CUSTOMER", async () => {
      prisma.customer.findFirst.mockResolvedValue({ id: "cust-9" });
      prisma.invoice.findMany.mockResolvedValue([
        { id: "inv-mine", total: 100, dueDate: new Date("2026-08-25T00:00:00.000Z"), payments: [] },
      ]);
      prisma.invoicePayment.count.mockResolvedValue(1);
      prisma.$queryRaw.mockResolvedValue([{ avgDays: 4 }]);

      const svc = service as unknown as {
        getKpiSummary?: (
          today: string,
          user: { sub: string; role: UserRole },
        ) => Promise<Record<string, number>>;
      };
      expect(typeof svc.getKpiSummary).toBe("function");
      const result = await svc.getKpiSummary!("2026-08-26", BUYER);

      expect(result.overdue).toBe(100);
      // Resolved by the caller's USER id, exactly the way findAll resolves it.
      expect(prisma.customer.findFirst.mock.calls[0][0]).toEqual({
        where: { userId: "user-buyer" },
      });
      expect(prisma.invoice.findMany.mock.calls[0][0].where.customerId).toBe("cust-9");
      // m7 (F16 hotfix): the count carries the buyer's OWN scope — exactly
      // `findAll`'s buyer rule (their customer id, minus the DRAFT invoices a
      // buyer is never shown), NOT the money tiles' OPEN set. A buyer must
      // never be handed another customer's unconfirmed payments, but a draft
      // payment on their own PAID or OVERDUE invoice is still theirs to see.
      const buyerCountInvoiceWhere = prisma.invoicePayment.count.mock.calls[0][0].where.invoice;
      expect(buyerCountInvoiceWhere.customerId).toBe("cust-9");
      expect(buyerCountInvoiceWhere.status).toEqual({ not: InvoiceStatus.DRAFT });
      // …and the customer id reaches the raw avgDays query as a BOUND value
      // too — nested one level down inside the conditional `Prisma.sql`
      // fragment, so the oracle flattens before it looks.
      const flatValues = (v: any): any[] =>
        v && typeof v === "object" && Array.isArray(v.strings) && Array.isArray(v.values)
          ? v.values.flatMap((x: any) => flatValues(x))
          : Array.isArray(v)
            ? v.flatMap((x: any) => flatValues(x))
            : [v];
      expect(prisma.$queryRaw.mock.calls[0].slice(1).flatMap(flatValues)).toContain("cust-9");
    });

    // A CUSTOMER token with no customer profile is the same empty answer
    // `findAll` gives it (an empty page), never the tenant-wide totals an
    // unscoped read would return.
    it("returns a zeroed summary — and reads nothing — for a CUSTOMER with no customer profile", async () => {
      prisma.customer.findFirst.mockResolvedValue(null);

      const svc = service as unknown as {
        getKpiSummary?: (
          today: string,
          user: { sub: string; role: UserRole },
        ) => Promise<Record<string, number>>;
      };
      expect(typeof svc.getKpiSummary).toBe("function");
      expect(await svc.getKpiSummary!("2026-08-26", BUYER)).toEqual({
        totalOutstanding: 0,
        overdue: 0,
        dueToday: 0,
        dueIn30: 0,
        avgDays: 0,
        awaitingConfirmationCount: 0,
      });
      expect(prisma.invoice.findMany).not.toHaveBeenCalled();
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });
  });

  // ─── T4 unit pin — REG-B269 (cause-ruling.md §2 D3, bug-test-plan.md T4) ───
  //
  // Site 3 (recordStandalonePayment, reached from payment-requests.service.ts:853
  // for a Stripe settlement) mints `PAY-####` from the `"singleton"` counter key
  // with no tenant segment — sites 1/2 already embed `tenantShort` for exactly
  // this reason (invoices.service.ts:4743-4745). D3's `nextPaymentNumber(tenantId)`
  // helper must: require a non-empty tenant (never fall back to "singleton"),
  // format `PAY-<tenantShort>-####` the same way sites 1/2 already do, and
  // reserve the counter on a client that is NOT the payment transaction's own
  // (a short standalone reservation committed before the payment tx opens —
  // the same shape NumberingService's own fast path uses via `forTenant()`,
  // never nested inside a caller's `$transaction`). TODAY none of this holds:
  // recordStandalonePayment reserves the counter INSIDE its own single
  // `tenantTransaction` call and never checks for a null tenant.
  describe("REG-B269 pin: recordStandalonePayment's PaymentCounter mint (site 3)", () => {
    const seedValidInvoice = (id: string) => {
      prisma.invoice.findFirst.mockResolvedValue({
        id,
        customerId: "cust-1",
        status: InvoiceStatus.SENT,
        total: 100,
        dueDate: null,
        payments: [],
      });
      prisma.invoicePayment.findMany.mockResolvedValue([]);
    };

    it("REG-B269-pin-1: refuses a null-tenant booking instead of minting from the singleton counter", async () => {
      prisma.getTenantId.mockReturnValue(null);
      seedValidInvoice("inv-b269-1");
      prisma.paymentCounter.upsert.mockResolvedValue({ id: "singleton", next: 2 });

      // TODAY this RESOLVES (site 3 falls back to `?? "singleton"` and mints
      // successfully), so asserting a rejection fails on that concrete
      // behavior — a resolved promise where BadRequestException is expected —
      // not on an unresolved import or a stub.
      await expect(
        service.recordStandalonePayment({
          customerId: "cust-1",
          totalAmount: 40,
          method: "CHECK",
          allocations: [{ invoiceId: "inv-b269-1", amount: 40 }],
        } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("REG-B269-pin-2: formats PAY-<tenantShort>-#### exactly like sites 1/2, not the bare PAY-#### site 3 mints today", async () => {
      prisma.getTenantId.mockReturnValue("qa269ab");
      seedValidInvoice("inv-b269-2");
      prisma.paymentCounter.upsert.mockResolvedValue({ id: "qa269ab", next: 2 });

      await service.recordStandalonePayment({
        customerId: "cust-1",
        totalAmount: 40,
        method: "CHECK",
        allocations: [{ invoiceId: "inv-b269-2", amount: 40 }],
      } as any);

      // sites 1/2's algorithm: tenantShort = tenantId.slice(0,6).toUpperCase().
      // TODAY site 3 writes the bare "PAY-0001" (no tenant segment) instead.
      expect(prisma.invoicePayment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ paymentNumber: "PAY-QA269A-0001" }),
        }),
      );
    });

    it("REG-B269-pin-3: reserves the counter on a client OUTSIDE the payment transaction, never on the tx that writes the InvoicePayment rows", async () => {
      prisma.getTenantId.mockReturnValue("qa269c");
      seedValidInvoice("inv-b269-3");
      prisma.paymentCounter.upsert.mockResolvedValue({ id: "qa269c", next: 2 });

      // A tx-scoped paymentCounter DISTINCT from the standalone prisma.paymentCounter
      // mock — the only way to make "which client reserved it" observable, since
      // the shared prisma-mock fixture normally hands the tx callback the SAME
      // model-proxy reference as the top level. D3: the mint must commit standalone
      // BEFORE the payment tx opens, so a compliant fix never reaches this one.
      const txPaymentCounterUpsert = jest.fn().mockResolvedValue({ id: "qa269c", next: 99 });
      prisma.tenantTransaction.mockImplementation((fn: any) =>
        fn({
          ...prisma,
          paymentCounter: { upsert: txPaymentCounterUpsert },
          $executeRaw: jest.fn().mockResolvedValue(0),
          $queryRaw: jest.fn().mockResolvedValue([]),
        }),
      );

      await service.recordStandalonePayment({
        customerId: "cust-1",
        totalAmount: 40,
        method: "CHECK",
        allocations: [{ invoiceId: "inv-b269-3", amount: 40 }],
      } as any);

      // TODAY: recordStandalonePayment reserves on `tx.paymentCounter.upsert`
      // (the ONE tenantTransaction call wrapping the whole method), so the
      // standalone client is never touched and the tx-scoped one is — the
      // reverse of what this pins.
      expect(prisma.paymentCounter.upsert).toHaveBeenCalled();
      expect(txPaymentCounterUpsert).not.toHaveBeenCalled();
    });

    // F6 (REG-B269-E, cause-ruling.md §2 D2 follow-up / findings #4 on run 54):
    // the explicit `tenantId` lived only on the `create` arm, so a tenant that
    // already recorded a payment before this helper existed kept its counter
    // row at `tenantId: NULL` forever — the `update` arm never touched that
    // column. Pins that BOTH arms of the upsert now carry `tenantId`.
    it("REG-B269-E counter update arm sets tenantId", async () => {
      prisma.getTenantId.mockReturnValue("qa269e2");
      seedValidInvoice("inv-b269-e");
      prisma.paymentCounter.upsert.mockResolvedValue({ id: "qa269e2", next: 2 });

      await service.recordStandalonePayment({
        customerId: "cust-1",
        totalAmount: 40,
        method: "CHECK",
        allocations: [{ invoiceId: "inv-b269-e", amount: 40 }],
      } as any);

      expect(prisma.paymentCounter.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "qa269e2" },
          update: expect.objectContaining({ tenantId: "qa269e2" }),
          create: expect.objectContaining({ tenantId: "qa269e2" }),
        }),
      );
    });
  });

  // ─── T4 unit pin — REG-B269 sites 1/2 (cause-ruling.md §2 D3) ───────────────
  //
  // D3's tenant requirement is a policy shared by ALL THREE PAY sites, not just
  // the standalone one: `?? "singleton"` at site 1 (recordPayment) and site 2
  // (nextPaymentNumberInTx) would mint `PAY-SINGLE-####` off ONE globally shared
  // PaymentCounter row, so two tenants' first null-tenant payments produce the
  // same string and the second dies on the GLOBAL InvoicePayment.paymentNumber
  // unique — the same B269 failure class site 3 now refuses. What is NOT shared
  // is reservation LIFETIME: sites 1/2 still mint on the caller's transaction
  // (a standalone hoist would take a second pooled connection inside an open tx
  // — F16b — and would burn a number on every validation failure), site 3 alone
  // reserves standalone before its tx (pin-3 above).
  describe("REG-B269 pin: the tenant requirement covers PAY sites 1 and 2 too", () => {
    const seedInvoiceAndUpdate = (id: string) => {
      prisma.invoice.findUnique.mockResolvedValue({
        id,
        status: InvoiceStatus.SENT,
        total: 100,
        dueDate: null,
        payments: [],
      });
      prisma.invoice.update.mockResolvedValue({
        id,
        invoiceNumber: "INV-0001",
        customerId: "cust-1",
        total: 100,
        payments: [],
      });
    };

    it("REG-B269-pin-4: recordPayment (site 1) refuses a null tenant instead of minting from the singleton counter", async () => {
      prisma.getTenantId.mockReturnValue(null);
      seedInvoiceAndUpdate("inv-b269-4");
      prisma.paymentCounter.upsert.mockResolvedValue({ id: "singleton", next: 2 });

      // TODAY this RESOLVES, writing paymentNumber "PAY-SINGLE-0001" off the
      // shared counter row — a resolved promise where BadRequestException is
      // expected, not an unresolved import or a stub.
      await expect(
        service.recordPayment("inv-b269-4", { amount: 100, method: "CASH" } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
      // Refused BEFORE the counter is touched: no number is burnt on the refusal.
      expect(prisma.paymentCounter.upsert).not.toHaveBeenCalled();
    });

    it("REG-B269-pin-5: nextPaymentNumberInTx (site 2, the driver delivery path) refuses a null tenant and otherwise mints on the CALLER's tx", async () => {
      const txUpsert = jest.fn().mockResolvedValue({ id: "qa269d", next: 2 });
      const tx = { paymentCounter: { upsert: txUpsert } };
      const mint = (service as any).nextPaymentNumberInTx.bind(service) as (
        tx: unknown,
      ) => Promise<string>;

      prisma.getTenantId.mockReturnValue(null);
      // TODAY: resolves "PAY-SINGLE-0001" off the shared counter.
      await expect(mint(tx)).rejects.toBeInstanceOf(BadRequestException);
      expect(txUpsert).not.toHaveBeenCalled();

      prisma.getTenantId.mockReturnValue("qa269d");
      await expect(mint(tx)).resolves.toBe("PAY-QA269D-0001");
      // Reservation lifetime is unchanged: still the caller's tx, never a
      // standalone client (site 2 runs inside the delivery transaction).
      expect(txUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "qa269d" },
          create: expect.objectContaining({ id: "qa269d", tenantId: "qa269d" }),
        }),
      );
      expect(prisma.paymentCounter.upsert).not.toHaveBeenCalled();
    });

    it("REG-B269-pin-6: recordPayment's counter row is keyed on the tenantId and carries tenantId on create", async () => {
      prisma.getTenantId.mockReturnValue("qa269e");
      seedInvoiceAndUpdate("inv-b269-6");
      prisma.paymentCounter.upsert.mockResolvedValue({ id: "qa269e", next: 2 });

      await service.recordPayment("inv-b269-6", { amount: 100, method: "CASH" } as any);

      // Without the explicit `tenantId` the row lands tenant-less whenever the
      // callback gets a raw (unwrapped) client — the legacy shape
      // backfill-legacy-tenant-ids.mjs exists to repair.
      expect(prisma.paymentCounter.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "qa269e" },
          create: expect.objectContaining({ id: "qa269e", tenantId: "qa269e" }),
        }),
      );
      expect(prisma.invoicePayment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ paymentNumber: "PAY-QA269E-0001" }),
        }),
      );
    });
  });

  describe("create() — removed customer (B131)", () => {
    const REMOVED_AT = new Date("2026-09-01T00:00:00.000Z");
    const dto = {
      customerId: "cust-1",
      items: [{ productId: "prod-plain", description: "Soda", qty: 2, unitPrice: 3 }],
    };
    // Same fixture as "create() does NOT touch the ledger for a purely non-regulated invoice" (RF-1).
    const arrange = (deletedAt: Date | null) => {
      prisma.customer.findUnique.mockResolvedValue({
        id: "cust-1",
        isTaxExempt: false,
        deletedAt,
      } as any);
      prisma.product.findMany.mockResolvedValue([
        {
          id: "prod-plain",
          unitsPerBox: null,
          trackedCategoryId: null,
          trackedSubcategoryId: null,
        },
      ] as any);
      prisma.invoice.findFirst.mockResolvedValue(null);
      prisma.invoice.create.mockResolvedValue({
        id: "inv-2",
        items: [],
        customer: {},
        payments: [],
      } as any);
    };

    it("REG-B131 T4: create() refuses a removed customer with the not-found 404", async () => {
      arrange(REMOVED_AT);
      await expect(service.create(dto as any)).rejects.toBeInstanceOf(NotFoundException);
    });

    it("REG-B131 T5: create() for a removed customer writes no invoice row", async () => {
      arrange(REMOVED_AT);
      await service.create(dto as any).catch(() => undefined);
      expect(prisma.invoice.create).not.toHaveBeenCalled();
    });

    it("B131 P3: create() still invoices a live customer (fixture control)", async () => {
      arrange(null);
      await expect(service.create(dto as any)).resolves.toMatchObject({ id: "inv-2" });
    });
  });

  // ─── B306: driver at-door over-collection advance has no reversal ───────
  // recordDeliveryPaymentInTx (:5035-5046) books a driver's excess at-door
  // collection as an AdvancePayment tagged `RUN:<runId>:STOP:<stopId>`.
  // Nothing today reverses that advance when the door payment(s) that
  // produced it are later voided — routes.service.ts's run-cash
  // reconciliation keeps summing it forever (see routes.service.spec.ts).
  // voidPayment must detect "this invoice's order sits on a RUN stop AND no
  // CONFIRMED payment remains for that stop" and reverse the matching
  // RUN-tagged advance(s) instead of leaving them live.
  describe("voidPayment — reverses a RUN-tagged at-door advance (REG-B306)", () => {
    const arrangeRunStopVoid = (advanceOverrides: any = {}, confirmedRemaining = 0) => {
      prisma.invoicePayment.findFirst.mockResolvedValue({
        id: "pay-1",
        invoiceId: "inv-1",
        status: "PAID",
        method: "CASH",
        amount: 20,
      });
      prisma.invoice.findUnique.mockResolvedValue({
        id: "inv-1",
        total: 20,
        dueDate: null,
        status: "PAID",
        payments: [],
        order: { routeRunId: "run-1", routeRunStopId: "stop-1" },
        invoiceNumber: "INV-1",
        customerId: "c-1",
      });
      prisma.invoicePayment.count.mockResolvedValue(confirmedRemaining);
      prisma.advancePayment.findMany.mockResolvedValue([
        {
          id: "adv-1",
          amount: 5,
          balance: 5,
          reference: "RUN:run-1:STOP:stop-1",
          notes: "Driver at-door over-collection",
          ...advanceOverrides,
        },
      ]);
    };

    it("REG-B306 a RUN-tagged excess advance is reversible and the run's collected-cash total excludes advances whose payments were voided", async () => {
      arrangeRunStopVoid();

      await service.voidPayment("inv-1", "pay-1");

      // Assert the reversal write first so a failure names the missing
      // reversal itself, not just the absent lookup that would precede it.
      expect(prisma.advancePayment.update).toHaveBeenCalledWith({
        where: { id: "adv-1" },
        data: expect.objectContaining({
          balance: 0,
          reference: "RUN:run-1:STOP:stop-1:REVERSED",
          notes: expect.stringContaining("REVERSED"),
        }),
      });
      expect(prisma.advancePayment.findMany).toHaveBeenCalledWith({
        where: { reference: "RUN:run-1:STOP:stop-1" },
      });
    });

    it("REG-B306 an advance that was already applied is not silently reversed", async () => {
      arrangeRunStopVoid({ balance: 2 });

      await expect(service.voidPayment("inv-1", "pay-1")).rejects.toThrow(BadRequestException);
      await expect(service.voidPayment("inv-1", "pay-1")).rejects.toThrow(/advance.*applied/i);
      expect(prisma.advancePayment.update).not.toHaveBeenCalled();
    });

    // Green today by accident: no reversal code exists yet at all, so a stop
    // with one confirmed payment still standing never triggers a spurious
    // reversal either. This pins the fix to the same "no confirmed payment
    // remains for the stop" gate once it exists, as a regression guard.
    it("REG-B306 voiding one of several confirmed door payments leaves the advance alone", async () => {
      arrangeRunStopVoid({}, 1);

      const result = await service.voidPayment("inv-1", "pay-1");

      expect(result).toEqual({ success: true });
      expect(prisma.advancePayment.findMany).not.toHaveBeenCalled();
    });
  });
});

/**
 * Invoice issue/due dates are CALENDAR dates: they are stored as UTC-midnight instants
 * and every render surface (list, detail, PDF, email) formats them with timeZone: "UTC".
 * These guard the write side of that invariant.
 */
describe("calendar-date helpers", () => {
  it("dates a same-day sale in the TENANT's calendar day, at UTC midnight", () => {
    // 8:10pm America/New_York on Aug 22 is already Aug 23 in UTC. Storing raw
    // new Date() would print the invoice as Aug 23 — a day after the sale happened.
    const at810pmEdt = new Date("2026-08-23T00:10:00.000Z");
    expect(startOfCalendarDay(at810pmEdt, "America/New_York").toISOString()).toBe(
      "2026-08-22T00:00:00.000Z",
    );
  });

  it("falls back to the UTC day when the tenant timezone is missing or invalid", () => {
    const now = new Date("2026-08-23T00:10:00.000Z");
    expect(startOfCalendarDay(now, null).toISOString()).toBe("2026-08-23T00:00:00.000Z");
    expect(startOfCalendarDay(now, "Not/AZone").toISOString()).toBe("2026-08-23T00:00:00.000Z");
  });

  it("adds payment terms in UTC so the due date never drifts across a DST change", () => {
    // Net 30 from Mar 1: local setDate() on a UTC-midnight instant lands on
    // 2026-03-30T23:00Z after spring-forward, which prints as Mar 30 — one day early.
    expect(addCalendarDays(new Date("2026-03-01T00:00:00.000Z"), 30).toISOString()).toBe(
      "2026-03-31T00:00:00.000Z",
    );
    // Plan acceptance criterion: Aug 4 + Net 60 = Oct 3.
    expect(addCalendarDays(new Date("2026-08-04T00:00:00.000Z"), 60).toISOString()).toBe(
      "2026-10-03T00:00:00.000Z",
    );
  });
});

/**
 * Invoice issue/due dates are CALENDAR dates: they are stored as UTC-midnight instants
 * and every render surface (list, detail, PDF, email) formats them with timeZone: "UTC".
 * These guard the write side of that invariant.
 */
describe("calendar-date helpers", () => {
  it("dates a same-day sale in the TENANT's calendar day, at UTC midnight", () => {
    // 8:10pm America/New_York on Aug 22 is already Aug 23 in UTC. Storing raw
    // new Date() would print the invoice as Aug 23 — a day after the sale happened.
    const at810pmEdt = new Date("2026-08-23T00:10:00.000Z");
    expect(startOfCalendarDay(at810pmEdt, "America/New_York").toISOString()).toBe(
      "2026-08-22T00:00:00.000Z",
    );
  });

  it("falls back to the UTC day when the tenant timezone is missing or invalid", () => {
    const now = new Date("2026-08-23T00:10:00.000Z");
    expect(startOfCalendarDay(now, null).toISOString()).toBe("2026-08-23T00:00:00.000Z");
    expect(startOfCalendarDay(now, "Not/AZone").toISOString()).toBe("2026-08-23T00:00:00.000Z");
  });

  it("adds payment terms in UTC so the due date never drifts across a DST change", () => {
    // Net 30 from Mar 1: local setDate() on a UTC-midnight instant lands on
    // 2026-03-30T23:00Z after spring-forward, which prints as Mar 30 — one day early.
    expect(addCalendarDays(new Date("2026-03-01T00:00:00.000Z"), 30).toISOString()).toBe(
      "2026-03-31T00:00:00.000Z",
    );
    // Plan acceptance criterion: Aug 4 + Net 60 = Oct 3.
    expect(addCalendarDays(new Date("2026-08-04T00:00:00.000Z"), 60).toISOString()).toBe(
      "2026-10-03T00:00:00.000Z",
    );
  });
});
