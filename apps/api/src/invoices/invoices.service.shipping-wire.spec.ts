/**
 * Fold 1: the invoice LIST (Shipments pages) carries the linked order's status, so a list can hide the
 * shipped date of an unmarked order.
 *
 * F3 (shipping-flow polish): the invoice detail carries the server's default PDF stage as `pdfVariant`
 * (web and mobile read it): a DRAFT invoice of a shipped SHIP order of a shipping business is "final";
 * every other invoice keeps today's stage.
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
import { FeatureConfigService } from "../billing/feature-config.service";
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

describe("InvoicesService — shipping fields on the wire (F3, fold 1)", () => {
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
  const mockMode = jest.fn();
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
        { provide: FeatureConfigService, useValue: { getEffectiveMode: mockMode } },
      ],
    }).compile();

    service = module.get<InvoicesService>(InvoicesService);
  });

  const invoice = (order: Record<string, unknown> | null, over: Record<string, unknown> = {}) => ({
    id: "inv-1",
    tenantId: "tenant-1",
    orderId: order ? "ord-1" : null,
    deliveryBatchId: null,
    status: "DRAFT",
    total: 10,
    subtotal: 10,
    taxAmount: 0,
    discount: 0,
    shippingFee: 0,
    items: [],
    payments: [],
    customer: { id: "c1" },
    order,
    ...over,
  });
  const detail = async (mode: string, inv: ReturnType<typeof invoice>) => {
    mockMode.mockResolvedValue(mode);
    prisma.invoice.findUnique.mockResolvedValue(inv as never);
    return service.findOne("inv-1");
  };
  const shipped = {
    status: "OUT_FOR_DELIVERY",
    fulfillPath: "SHIP",
    orderNumber: "ORD-1",
    shippedAt: new Date("2026-06-20T00:00:00.000Z"),
  };

  it("a shipment invoice (shipped SHIP order, shipping business) carries pdfVariant 'final', not a pending mirror", async () => {
    const res = await detail("ship", invoice(shipped));
    expect(res.pdfVariant).toBe("final");
    expect(res.pendingMirror).toBe(false);
  });

  it("unchanged: an unset-mode business keeps 'draft' (and the pending-mirror lock)", async () => {
    const res = await detail("unset", invoice(shipped));
    expect(res.pdfVariant).toBe("draft");
    expect(res.pendingMirror).toBe(true);
  });

  it("unchanged: an issued invoice is 'final'; a DELIVERED order's draft is 'final'", async () => {
    expect((await detail("unset", invoice(shipped, { status: "SENT" }))).pdfVariant).toBe("final");
    expect(
      (await detail("unset", invoice({ ...shipped, status: "DELIVERED", fulfillPath: "ROUTE" })))
        .pdfVariant,
    ).toBe("final");
  });

  it("unchanged: a standalone draft (no order) is 'draft'", async () => {
    expect((await detail("ship", invoice(null))).pdfVariant).toBe("draft");
  });

  it("the invoice list selects the linked order's status (Shipments pages, fold 1)", async () => {
    prisma.invoice.findMany.mockResolvedValue([] as never);
    prisma.invoice.count.mockResolvedValue(0 as never);
    await service.findAll({ shipped: true } as never);
    const args = prisma.invoice.findMany.mock.calls[0][0] as {
      include: { order?: { select: { status: boolean } } };
    };
    // + counterSale (row 401: the list row's paid-at-sale flag); the status the Shipments pages read stays
    expect(args.include.order).toEqual({ select: { status: true, counterSale: true } });
  });
});
