/**
 * #2197 — a client invoice issueDate with a time component is stored as the TENANT-local calendar
 * day's UTC-midnight stamp, never the raw instant.
 *
 * Split out of invoices.service.spec.ts (not merged into it) per the repo's size ratchet
 * (`common/size-ratchet.spec.ts`). Same bootstrap as invoices.service.b670.spec.ts, duplicated
 * deliberately so this file stays self-contained.
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
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { InvoiceStatus } from "@prisma/client";

describe("InvoicesService — #2197 issueDate is the tenant calendar-day stamp", () => {
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
        { provide: EntitlementsService, useValue: mockEntitlements },
        { provide: CommissionEngineService, useValue: mockCommissionEngine },
        { provide: NumberingService, useValue: mockNumbering },
      ],
    }).compile();

    service = module.get<InvoicesService>(InvoicesService);
  });

  // ─── #2197 — a client issueDate with a time component is stored as the
  // TENANT-local calendar day's UTC-midnight stamp, never the raw instant.
  describe("#2197 — issueDate is normalized to the tenant's calendar-day stamp", () => {
    const nyDefaults = { notes: null, terms: null, timezone: "America/New_York" };

    it("create(): 23:30 New York on the 25th stores 2026-09-25, not the raw 03:30Z instant", async () => {
      prisma.customer.findUnique.mockResolvedValue({ id: "cust-1", isTaxExempt: false });
      prisma.product.findMany.mockResolvedValue([]);
      jest.spyOn(service as any, "resolveTenantInvoiceDefaults").mockResolvedValue(nyDefaults);
      prisma.invoice.create.mockResolvedValue({ id: "inv-2197", items: [], payments: [] });

      await service.create({
        customerId: "cust-1",
        issueDate: "2026-09-25T23:30:00-04:00",
        items: [{ description: "Widget", qty: 1, unitPrice: 10, taxRate: 0 }],
      } as any);

      const data = prisma.invoice.create.mock.calls[0][0].data;
      expect(data.issueDate).toEqual(new Date("2026-09-25T00:00:00.000Z"));
    });

    it("create(): a bare calendar date is stored literally in a west-of-UTC tenant", async () => {
      prisma.customer.findUnique.mockResolvedValue({ id: "cust-1", isTaxExempt: false });
      prisma.product.findMany.mockResolvedValue([]);
      jest.spyOn(service as any, "resolveTenantInvoiceDefaults").mockResolvedValue(nyDefaults);
      prisma.invoice.create.mockResolvedValue({ id: "inv-2197b", items: [], payments: [] });

      await service.create({
        customerId: "cust-1",
        issueDate: "2026-09-25",
        items: [{ description: "Widget", qty: 1, unitPrice: 10, taxRate: 0 }],
      } as any);

      const data = prisma.invoice.create.mock.calls[0][0].data;
      expect(data.issueDate).toEqual(new Date("2026-09-25T00:00:00.000Z"));
    });

    it("update(): a header-only edit with a time component stores the tenant-local day", async () => {
      prisma.invoice.findUnique.mockResolvedValue({
        id: "inv-2197u",
        orderId: null,
        customerId: "cust-1",
        status: InvoiceStatus.DRAFT,
        subtotal: 10,
        taxAmount: 0,
        discount: 0,
        shippingFee: 0,
        total: 10,
        issueDate: new Date("2026-09-01T00:00:00.000Z"),
      });
      jest.spyOn(service as any, "resolveTenantInvoiceDefaults").mockResolvedValue(nyDefaults);
      prisma.invoice.update.mockResolvedValue({ id: "inv-2197u" });

      await service.update("inv-2197u", { issueDate: "2026-09-25T23:30:00-04:00" } as any);

      const data = prisma.invoice.update.mock.calls[0][0].data;
      expect(data.issueDate).toEqual(new Date("2026-09-25T00:00:00.000Z"));
    });
  });
});
