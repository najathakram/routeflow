/**
 * B652 (SA-176) — a unit (Case) line is billed in whole units only.
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
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { InvoiceStatus } from "@prisma/client";

describe("InvoicesService — B652 partial billing of a unit line", () => {
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
    prisma = createMockPrisma();
    prisma.invoice.findFirst.mockResolvedValue({ items: [] });

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
        { provide: EntitlementsService, useValue: mockEntitlements },
        { provide: CommissionEngineService, useValue: mockCommissionEngine },
        { provide: NumberingService, useValue: mockNumbering },
      ],
    }).compile();

    service = module.get<InvoicesService>(InvoicesService);
  });

  describe("createPartialFromOrder — a unit line's quantity is a count of its unit (SA-176)", () => {
    const caseOrder = (over: any = {}) => ({
      id: "ord-c1",
      customerId: "cust-1",
      orderNumber: "ORD-C1",
      subtotal: 960,
      tax: 0,
      shippingFee: 0,
      lineItems: [
        {
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
        },
      ],
    });

    beforeEach(() => {
      prisma.customer.findUnique.mockResolvedValue({ isTaxExempt: false } as any);
      prisma.invoice.aggregate.mockResolvedValue({ _sum: { shippingFee: 0 } });
      prisma.invoice.create.mockImplementation((args: any) =>
        Promise.resolve({ ...args.data, items: [], payments: [], customer: {} }),
      );
      prisma.orderItem.update.mockResolvedValue({} as any);
    });

    it("REFUSES 52 pieces of a 12-per-Case line (400) and writes nothing", async () => {
      prisma.order.findUnique.mockResolvedValue(caseOrder());
      await expect(
        service.createPartialFromOrder("ord-c1", {
          items: [{ orderItemId: "oi-1", qty: 52 }],
        } as any),
      ).rejects.toThrow(/whole Case|Case/);
      expect(prisma.invoice.create).not.toHaveBeenCalled();
      expect(prisma.orderItem.update).not.toHaveBeenCalled();
    });

    it("the refusal names the Case size and the nearest whole-Case quantities (48 and 60)", async () => {
      prisma.order.findUnique.mockResolvedValue(caseOrder());
      await expect(
        service.createPartialFromOrder("ord-c1", {
          items: [{ orderItemId: "oi-1", qty: 52 }],
        } as any),
      ).rejects.toThrow(/12.*48.*60/s);
    });

    it("48 pieces (4 whole Cases) bills boxes 4, pieces 0, keeps the Case label, money prorated", async () => {
      prisma.order.findUnique.mockResolvedValue(caseOrder());
      await service.createPartialFromOrder("ord-c1", {
        items: [{ orderItemId: "oi-1", qty: 48 }],
      } as any);
      const line = prisma.invoice.create.mock.calls[0][0].data.items.create[0];
      expect(line).toMatchObject({
        unitLabel: "Case",
        qty: 48,
        boxes: 4,
        pieces: 0,
        unitsPerBox: 12,
      });
      expect(Number(line.subtotal)).toBe(480); // 4 of 8 Cases at $120
    });

    it("a PACK line (no unitLabel) at 52 is unchanged: 4 boxes + 4 pieces", async () => {
      prisma.order.findUnique.mockResolvedValue(caseOrder({ unitLabel: null }));
      await service.createPartialFromOrder("ord-c1", {
        items: [{ orderItemId: "oi-1", qty: 52 }],
      } as any);
      const line = prisma.invoice.create.mock.calls[0][0].data.items.create[0];
      expect(line).toMatchObject({ qty: 52, boxes: 4, pieces: 4 });
    });

    it("the guard reads the LINE's own unitsPerBox, never the live product's", async () => {
      // line snapshot 12, product now 6: 48 is a multiple of the line's 12, 30 is not (30 is a multiple of 6).
      prisma.order.findUnique.mockResolvedValue(
        caseOrder({ product: { name: "Widget", unitsPerBox: 6 } }),
      );
      await expect(
        service.createPartialFromOrder("ord-c1", {
          items: [{ orderItemId: "oi-1", qty: 30 }],
        } as any),
      ).rejects.toThrow();
    });
  });
});
