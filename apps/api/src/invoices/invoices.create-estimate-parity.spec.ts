/**
 * H5 parity pin (SA must 3): an estimate and an invoice built from the SAME lines at the SAME tenant rate and exempt
 * flag carry the same subtotal, tax and total - so a quote converted at an unchanged rate can never move. Own file
 * (the invoice/estimate specs are on the size ratchet); same bootstrap as the NSF spec.
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
import { EstimatesService } from "../estimates/estimates.service";
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
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { InvoiceStatus } from "@prisma/client";
import { BadRequestException } from "@nestjs/common";
import { NSF_FEE_DESCRIPTION_PREFIX } from "@routeflow/pricing";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";

describe("H5 - an estimate is taxed like an invoice (create parity)", () => {
  let service: InvoicesService;
  let estimates: EstimatesService;
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
    // #2070: createPartialFromOrder's invoicedQty bump is a CAS (updateMany); a clean read matches 1.
    prisma.orderItem.updateMany.mockResolvedValue({ count: 1 } as any);
    prisma.invoice.findFirst.mockResolvedValue({ items: [] });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: EntitlementAuthority, useValue: { can: jest.fn().mockResolvedValue(false) } },
        InvoicesService,
        EstimatesService,
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
    estimates = module.get<EstimatesService>(EstimatesService);
  });

  const LINES = [
    { description: "A", unitPrice: 10, qty: 3 }, // 30.00
    { description: "B", unitPrice: 20.55, qty: 1 }, // 20.55
    { description: "C", unitPrice: 0.05, qty: 1 }, // 0.05
  ];

  const setup = (percent: string, exempt: boolean) => {
    (prisma as any).systemConfig.findFirst.mockResolvedValue({ value: percent });
    const customer = { id: "cust-1", businessName: "Acme", pricingTier: 1, isTaxExempt: exempt };
    prisma.customer.findUnique.mockResolvedValue(customer);
    prisma.product.findMany.mockResolvedValue([]);
    jest.spyOn(service as any, "resolveTenantInvoiceDefaults").mockResolvedValue({
      notes: null,
      terms: null,
    });
    prisma.estimate.create.mockImplementation((args: any) =>
      Promise.resolve({ id: "est-1", ...args.data }),
    );
    prisma.invoice.create.mockImplementation((args: any) =>
      Promise.resolve({ id: "inv-1", ...args.data, customer, items: [], payments: [] }),
    );
  };

  it.each([
    ["8.25", false],
    ["5", false],
    ["7.125", false],
    ["8.25", true],
    ["0", false],
  ])(
    "rate %s%% exempt=%s: an estimate's tax and total equal an invoice's for the SAME lines (H5 parity)",
    async (percent, exempt) => {
      setup(percent, exempt);
      const rate = Number(percent) / 100;

      await estimates.create({ customerId: "cust-1", items: LINES } as any);
      await service.create({
        customerId: "cust-1",
        // an invoice line carries the tenant rate the web form stamps on it (Settings -> tax rate)
        items: LINES.map((l) => ({ ...l, taxRate: rate })),
      } as any);

      const quote = prisma.estimate.create.mock.calls[0][0].data;
      const invoice = prisma.invoice.create.mock.calls[0][0].data;
      expect(Number(quote.subtotal)).toBe(Number(invoice.subtotal));
      expect(Number(quote.taxAmount)).toBe(Number(invoice.taxAmount));
      expect(Number(quote.total)).toBe(Number(invoice.total));
    },
  );
});
