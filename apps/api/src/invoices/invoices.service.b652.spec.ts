/**
 * B652 (SA-178) — a partial unit (Case) bills as Cases + pieces; a fractional piece qty is refused.
 *
 * Own file (not added to invoices.service.spec.ts) per the repo's size ratchet
 * (`common/size-ratchet.spec.ts` — that file is one of the 15 tracked giants and may not grow).
 * Same bootstrap pattern as the main spec file; duplicated deliberately rather than shared, so
 * this file stays self-contained and small.
 */

// Prevent Jest from traversing ESM-only dependencies
jest.mock("./invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://example.com/invoice.pdf"),
  })),
}));

jest.mock("../storage/compress.util", () => ({
  compressDocument: jest.fn(),
}));

import { Test, TestingModule } from "@nestjs/testing";
import { InvoicesService } from "./invoices.service";
import { InvoicePdfService } from "./invoice-pdf.service";
import { PrismaService } from "../prisma/prisma.service";
import { NumberingService } from "../import/numbering.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { EmailService } from "../email/email.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { StorageService } from "../storage/storage.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { MessagingService } from "../messaging/messaging.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { InvoiceStatus } from "@prisma/client";
import { assertIntegerPieces, billPackOf } from "./unit-line-bill-guard";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { fillSparseCasBasis } from "./testing/sparse-line-fixtures";

describe("InvoicesService — B652 unit-line partial billing", () => {
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
    releaseInvoiceCreditsInTx: jest.fn().mockResolvedValue([]),
  };
  const mockStorage = {
    upload: jest.fn().mockResolvedValue("stored"),
    presignedUrl: jest.fn().mockResolvedValue("https://signed/url"),
    delete: jest.fn().mockResolvedValue(undefined),
  };
  const mockEntitlements = { hasFlag: jest.fn().mockResolvedValue(false) };
  const mockCommissionEngine = {
    syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined),
    syncOrderInvoices: jest.fn().mockResolvedValue(undefined),
    removeInvoiceCommission: jest.fn().mockResolvedValue(undefined),
  };
  const mockNumbering = { reserveNext: jest.fn().mockResolvedValue("INV-2026-0001") };

  beforeEach(async () => {
    fillSparseCasBasis(); // #2645: sparse order fixtures vs the CAS basis pin
    prisma = createMockPrisma();
    // #2070: createPartialFromOrder's invoicedQty bump is a CAS (updateMany); a clean read matches 1.
    prisma.orderItem.updateMany.mockResolvedValue({ count: 1 } as any);
    prisma.invoice.findFirst.mockResolvedValue({ items: [] });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvoicesService,
        {
          provide: SellingRestrictionsService,
          useValue: { assertLinesSellable: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: mockGateway },
        { provide: EmailService, useValue: mockEmailService },
        { provide: InvoicePdfService, useValue: { getOrGenerate: jest.fn() } },
        { provide: SystemConfigService, useValue: mockSystemConfig },
        {
          provide: RegulatedLedgerService,
          useValue: {
            writeSaleEntries: jest.fn(),
            reverseInvoiceEntries: jest.fn(),
            syncInvoiceEntries: jest.fn(),
          },
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
        {
          provide: EntitlementAuthority,
          inject: [EntitlementsService],
          useFactory: (e: { hasFlag?: (t: string, k: string) => Promise<boolean> }) => ({
            can: (t: string, k: string) => e.hasFlag?.(t, k) ?? Promise.resolve(false),
          }),
        },
        { provide: EntitlementsService, useValue: mockEntitlements },
        { provide: CommissionEngineService, useValue: mockCommissionEngine },
        { provide: NumberingService, useValue: mockNumbering },
      ],
    }).compile();

    service = module.get<InvoicesService>(InvoicesService);
  });

  const caseLine = (over: any = {}) => ({
    id: "oi-1",
    productId: "p-1",
    qty: 96, // 8 Cases x 12 pieces (base pieces)
    invoicedQty: 0,
    boxes: 8,
    pieces: 0,
    unitsPerBox: 12,
    unitLabel: "Case",
    unitPrice: 120, // per Case
    subtotal: 960,
    product: { name: "Widget", unitsPerBox: 12 },
    ...over,
  });
  const build = (li: any, billQty: number, opts?: any) =>
    (service as any).buildInvoiceItemData(li, billQty, null, opts);

  describe("createPartialFromOrder — a partial Case is legitimate (SA-178)", () => {
    const caseOrder = (over: any = {}) => ({
      id: "ord-c1",
      customerId: "cust-1",
      orderNumber: "ORD-C1",
      subtotal: 960,
      tax: 0,
      shippingFee: 0,
      lineItems: [caseLine(over)],
    });
    beforeEach(() => {
      prisma.customer.findUnique.mockResolvedValue({ isTaxExempt: false } as any);
      prisma.invoice.aggregate.mockResolvedValue({ _sum: { shippingFee: 0 } });
      prisma.invoice.create.mockImplementation((args: any) =>
        Promise.resolve({ ...args.data, items: [], payments: [], customer: {} }),
      );
      prisma.orderItem.update.mockResolvedValue({} as any);
    });

    it("52 of a 12/Case line bills 4 Cases + 4 pcs at 52/96 of the subtotal, label kept, invoicedQty +52", async () => {
      prisma.order.findUnique.mockResolvedValue(caseOrder());
      await service.createPartialFromOrder("ord-c1", {
        items: [{ orderItemId: "oi-1", qty: 52 }],
      } as any);
      const line = prisma.invoice.create.mock.calls[0][0].data.items.create[0];
      expect(line).toMatchObject({
        unitLabel: "Case",
        qty: 52,
        boxes: 4,
        pieces: 4,
        unitsPerBox: 12,
      });
      expect(Number(line.subtotal)).toBe(520); // 960 x 52/96
      expect(prisma.orderItem.updateMany).toHaveBeenCalledWith({
        where: expect.objectContaining({ id: "oi-1", status: { not: "CANCELLED" } }),
        data: { invoicedQty: { increment: 52 } },
      });
    });

    it("44 of a 96-piece line bills 3 Cases + 8 pcs", async () => {
      prisma.order.findUnique.mockResolvedValue(caseOrder());
      await service.createPartialFromOrder("ord-c1", {
        items: [{ orderItemId: "oi-1", qty: 44 }],
      } as any);
      const line = prisma.invoice.create.mock.calls[0][0].data.items.create[0];
      expect(line).toMatchObject({ unitLabel: "Case", boxes: 3, pieces: 8 });
    });

    it("47.9995 is refused (400 'not a whole number of pieces'), nothing written", async () => {
      prisma.order.findUnique.mockResolvedValue(caseOrder());
      await expect(
        service.createPartialFromOrder("ord-c1", {
          items: [{ orderItemId: "oi-1", qty: 47.9995 }],
        } as any),
      ).rejects.toThrow(
        "Requested qty 47.9995 of Widget is not a whole number of pieces (1 Case = 12 pieces).",
      );
      expect(prisma.invoice.create).not.toHaveBeenCalled();
      expect(prisma.orderItem.update).not.toHaveBeenCalled();
    });

    it("a PACK line (no unitLabel) at 52 is unchanged: 4 boxes + 4 pieces", async () => {
      prisma.order.findUnique.mockResolvedValue(caseOrder({ unitLabel: null }));
      await service.createPartialFromOrder("ord-c1", {
        items: [{ orderItemId: "oi-1", qty: 52 }],
      } as any);
      const line = prisma.invoice.create.mock.calls[0][0].data.items.create[0];
      expect(line).toMatchObject({ qty: 52, boxes: 4, pieces: 4 });
    });
  });

  describe("buildInvoiceItemData — own factor always wins, integer pieces (SA-178)", () => {
    it("1 Pallet(120) -> 5 Cases(12), qty 60: a prior draft pack of 120 never overrides the line's own 12", () => {
      const line = build(caseLine({ qty: 60, boxes: 5, subtotal: 600 }), 60, { priorPack: 120 });
      expect(line).toMatchObject({
        unitLabel: "Case",
        qty: 60,
        boxes: 5,
        pieces: 0,
        unitsPerBox: 12,
      });
    });

    it("delivered 50 of a 60-piece Case line reconciles to 4 Cases + 2 pcs", () => {
      const line = build(caseLine({ qty: 60, boxes: 5, subtotal: 600 }), 50, { priorPack: 120 });
      expect(line).toMatchObject({ boxes: 4, pieces: 2, qty: 50, unitLabel: "Case" });
      expect(Number(line.subtotal)).toBe(500);
    });

    it("a PACK line still honours the prior draft's pack snapshot", () => {
      const line = build(caseLine({ unitLabel: null, unitsPerBox: 12 }), 52, { priorPack: 6 });
      expect(line).toMatchObject({ boxes: 8, pieces: 4, unitsPerBox: 6 });
    });

    it("a factor-1 unit line (a Piece off a boxed pack) bills as-is", () => {
      const line = build(
        caseLine({ unitLabel: "Piece", unitsPerBox: 1, qty: 10, boxes: 10, subtotal: 100 }),
        5,
      );
      expect(line).toMatchObject({ qty: 5, unitLabel: "Piece" });
    });

    it("a non-boxed Decimal qty (1.5 kg) is untouched", () => {
      const line = build(
        caseLine({
          unitLabel: null,
          unitsPerBox: null,
          boxes: null,
          pieces: null,
          qty: 4,
          subtotal: 40,
          product: { name: "Rice", unitsPerBox: null },
        }),
        1.5,
      );
      expect(line.qty).toBe(1.5);
    });

    it("a BOX-UNAWARE line (boxes null, own unitsPerBox null) at 1.5 bills as before, even with a prior/live pack of 12", () => {
      const li = caseLine({
        unitLabel: null,
        boxes: null,
        pieces: null,
        unitsPerBox: null,
        qty: 4,
        subtotal: 40,
        unitPrice: 10,
      });
      for (const opts of [undefined, { priorPack: 12 }]) {
        const line = build(li, 1.5, opts);
        expect(line).toMatchObject({ qty: 1.5, boxes: null, pieces: null });
        expect(Number(line.subtotal)).toBe(15); // 40 x 1.5/4 prorated, never refused
      }
    });

    it("exactly 0.001 of a boxed line is refused (no truncation to a $0.01 '0 Case' line)", () => {
      expect(() => build(caseLine(), 0.001)).toThrow("not a whole number of pieces");
    });

    it("47.9995 on a boxed line is refused before any math", () => {
      expect(() => build(caseLine(), 47.9995)).toThrow(
        "Requested qty 47.9995 of Widget is not a whole number of pieces (1 Case = 12 pieces).",
      );
    });
  });

  describe("reconcileOrderDraftInvoice — a unit change on a line with an open draft (SA-178)", () => {
    const armReconcile = (draftPack: number) => {
      prisma.invoice.findFirst.mockResolvedValue({
        id: "d1",
        discount: 0,
        shippingFee: 0,
      });
      // the open draft's stored line still carries the OLD (Pallet) pack snapshot
      prisma.invoiceItem.findMany.mockResolvedValue([
        { orderItemId: "oi-1", unitsPerBox: draftPack },
      ]);
      prisma.order.findUnique.mockResolvedValue({
        id: "o1",
        customerId: "c1",
        subtotal: 600,
        tax: 0,
        lineItems: [
          caseLine({ qty: 60, deliveredQty: 50, boxes: 5, subtotal: 600, status: "PENDING" }),
        ],
      });
      prisma.customer.findUnique.mockResolvedValue({ isTaxExempt: false });
      prisma.invoiceItem.deleteMany.mockResolvedValue({});
      prisma.invoice.update.mockResolvedValue({ id: "d1", status: InvoiceStatus.DRAFT });
      prisma.orderItem.findMany.mockResolvedValue([{ id: "oi-1" }]);
      prisma.orderItem.update.mockResolvedValue({});
    };

    it("basis=order: the draft still on the Pallet pack (120) reconciles to boxes 5, pieces 0, label Case, no throw", async () => {
      armReconcile(120);
      await service.reconcileOrderDraftInvoice("o1", { basis: "order" });
      const line = prisma.invoice.update.mock.calls[0][0].data.items.create[0];
      expect(line).toMatchObject({
        unitLabel: "Case",
        qty: 60,
        boxes: 5,
        pieces: 0,
        unitsPerBox: 12,
      });
    });

    it("basis=delivered: 50 of 60 reconciles to 4 Cases + 2 pcs and invoicedQty is set to 50", async () => {
      armReconcile(120);
      await service.reconcileOrderDraftInvoice("o1", { basis: "delivered" });
      const line = prisma.invoice.update.mock.calls[0][0].data.items.create[0];
      expect(line).toMatchObject({ boxes: 4, pieces: 2, qty: 50, unitLabel: "Case" });
      expect(prisma.orderItem.update).toHaveBeenCalledWith({
        where: { id: "oi-1" },
        data: { invoicedQty: 50 },
      });
    });
  });

  describe("createInvoiceFromOrder — the remainder of a Case line (SA-178)", () => {
    const txFor = (invoicedQty: number) => {
      const txClient = {
        order: {
          findUnique: jest.fn().mockResolvedValue({
            id: "ord-c2",
            customerId: "cust-1",
            orderNumber: "ORD-C2",
            subtotal: 960,
            tax: 0,
            lineItems: [caseLine({ invoicedQty, trackedCategoryId: null, categoryTaxAmount: 0 })],
          }),
        },
        invoice: {
          findMany: jest.fn().mockResolvedValue([]),
          create: jest.fn(async (args: any) => ({
            ...args.data,
            id: "inv-c2",
            items: [],
            payments: [],
            customer: {},
          })),
        },
        customer: { findFirst: jest.fn().mockResolvedValue({ isTaxExempt: false }) },
        trackedCategory: { findMany: jest.fn().mockResolvedValue([]) },
        orderItem: {
          update: jest.fn().mockResolvedValue({}),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }), // #2612: the CAS bump
        },
        // B760: no DeliveryMutation evidence — remaining stays qty - invoicedQty.
        deliveryMutation: { findMany: jest.fn().mockResolvedValue([]) },
        $executeRaw: jest.fn().mockResolvedValue(0),
        $queryRaw: jest.fn().mockResolvedValue([]),
      };
      return txClient;
    };
    beforeEach(() => {
      jest
        .spyOn(service as any, "resolveDefaultTerms")
        .mockResolvedValue({ terms: "Net 30", dueDays: 30 });
      jest
        .spyOn(service as any, "resolveTenantInvoiceDefaults")
        .mockResolvedValue({ notes: null, terms: null, timezone: null });
    });

    it("a remainder of 52 bills 4 Cases + 4 pcs, label kept, and invoicedQty +52", async () => {
      const tx = txFor(44);
      await service.createInvoiceFromOrder("ord-c2", tx);
      const line = tx.invoice.create.mock.calls[0][0].data.items.create[0];
      expect(line).toMatchObject({ unitLabel: "Case", qty: 52, boxes: 4, pieces: 4 });
      expect(tx.orderItem.updateMany).toHaveBeenCalledWith({
        where: expect.objectContaining({ id: "oi-1", invoicedQty: 44 }),
        data: { invoicedQty: { increment: 52 } },
      });
    });

    it("a fractional remainder (47.9995) is refused with a 400 and nothing is written", async () => {
      const tx = txFor(48.0005);
      await expect(service.createInvoiceFromOrder("ord-c2", tx)).rejects.toThrow(
        "not a whole number of pieces",
      );
      expect(tx.invoice.create).not.toHaveBeenCalled();
      expect(tx.orderItem.update).not.toHaveBeenCalled();
      expect(tx.orderItem.updateMany).not.toHaveBeenCalled();
    });
  });

  describe("reconcileOrderDeliveredInvoices (completeWithPayment -> rebuildSiblingDrafts) on a unit line", () => {
    it("a delivery stop on a Case line whose open draft still carries the Pallet pack (120) completes: 50 of 60 = 4 Cases + 2 pcs, no throw", async () => {
      prisma.invoice.findMany.mockResolvedValue([
        {
          id: "d1",
          status: InvoiceStatus.DRAFT,
          deliveryBatchId: null,
          discount: 0,
          shippingFee: 0,
          dueDate: null,
          items: [{ orderItemId: "oi-1", unitsPerBox: 120 }],
        },
      ] as any);
      prisma.order.findUnique.mockResolvedValue({
        id: "ord-1",
        customerId: "cust-1",
        subtotal: 600,
        tax: 0,
        lineItems: [caseLine({ qty: 60, deliveredQty: 50, boxes: 5, subtotal: 600 })],
      } as any);
      prisma.customer.findUnique.mockResolvedValue({ isTaxExempt: false });
      prisma.customer.findFirst.mockResolvedValue({ isTaxExempt: false });
      prisma.invoiceItem.deleteMany.mockResolvedValue({});
      prisma.invoice.update.mockResolvedValue({ id: "d1", status: InvoiceStatus.DRAFT, items: [] });
      prisma.orderItem.update.mockResolvedValue({});
      prisma.orderItem.findMany.mockResolvedValue([{ id: "oi-1" }]);

      await service.reconcileOrderDeliveredInvoices("ord-1", prisma);

      const line = prisma.invoice.update.mock.calls[0][0].data.items.create[0];
      expect(line).toMatchObject({
        unitLabel: "Case",
        qty: 50,
        boxes: 4,
        pieces: 2,
        unitsPerBox: 12,
      });
    });
  });

  describe("unit-line-bill-guard helpers", () => {
    it("assertIntegerPieces ignores 0, negatives, NaN and factor <= 1", () => {
      const li = { boxes: 8, unitLabel: "Case", product: { name: "W" } };
      for (const q of [0, -5, -2.5, Number.NaN])
        expect(() => assertIntegerPieces(li, q, 12)).not.toThrow();
      expect(() => assertIntegerPieces(li, 2.5, 1)).not.toThrow();
      expect(() => assertIntegerPieces(li, 2.5, 0)).not.toThrow();
      expect(() => assertIntegerPieces(li, 2.5, 12)).toThrow("not a whole number of pieces");
      expect(() => assertIntegerPieces({ ...li, boxes: 2 }, 0.001, 12)).toThrow(
        "not a whole number of pieces",
      );
      expect(() => assertIntegerPieces({ ...li, boxes: null }, 1.5, 12)).not.toThrow();
    });

    it("billPackOf: a unit line's own pack wins, a pack line takes prior, then own, then product", () => {
      expect(billPackOf({ unitLabel: "Case", unitsPerBox: 12 }, 120)).toBe(12);
      expect(billPackOf({ unitLabel: "  ", unitsPerBox: 12 }, 120)).toBe(120);
      expect(billPackOf({ unitLabel: null, unitsPerBox: 12 })).toBe(12);
      expect(billPackOf({ unitLabel: null, unitsPerBox: null }, null, 6)).toBe(6);
    });
  });
});
