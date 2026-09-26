/**
 * #2256 — a client invoice dueDate / depositDueDate is stored as the UTC-midnight stamp of the
 * LITERAL day it names (the #2197 rule, `calendarStampFromInput`), never `new Date(raw)`.
 *
 * Own file per the size ratchet; bootstrap duplicated from invoices.service.b2197-issue-date.spec.ts.
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

describe("InvoicesService — #2256 due dates are the literal calendar day", () => {
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

  const nyDefaults = { notes: null, terms: null, timezone: "America/New_York" };
  const oct25 = new Date("2026-10-25T00:00:00.000Z");
  const oct10 = new Date("2026-10-10T00:00:00.000Z");
  // 23:30 at -05:00 is 04:30Z on the 26th; 20:00 at -04:00 is exactly 00:00Z on the 11th.
  const OFFSET_DUE = "2026-10-25T23:30:00-05:00";
  const MIDNIGHT_DEPOSIT = "2026-10-10T20:00:00-04:00";

  const createWith = async (extra: Record<string, unknown>) => {
    prisma.customer.findUnique.mockResolvedValue({ id: "cust-1", isTaxExempt: false });
    prisma.product.findMany.mockResolvedValue([]);
    jest.spyOn(service as any, "resolveTenantInvoiceDefaults").mockResolvedValue(nyDefaults);
    prisma.invoice.create.mockResolvedValue({ id: "inv-2256", items: [], payments: [] });
    await service.create({
      customerId: "cust-1",
      items: [{ description: "Widget", qty: 1, unitPrice: 10, taxRate: 0 }],
      ...extra,
    } as any);
    return prisma.invoice.create.mock.calls[0][0].data;
  };

  it("create(): dueDate with an offset different from the tenant zone keeps the literal day", async () => {
    expect((await createWith({ dueDate: OFFSET_DUE })).dueDate).toEqual(oct25);
  });

  it("create(): depositDueDate at exactly UTC midnight of the next day keeps the literal day", async () => {
    const data = await createWith({ depositPercent: 50, depositDueDate: MIDNIGHT_DEPOSIT });
    expect(data.depositDueDate).toEqual(oct10);
  });

  it("create(): an impossible dueDate or depositDueDate is a 400 before anything is read", async () => {
    for (const extra of [{ dueDate: "2026-02-31" }, { depositDueDate: "2026-02-30T10:00:00Z" }]) {
      await expect(
        service.create({
          customerId: "cust-1",
          items: [{ description: "Widget", qty: 1, unitPrice: 10, taxRate: 0 }],
          ...extra,
        } as any),
      ).rejects.toThrow("must be a calendar date (YYYY-MM-DD)");
    }
    expect(prisma.customer.findUnique).not.toHaveBeenCalled();
  });

  const draft = {
    id: "inv-2256u",
    orderId: null,
    deliveryBatchId: null,
    customerId: "cust-1",
    invoiceNumber: "INV-2026-2256",
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

  it("update(): a header-only edit keeps the literal day for both due dates", async () => {
    prisma.invoice.findUnique.mockResolvedValue(draft);
    prisma.invoice.update.mockResolvedValue({ id: draft.id });

    await service.update(draft.id, {
      dueDate: OFFSET_DUE,
      depositDueDate: MIDNIGHT_DEPOSIT,
    } as any);

    const data = prisma.invoice.update.mock.calls[0][0].data;
    expect(data.dueDate).toEqual(oct25);
    expect(data.depositDueDate).toEqual(oct10);
  });

  it("update() WITH items: the item-rewrite write keeps the literal day for both due dates", async () => {
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
      dueDate: OFFSET_DUE,
      depositDueDate: MIDNIGHT_DEPOSIT,
      items: [{ id: "item-1", description: "Widget", qty: 1, unitPrice: 10 }],
    } as any);

    const data = prisma.invoice.update.mock.calls[0][0].data;
    expect(data.dueDate).toEqual(oct25);
    expect(data.depositDueDate).toEqual(oct10);
  });

  it("update(): an impossible dueDate is a 400", async () => {
    prisma.invoice.findUnique.mockResolvedValue(draft);
    await expect(service.update(draft.id, { dueDate: "2026-02-31" } as any)).rejects.toThrow(
      "dueDate must be a calendar date (YYYY-MM-DD)",
    );
    expect(prisma.invoice.update).not.toHaveBeenCalled();
  });

  it("updateTerms(): an offset dueDate keeps the literal day", async () => {
    prisma.invoice.findUnique.mockResolvedValue({
      ...draft,
      status: InvoiceStatus.SENT,
      payments: [],
      internalNotes: null,
    });
    prisma.invoice.update.mockResolvedValue({ id: draft.id });

    await service.updateTerms(draft.id, { dueDate: OFFSET_DUE });

    expect(prisma.invoice.update.mock.calls[0][0].data.dueDate).toEqual(oct25);
  });

  it("createPartialFromOrder(): an impossible dueDate or depositDueDate is a 400 before the order is read", async () => {
    for (const [dto, overrides] of [
      [{ dueDate: "2026-02-31" }, undefined],
      [{}, { depositDueDate: "2026-02-30" }],
    ] as const) {
      await expect(
        service.createPartialFromOrder("ord-1", { items: [], ...dto } as any, overrides as any),
      ).rejects.toThrow("must be a calendar date (YYYY-MM-DD)");
    }
    expect(prisma.order.findUnique).not.toHaveBeenCalled();
  });

  it("createInvoiceFromOrder() / ...WithTenant(): an impossible override due date is a 400 before the order is read", async () => {
    await expect(
      service.createInvoiceFromOrder("ord-1", undefined, { dueDate: "2026-02-31" }),
    ).rejects.toThrow("dueDate must be a calendar date (YYYY-MM-DD)");
    await expect(
      service.createInvoiceFromOrderWithTenant("ord-1", "tenant-1", {
        depositPercent: 50,
        depositDueDate: "2026-02-30T20:00:00-04:00",
      }),
    ).rejects.toThrow("depositDueDate must be a calendar date (YYYY-MM-DD)");
    expect(prisma.order.findUnique).not.toHaveBeenCalled();
    expect(prisma.order.findFirst).not.toHaveBeenCalled();
  });
});
