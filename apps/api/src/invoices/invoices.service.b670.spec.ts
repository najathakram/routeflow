/**
 * B670/B701/B674 (SA-144) — invoice update() refuses to edit an invoice that holds a unit-aware line.
 *
 * Split out of invoices.service.spec.ts (not merged into it) per the repo's size ratchet
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

describe("InvoicesService — B670/B701/B674 update() unit fence", () => {
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

  describe("update() — unit-aware fence (SA-144)", () => {
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

    // SA-144: a unit-aware line (sold by a named unit, e.g. "Case") has no legacy boxes/pieces
    // pack to re-derive — update()'s replace path must refuse rather than silently reinterpret
    // it. The client rarely resends `unitLabel` on an edit it isn't touching, so this is checked
    // against the invoice's OWN surviving stored row, not just the incoming payload.
    it("SA-144: refuses to edit an invoice that already has a unit-aware line for a touched product, even when the payload itself carries no unitLabel", async () => {
      prisma.invoice.findUnique.mockResolvedValue(draftInvoice);
      prisma.product.findMany.mockResolvedValue([{ id: "prod-case", unitsPerBox: 12 }]);
      prisma.customer.findUnique.mockResolvedValue({ isTaxExempt: false });
      // The invoice's OWN stored line for this product already sells by a named unit.
      prisma.invoiceItem.findMany.mockResolvedValue([
        { productId: "prod-case", unitsPerBox: 288, unitLabel: "Case" },
      ]);

      await expect(
        service.update("inv-box", {
          items: [
            {
              productId: "prod-case",
              description: "Case of chips",
              qty: 2,
              unitPrice: 11,
              boxes: 2,
            },
          ],
        }),
      ).rejects.toThrow("Selling by a unit can't be edited on an invoice yet.");

      expect(prisma.invoice.update).not.toHaveBeenCalled();
    });

    it("SA-144: an ordinary boxed line's own stored row (no unitLabel) does not trip the unit-aware fence", async () => {
      prisma.invoice.findUnique.mockResolvedValue(draftInvoice);
      prisma.product.findMany.mockResolvedValue([{ id: "prod-box", unitsPerBox: 12 }]);
      prisma.customer.findUnique.mockResolvedValue({ isTaxExempt: false });
      prisma.invoice.update.mockResolvedValue(draftInvoice);
      prisma.invoiceItem.findMany.mockResolvedValue([
        { productId: "prod-box", unitsPerBox: 12, unitLabel: null },
      ]);

      await service.update("inv-box", {
        items: [
          {
            productId: "prod-box",
            description: "Boxed chips",
            qty: 27,
            unitPrice: 28.35,
            boxes: 2,
            pieces: 3,
          },
        ],
      });

      expect(prisma.invoice.update).toHaveBeenCalled();
    });
  });
});
