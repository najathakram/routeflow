/**
 * B653 — sendEmail/sendReminder thread boxes/pieces/unitLabel to the email payload.
 *
 * Split out of invoices.service.spec.ts (not merged into it) per the repo's size ratchet
 * (`common/size-ratchet.spec.ts` — that file is one of the 15 tracked giants and may not grow;
 * origin/master's copy is already at its exact baseline+headroom ceiling). Same bootstrap
 * pattern as the main spec file and invoices.service.b661.spec.ts; duplicated deliberately
 * rather than shared, so this file stays self-contained and small.
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
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";

describe("InvoicesService — B653 (email qty fields)", () => {
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
    prisma.invoicePayment.findMany.mockResolvedValue([]);
    prisma.invoicePayment.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
    mockEmailService.sendInvoice.mockClear();

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

  // 3 Cases of 12 at $40/Case — buildInvoiceUnitLine's actual stored shape for a
  // units_v1 line: boxes = unit count, pieces = 0, qty = the base piece count (36).
  const UNIT_ITEM = {
    description: "Widget (Case)",
    qty: 36,
    unitPrice: 40,
    subtotal: 120,
    msrp: null,
    boxes: 3,
    pieces: 0,
    unitLabel: "Case",
  };

  const expectedItem = () =>
    expect.objectContaining({
      description: "Widget (Case)",
      boxes: 3,
      pieces: 0,
      unitLabel: "Case",
    });

  function mockInvoice(items: unknown[], overrides: Record<string, unknown> = {}) {
    prisma.invoice.findUnique.mockImplementation(async () => ({
      id: "inv-b653",
      orderId: null,
      invoiceNumber: "INV-2004",
      status: InvoiceStatus.SENT,
      deliveryBatchId: null,
      total: 120,
      subtotal: 120,
      taxAmount: 0,
      discount: 0,
      shippingFee: 0,
      depositPercent: null,
      depositDueDate: null,
      paymentTermsLabel: null,
      issueDate: new Date("2026-01-01"),
      dueDate: new Date("2026-01-31"),
      customer: { id: "c-b653", businessName: "Acme Buyer", email: "buyer@example.com" },
      items,
      payments: [],
      ...overrides,
    }));
    prisma.invoice.update.mockResolvedValue({
      id: "inv-b653",
      invoiceNumber: "INV-2004",
      customerId: "c-b653",
      orderId: null,
      status: InvoiceStatus.SENT,
      total: 120,
      dueDate: null,
    });
  }

  it("REG-B653-invoices: sendEmail forwards boxes/pieces/unitLabel on the item row", async () => {
    mockInvoice([UNIT_ITEM]);

    await service.sendEmail("inv-b653");

    expect(mockEmailService.sendInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ items: [expectedItem()], isReminder: false }),
    );
  });

  it("REG-B653-invoices: sendReminder forwards them too", async () => {
    mockInvoice([UNIT_ITEM]);

    await service.sendReminder("inv-b653");

    expect(mockEmailService.sendInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ items: [expectedItem()], isReminder: true }),
    );
  });

  it("PIN-B653-invoices: an ordinary line with no boxes/pieces forwards them as null, not undefined", async () => {
    mockInvoice([{ description: "Widget", qty: 5, unitPrice: 10, subtotal: 50, msrp: null }]);

    await service.sendEmail("inv-b653");

    expect(mockEmailService.sendInvoice).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [expect.objectContaining({ boxes: null, pieces: null, unitLabel: null })],
      }),
    );
  });
});
