/**
 * #2493 item 4 — the #2256 literal-day rule holds under a NEGATIVE-offset process time zone, on
 * the two from-order paths #2256 did not pin (createPartialFromOrder, and
 * createInvoiceFromOrderWithTenant, the worker path), and the import CSV's "Due Date" (item 2)
 * follows it too.
 *
 * Split out of invoices.service.spec.ts per the size ratchet. Same bootstrap as
 * invoices.service.b2256-due-date.spec.ts, duplicated deliberately so this file stays
 * self-contained.
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

import { importCalendarDay } from "../import/import.service";

describe("InvoicesService — #2493 due dates under a negative-offset process zone", () => {
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

  // Los Angeles is UTC-7 in September: a `new Date(raw)` read back through local getters moves
  // an evening-at-offset value to the wrong day, which is exactly what this zone exposes.
  const ORIGINAL_TZ = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = "America/Los_Angeles";
  });
  afterAll(() => {
    if (ORIGINAL_TZ === undefined) delete process.env.TZ;
    else process.env.TZ = ORIGINAL_TZ;
  });

  const day25 = new Date("2026-09-25T00:00:00.000Z");
  const OFFSET = "2026-09-25T23:30:00-05:00";
  const UTC_MIDNIGHT = "2026-09-25T20:00:00-04:00";

  it("the process zone really is negative-offset for these cases", () => {
    expect(new Date(2026, 8, 25).getTimezoneOffset()).toBeGreaterThan(0);
  });

  const orderWith = (over: Record<string, unknown> = {}) => ({
    id: "ord-2493",
    customerId: "cust-1",
    orderNumber: "ORD-2493",
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
    jest
      .spyOn(service as any, "resolveDefaultTerms")
      .mockResolvedValue({ terms: "Net 30", dueDays: 30 });
    jest
      .spyOn(service as any, "resolveTenantInvoiceDefaults")
      .mockResolvedValue({ notes: null, terms: null, timezone: "America/Los_Angeles" });
    jest.spyOn(service as any, "generateInvoiceNumber").mockResolvedValue("INV-2493");
    prisma.customer.findUnique.mockResolvedValue({ isTaxExempt: false });
    prisma.customer.findFirst.mockResolvedValue({ isTaxExempt: false, defaultPaymentTerms: null });
    prisma.orderItem.update.mockResolvedValue({});
    prisma.invoice.aggregate.mockResolvedValue({ _sum: { shippingFee: 0 } });
    prisma.systemConfig.findFirst.mockResolvedValue(null);
    prisma.tenantConfig.findUnique.mockResolvedValue(null);
    prisma.invoice.create.mockImplementation((args: any) =>
      Promise.resolve({ ...args.data, id: "inv-2493", items: [], payments: [], customer: {} }),
    );
  };

  it("createPartialFromOrder: dto dueDate and depositDueDate keep the literal day", async () => {
    seed();
    prisma.order.findUnique.mockResolvedValue(orderWith());
    await service.createPartialFromOrder("ord-2493", {
      items: [{ orderItemId: "li-1", qty: 2 }],
      dueDate: OFFSET,
      depositPercent: 50,
      depositDueDate: UTC_MIDNIGHT,
    } as any);
    const data = prisma.invoice.create.mock.calls[0][0].data;
    expect(data.dueDate).toEqual(day25);
    expect(data.depositDueDate).toEqual(day25);
  });

  it("createPartialFromOrder: override dueDate and depositDueDate keep the literal day", async () => {
    seed();
    prisma.order.findUnique.mockResolvedValue(orderWith());
    await service.createPartialFromOrder(
      "ord-2493",
      { items: [{ orderItemId: "li-1", qty: 2 }] } as any,
      {
        dueDate: UTC_MIDNIGHT,
        depositPercent: 50,
        depositDueDate: OFFSET,
      },
    );
    const data = prisma.invoice.create.mock.calls[0][0].data;
    expect(data.dueDate).toEqual(day25);
    expect(data.depositDueDate).toEqual(day25);
  });

  it("createInvoiceFromOrderWithTenant: override dueDate and depositDueDate keep the literal day", async () => {
    seed();
    prisma.order.findFirst.mockResolvedValue(orderWith());
    await service.createInvoiceFromOrderWithTenant("ord-2493", "test-tenant", {
      dueDate: OFFSET,
      depositPercent: 50,
      depositDueDate: UTC_MIDNIGHT,
    });
    const data = prisma.invoice.create.mock.calls[0][0].data;
    expect(data.dueDate).toEqual(day25);
    expect(data.depositDueDate).toEqual(day25);
  });

  it("createInvoiceFromOrderWithTenant: an override that names no day is a 400", async () => {
    seed();
    prisma.order.findFirst.mockResolvedValue(orderWith());
    await expect(
      service.createInvoiceFromOrderWithTenant("ord-2493", "test-tenant", {
        dueDate: "2026-02-31",
      }),
    ).rejects.toThrow("dueDate must be a calendar date (YYYY-MM-DD)");
    expect(prisma.invoice.create).not.toHaveBeenCalled();
  });

  describe("import CSV 'Due Date' (item 2): importCalendarDay", () => {
    it.each([
      ["a bare ISO day", "2026-09-25"],
      ["an ISO datetime at an offset", OFFSET],
      ["an ISO instant at UTC midnight of the next day", UTC_MIDNIGHT],
      ["a US-style date", "09/25/2026"],
      ["a written date", "25 Sep 2026"],
      ["surrounding whitespace", "  2026-09-25  "],
    ])("%s → the day it names", (_label, raw) => {
      expect(importCalendarDay(raw)).toEqual(day25);
    });

    it.each([
      ["", null],
      [null, null],
      ["not a date", null],
      ["2026-02-31", null],
    ])("%j → null (no due date), never an Invalid Date", (raw, expected) => {
      expect(importCalendarDay(raw)).toBe(expected);
    });
  });
});
