/**
 * B670 (SA-180) — update()'s regulated-levy basis reads the SAME resolved pack the money uses.
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

describe("InvoicesService — B670 update() levy-basis pack", () => {
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

  describe("update() — the levy basis uses the resolved pack, not the live product alone", () => {
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
    const arrange = (storedPack: number | null) => {
      prisma.invoice.findUnique.mockResolvedValue(draftInvoice);
      // the product's pack has since changed to 6; the invoice's own stored line still says 12
      prisma.product.findMany.mockResolvedValue([
        { id: "prod-box", unitsPerBox: 6, trackedCategoryId: "cat-1" },
      ]);
      prisma.trackedCategory.findMany.mockResolvedValue([
        { id: "cat-1", taxType: "EXCISE_PER_UNIT", rate: 0.1, priceIncludesTax: false },
      ]);
      prisma.invoiceItem.findMany.mockResolvedValue(
        storedPack == null ? [] : [{ productId: "prod-box", unitsPerBox: storedPack }],
      );
      prisma.customer.findUnique.mockResolvedValue({ isTaxExempt: false });
      prisma.invoice.update.mockResolvedValue(draftInvoice);
    };
    const saved = () => prisma.invoice.update.mock.calls[0][0].data.items.create[0];

    it("stored pack 12, live pack 6, a no-change save of a box-unaware line: basis = qty x 12 (levy 6.00, not 3.00)", async () => {
      arrange(12);
      await service.update("inv-box", {
        items: [{ productId: "prod-box", description: "Chips", qty: 5, unitPrice: 10 }],
      });
      // 5 selling units x stored pack 12 = 60 pieces x $0.10 = $6.00 (was 5 x 6 x 0.10 = $3.00)
      expect(saved().categoryTaxAmount).toBe(6);
    });

    it("no stored pack: falls back to the live pack 6 (levy 3.00), unchanged behaviour", async () => {
      arrange(null);
      await service.update("inv-box", {
        items: [{ productId: "prod-box", description: "Chips", qty: 5, unitPrice: 10 }],
      });
      expect(saved().categoryTaxAmount).toBe(3);
    });

    it("a split line (2 boxes + 3 pieces, qty 27) already counts pieces: levy 2.70 whatever the packs say", async () => {
      arrange(12);
      await service.update("inv-box", {
        items: [
          {
            productId: "prod-box",
            description: "Chips",
            qty: 27,
            unitPrice: 28.35,
            boxes: 2,
            pieces: 3,
          },
        ],
      });
      expect(saved().categoryTaxAmount).toBe(2.7);
      expect(saved().unitsPerBox).toBe(12); // money + snapshot still from the line's own split
    });
  });
});
