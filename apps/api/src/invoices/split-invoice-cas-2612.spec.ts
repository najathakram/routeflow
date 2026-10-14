/**
 * #2612 (tier 1, the sibling of #2070 / SA-523): `createSplitInvoices`, the full-order / split path
 * behind `createInvoiceFromOrder`, read `qty − invoicedQty` before its transaction and bumped
 * `invoicedQty` unconditionally inside it, so two concurrent creations (or one racing a partial)
 * over-billed the line. It now uses the same compare-and-set as partials (`bumpInvoicedQtyCas`):
 * a miss is a 409 and every sibling invoice of the creation rolls back. The real-PG race is
 * split-invoice-cas-2612.db.spec.ts. Red-first. Bootstrap copied from partial-invoice-cas-2070.spec.ts.
 */

jest.mock("./invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://example.com/invoice.pdf"),
  })),
}));

jest.mock("../storage/compress.util", () => ({
  compressDocument: jest.fn(),
}));

import { Test, TestingModule } from "@nestjs/testing";
import { ConflictException } from "@nestjs/common";
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
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { INVOICE_LINE_CAS_FIELDS } from "./partial-invoice-cas";

describe("split/full invoices: the invoicedQty bump is a compare-and-set (#2612, SA-523)", () => {
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
    // #2070: createPartialFromOrder's invoicedQty bump is a CAS (updateMany); a clean read matches 1.
    prisma.orderItem.updateMany.mockResolvedValue({ count: 1 } as any);
    prisma.invoice.findFirst.mockResolvedValue({ items: [] });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: EntitlementAuthority, useValue: { can: jest.fn().mockResolvedValue(false) } },
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
        entitlementAuthorityFromEntitlements, // #2241: EntitlementAuthority
        { provide: CommissionEngineService, useValue: mockCommissionEngine },
        { provide: NumberingService, useValue: mockNumbering },
      ],
    }).compile();

    service = module.get<InvoicesService>(InvoicesService);
  });

  const line = (over: any = {}) => ({
    id: "oi-1",
    productId: "p-1",
    qty: 96,
    invoicedQty: 0,
    boxes: 96,
    pieces: 0,
    unitsPerBox: 1,
    unitPrice: 10,
    subtotal: 960,
    status: "PENDING",
    // #2645 / SA-523d: a real row carries every CAS basis column (the read is an `include`).
    promoFreeUnits: null,
    categoryTaxAmount: 0,
    categoryTaxType: null,
    categoryTaxRate: null,
    categoryPriceIncludesTax: null,
    unitLabel: null,
    originalPrice: null,
    overrideReason: null, // H3b: a real OrderItem row always carries both (CAS basis)
    overriddenBy: null,
    priceType: "STANDARD",
    name: null,
    notes: null,
    trackedCategoryId: null,
    trackedSubcategoryId: null,
    product: { name: "Widget", unitsPerBox: 1 },
    ...over,
  });
  const basisOf = (li: any) => Object.fromEntries(INVOICE_LINE_CAS_FIELDS.map((f) => [f, li[f]]));
  const order = (lines: any[] = [line()]) => ({
    id: "ord-1",
    customerId: "cust-1",
    orderNumber: "ORD-1",
    subtotal: 960,
    tax: 0,
    shippingFee: 0,
    lineItems: lines,
  });

  beforeEach(() => {
    prisma.customer.findUnique.mockResolvedValue({ isTaxExempt: false } as any);
    prisma.invoice.aggregate.mockResolvedValue({ _sum: { shippingFee: 0 } });
    prisma.invoice.create.mockImplementation((args: any) =>
      Promise.resolve({ ...args.data, id: "inv-1", items: [], payments: [], customer: {} }),
    );
    prisma.order.findUnique.mockResolvedValue(order() as any);
  });

  beforeEach(() => {
    jest
      .spyOn(service as any, "resolveDefaultTerms")
      .mockResolvedValue({ terms: "Net 30", dueDays: 30 });
    jest
      .spyOn(service as any, "resolveTenantInvoiceDefaults")
      .mockResolvedValue({ notes: null, terms: null, timezone: null });
    prisma.invoice.findMany.mockResolvedValue([]);
  });

  it("createInvoiceFromOrder bumps each line with a CAS on the values read", async () => {
    prisma.order.findUnique.mockResolvedValue(order([line({ invoicedQty: 40 })]) as any);
    await service.createInvoiceFromOrder("ord-1");
    expect(prisma.orderItem.updateMany).toHaveBeenCalledWith({
      // #2645 / SA-523d: the WHOLE billing basis as read, not just qty/invoicedQty.
      where: { id: "oi-1", status: { not: "CANCELLED" }, ...basisOf(line({ invoicedQty: 40 })) },
      data: { invoicedQty: { increment: 56 } },
    });
    expect(prisma.orderItem.update).not.toHaveBeenCalled(); // never the unconditional bump
  });

  it("a CAS miss (a concurrent split or partial billed the line first) ⇒ 409; the credit settle never runs", async () => {
    mockCreditNotes.settleOrderCreditsInTx.mockClear(); // a file-scoped mock
    prisma.orderItem.updateMany.mockResolvedValue({ count: 0 } as any);
    const caught: any = await service.createInvoiceFromOrder("ord-1").catch((e) => e);
    expect(caught).toBeInstanceOf(ConflictException);
    expect(mockCreditNotes.settleOrderCreditsInTx).not.toHaveBeenCalled();
  });
});
