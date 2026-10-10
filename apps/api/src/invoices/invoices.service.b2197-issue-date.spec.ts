/**
 * #2197 — a client invoice issueDate is stored as the UTC-midnight stamp of the LITERAL day it
 * names (its first ten characters), never the raw instant; neither its offset nor the tenant zone
 * moves the day.
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
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";

describe("InvoicesService — #2197 issueDate is the literal calendar day", () => {
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
        entitlementAuthorityFromEntitlements, // #2241
        { provide: CommissionEngineService, useValue: mockCommissionEngine },
        { provide: NumberingService, useValue: mockNumbering },
      ],
    }).compile();

    service = module.get<InvoicesService>(InvoicesService);
  });

  // ─── #2197 — a client issueDate is stored as the UTC-midnight stamp of the LITERAL day it
  // names (its first ten characters). Neither its offset nor the tenant zone may move the day.
  describe("#2197 — issueDate is the literal calendar day the client named", () => {
    const nyDefaults = { notes: null, terms: null, timezone: "America/New_York" };
    const day25 = new Date("2026-09-25T00:00:00.000Z");

    const createWith = async (issueDate: string) => {
      prisma.customer.findUnique.mockResolvedValue({ id: "cust-1", isTaxExempt: false });
      prisma.product.findMany.mockResolvedValue([]);
      jest.spyOn(service as any, "resolveTenantInvoiceDefaults").mockResolvedValue(nyDefaults);
      prisma.invoice.create.mockResolvedValue({ id: "inv-2197", items: [], payments: [] });
      await service.create({
        customerId: "cust-1",
        issueDate,
        items: [{ description: "Widget", qty: 1, unitPrice: 10, taxRate: 0 }],
      } as any);
      return prisma.invoice.create.mock.calls[0][0].data;
    };

    it("create(): an offset different from the tenant zone keeps the literal day", async () => {
      // 23:30 at -05:00 is 04:30Z on the 26th, 00:30 on the 26th in New York (EDT).
      expect((await createWith("2026-09-25T23:30:00-05:00")).issueDate).toEqual(day25);
    });

    it("create(): an instant at exactly UTC midnight of the next day keeps the literal day", async () => {
      // 20:00 at -04:00 is 00:00Z on the 26th.
      expect((await createWith("2026-09-25T20:00:00-04:00")).issueDate).toEqual(day25);
    });

    it("create(): a bare calendar date is stored literally in a west-of-UTC tenant", async () => {
      expect((await createWith("2026-09-25")).issueDate).toEqual(day25);
    });

    it("create(): a date that names no real day is a 400 before anything is read", async () => {
      await expect(
        service.create({
          customerId: "cust-1",
          issueDate: "2026-02-31",
          items: [{ description: "Widget", qty: 1, unitPrice: 10, taxRate: 0 }],
        } as any),
      ).rejects.toThrow("issueDate must be a calendar date (YYYY-MM-DD)");
      expect(prisma.customer.findUnique).not.toHaveBeenCalled();
    });

    const draft = {
      id: "inv-2197u",
      orderId: null,
      deliveryBatchId: null,
      customerId: "cust-1",
      invoiceNumber: "INV-2026-2197",
      status: InvoiceStatus.DRAFT,
      subtotal: 10,
      taxAmount: 0,
      discount: 0,
      shippingFee: 0,
      total: 10,
      notes: null,
      terms: null,
      dueDate: null,
      issueDate: new Date("2026-09-01T00:00:00.000Z"),
    };

    it("update(): a header-only edit keeps the literal day", async () => {
      prisma.invoice.findUnique.mockResolvedValue(draft);
      prisma.invoice.update.mockResolvedValue({ id: draft.id });

      await service.update(draft.id, { issueDate: "2026-09-25T23:30:00-05:00" } as any);

      expect(prisma.invoice.update.mock.calls[0][0].data.issueDate).toEqual(day25);
    });

    it("update() WITH items: the item-rewrite write keeps the literal day too", async () => {
      const row = {
        id: "item-1",
        productId: null,
        description: "Widget",
        qty: 1,
        boxes: null,
        pieces: null,
        unitPrice: 10,
        discount: 0,
        taxRate: 0,
        subtotal: 10,
        unitsPerBox: null,
        categoryTaxAmount: 0,
        notes: null,
        orderItemId: null,
      };
      prisma.invoice.findUnique.mockResolvedValue(draft);
      prisma.product.findMany.mockResolvedValue([]);
      prisma.trackedCategory.findMany.mockResolvedValue([]);
      prisma.invoiceItem.findMany.mockResolvedValue([row]);
      prisma.customer.findUnique.mockResolvedValue({ isTaxExempt: false });
      prisma.invoice.update.mockResolvedValue(draft);
      prisma.invoiceItem.update.mockResolvedValue({});

      await service.update(draft.id, {
        issueDate: "2026-09-25T20:00:00-04:00",
        items: [{ id: "item-1", description: "Widget", qty: 1, unitPrice: 10 }],
      } as any);

      expect(prisma.invoice.update.mock.calls[0][0].data.issueDate).toEqual(day25);
    });
  });
});
