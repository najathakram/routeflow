/**
 * W-1487 (R-345 F2): the term readers in invoices.service.ts must take Net 7, Net 90 and a custom "Net N"
 * (the old five-term table sent them to the 30-day fallback). Pins createInvoiceFromOrderWithTenant (customer
 * terms, tenant default) and resolveDefaultTerms (tenant default with and without a customer override).
 *
 * Same bootstrap as invoices.service.b2493-due-dates.spec.ts, duplicated deliberately so this file is self-contained.
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

describe("InvoicesService: payment-term readers take Net 7, Net 90 and a custom Net N (W-1487)", () => {
  let service: InvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;

  const mockSystemConfig = {
    get: jest.fn().mockResolvedValue(null),
    getAll: jest.fn().mockResolvedValue({}),
    set: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    fillSparseCasBasis();
    mockSystemConfig.get.mockReset().mockResolvedValue(null);
    prisma = createMockPrisma();
    prisma.tenantTransaction.mockImplementation((fn: any) => fn(prisma));
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
        {
          provide: RouteFlowGateway,
          useValue: {
            emitInvoiceUpdated: jest.fn(),
            emitOrderCreated: jest.fn(),
            emitOrderStatusChanged: jest.fn(),
            emitLowStock: jest.fn(),
            emitStopCompleted: jest.fn(),
            emitUrgentOrder: jest.fn(),
          },
        },
        {
          provide: EmailService,
          useValue: {
            sendInvoice: jest.fn().mockResolvedValue({ delivered: true, transport: "resend" }),
            isEmailConfigured: jest.fn().mockResolvedValue(true),
          },
        },
        { provide: InvoicePdfService, useValue: { getOrGenerate: jest.fn() } },
        { provide: SystemConfigService, useValue: mockSystemConfig },
        {
          provide: RegulatedLedgerService,
          useValue: {
            writeSaleEntries: jest.fn(),
            reverseInvoiceEntries: jest.fn(),
            settleRegulatedLedger: jest.fn().mockResolvedValue({ written: 0, amendedPeriod: null }),
          },
        },
        {
          provide: AuthorizationGuardService,
          useValue: {
            assertAuthorizedOrThrow: jest.fn().mockResolvedValue(undefined),
            checkAuthorized: jest.fn().mockResolvedValue({ blocked: [] }),
          },
        },
        {
          provide: CreditNotesService,
          useValue: {
            autoApplyOldestCreditsInTx: jest
              .fn()
              .mockResolvedValue({ applied: 0, invoiceStatus: null }),
            settleOrderCreditsInTx: jest.fn().mockResolvedValue({ applied: 0, unapplied: 0 }),
            releaseInvoiceCreditsInTx: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: MessagingService,
          useValue: {
            notify: jest.fn().mockResolvedValue([]),
            notifyEvent: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: StorageService,
          useValue: {
            upload: jest.fn().mockResolvedValue("stored"),
            presignedUrl: jest.fn().mockResolvedValue("https://signed/url"),
            delete: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        entitlementAuthorityFromEntitlements,
        {
          provide: CommissionEngineService,
          useValue: {
            syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined),
            syncOrderInvoices: jest.fn().mockResolvedValue(undefined),
            removeInvoiceCommission: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: NumberingService,
          useValue: { reserveNext: jest.fn().mockResolvedValue("INV-1") },
        },
      ],
    }).compile();

    service = module.get<InvoicesService>(InvoicesService);
  });

  // ── createInvoiceFromOrderWithTenant ──────────────────────────────────────────────────────────
  const ORDER_DAY = new Date("2026-09-01T00:00:00.000Z");
  const orderWith = () => ({
    id: "ord-1487",
    customerId: "cust-1",
    orderNumber: "ORD-1487",
    orderDate: ORDER_DAY,
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
  });

  const seedFromOrder = (customerTerms: string | null, tenantDefault: string | null) => {
    jest
      .spyOn(service as any, "resolveTenantInvoiceDefaults")
      .mockResolvedValue({ notes: null, terms: null, timezone: "America/Los_Angeles" });
    jest.spyOn(service as any, "generateInvoiceNumber").mockResolvedValue("INV-1487");
    prisma.customer.findUnique.mockResolvedValue({ isTaxExempt: false });
    prisma.customer.findFirst.mockResolvedValue({
      isTaxExempt: false,
      defaultPaymentTerms: customerTerms,
    });
    prisma.orderItem.update.mockResolvedValue({});
    prisma.invoice.aggregate.mockResolvedValue({ _sum: { shippingFee: 0 } });
    prisma.systemConfig.findFirst.mockResolvedValue(
      tenantDefault ? { value: tenantDefault } : null,
    );
    prisma.tenantConfig.findUnique.mockResolvedValue(null);
    prisma.order.findFirst.mockResolvedValue(orderWith());
    prisma.invoice.create.mockImplementation((args: any) =>
      Promise.resolve({ ...args.data, id: "inv-1487", items: [], payments: [], customer: {} }),
    );
  };

  describe("createInvoiceFromOrderWithTenant", () => {
    it.each([
      ["a customer on Net 7", "Net 7", null, "2026-09-08"],
      ["a customer on a custom Net 21", "Net 21", null, "2026-09-22"],
      ["a tenant default of Net 90, no customer terms", null, "Net 90", "2026-11-30"],
      ["a tenant default of a custom Net 21, no customer terms", null, "Net 21", "2026-09-22"],
    ])("%s stores that due date and label", async (_name, customerTerms, tenantDefault, due) => {
      seedFromOrder(customerTerms, tenantDefault);
      await service.createInvoiceFromOrderWithTenant("ord-1487", "acme-tenant");
      const data = prisma.invoice.create.mock.calls[0][0].data;
      expect(data.paymentTermsLabel).toBe(customerTerms ?? tenantDefault);
      expect(data.dueDate).toEqual(new Date(`${due}T00:00:00.000Z`));
    });
  });

  // ── resolveDefaultTerms ───────────────────────────────────────────────────────────────────────
  describe("resolveDefaultTerms", () => {
    it.each([
      ["Net 90", 90],
      ["Net 21", 21],
    ])(
      "a tenant default of %s with no customer override resolves %i days",
      async (tenant, days) => {
        mockSystemConfig.get.mockResolvedValue(tenant);
        prisma.customer.findFirst.mockResolvedValue({
          defaultPaymentTerms: null,
          defaultDepositPercent: null,
        });
        const out = await service.resolveDefaultTerms("cust-1");
        expect(out.terms).toBe(tenant);
        expect(out.dueDays).toBe(days);
      },
    );

    it.each([
      ["Net 90", 90],
      ["Net 21", 21],
    ])("a tenant default of %s with no customer id resolves %i days", async (tenant, days) => {
      mockSystemConfig.get.mockResolvedValue(tenant);
      const out = await service.resolveDefaultTerms();
      expect(out.terms).toBe(tenant);
      expect(out.dueDays).toBe(days);
    });

    it.each([
      ["Net 7", 7],
      ["Net 21", 21],
    ])("a customer on %s wins over the tenant default (%i days)", async (customer, days) => {
      mockSystemConfig.get.mockResolvedValue("Net 90");
      prisma.customer.findFirst.mockResolvedValue({
        defaultPaymentTerms: customer,
        defaultDepositPercent: null,
      });
      const out = await service.resolveDefaultTerms("cust-1");
      expect(out.terms).toBe(customer);
      expect(out.dueDays).toBe(days);
    });
  });
});
