/**
 * F5 (shipping-flow polish): the invoice auto-created at shipment or delivery (the fire-and-forget
 * `createInvoiceFromOrderWithTenant` path) must carry the order's carrier / tracking / ship date, as
 * `createInvoiceFromOrder` already does, so the PDF and the Shipments page show them. An order with no
 * shipment leaves the create payload exactly as before (no shipping keys at all).
 * Bootstrap duplicated from invoices.service.b2493-due-dates.spec.ts so this file stays self-contained.
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

import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";
import { fillSparseCasBasis } from "./testing/sparse-line-fixtures";

describe("InvoicesService.createInvoiceFromOrderWithTenant — carrier shipment copy (F5)", () => {
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
    prisma.orderItem.updateMany.mockResolvedValue({ count: 1 } as never);
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
        { provide: EntitlementsService, useValue: mockEntitlements },
        entitlementAuthorityFromEntitlements, // #2241
        { provide: CommissionEngineService, useValue: mockCommissionEngine },
        { provide: NumberingService, useValue: mockNumbering },
      ],
    }).compile();

    service = module.get<InvoicesService>(InvoicesService);
  });

  // the three private helpers this spec stubs
  const priv = () =>
    service as unknown as {
      resolveDefaultTerms: () => Promise<unknown>;
      resolveTenantInvoiceDefaults: () => Promise<unknown>;
      generateInvoiceNumber: () => Promise<string>;
    };

  const orderWith = (over: Record<string, unknown> = {}) => ({
    id: "ord-f5",
    customerId: "cust-1",
    orderNumber: "ORD-F5",
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
        unitsPerBox: null,
        unitPrice: 10,
        subtotal: 20,
        originalPrice: null,
        priceType: "STANDARD",
        product: { name: "Widget", unitsPerBox: 0 },
      },
    ],
    ...over,
  });

  const seed = () => {
    jest.spyOn(priv(), "resolveDefaultTerms").mockResolvedValue({ terms: "Net 30", dueDays: 30 });
    jest
      .spyOn(priv(), "resolveTenantInvoiceDefaults")
      .mockResolvedValue({ notes: null, terms: null, timezone: "America/Los_Angeles" });
    jest.spyOn(priv(), "generateInvoiceNumber").mockResolvedValue("INV-F5");
    prisma.customer.findUnique.mockResolvedValue({ isTaxExempt: false });
    prisma.customer.findFirst.mockResolvedValue({ isTaxExempt: false, defaultPaymentTerms: null });
    prisma.orderItem.update.mockResolvedValue({});
    prisma.invoice.aggregate.mockResolvedValue({ _sum: { shippingFee: 0 } });
    prisma.systemConfig.findFirst.mockResolvedValue(null);
    prisma.tenantConfig.findUnique.mockResolvedValue(null);
    prisma.invoice.create.mockImplementation((args: { data: Record<string, unknown> }) =>
      Promise.resolve({ ...args.data, id: "inv-f5", items: [], payments: [], customer: {} }),
    );
  };

  it("an order with carrier + tracking: the invoice carries carrier, tracking and ship date", async () => {
    seed();
    const shippedAt = new Date("2026-06-20T00:00:00.000Z");
    prisma.order.findFirst.mockResolvedValue(
      orderWith({ shippingCarrier: "UPS", shippingTrackingNumber: "1Z999", shippedAt }),
    );
    await service.createInvoiceFromOrderWithTenant("ord-f5", "test-tenant");
    const data = prisma.invoice.create.mock.calls[0][0].data;
    expect(data.shippingCarrier).toBe("UPS");
    expect(data.shippingTrackingNumber).toBe("1Z999");
    expect(data.shippedAt).toEqual(shippedAt);
  });

  it("an order without a shipment: the create payload has no shipping keys (unchanged)", async () => {
    seed();
    prisma.order.findFirst.mockResolvedValue(
      orderWith({ shippingCarrier: null, shippingTrackingNumber: null, shippedAt: null }),
    );
    await service.createInvoiceFromOrderWithTenant("ord-f5", "test-tenant");
    const data = prisma.invoice.create.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("shippingCarrier");
    expect(data).not.toHaveProperty("shippingTrackingNumber");
    expect(data).not.toHaveProperty("shippedAt");
  });
});
