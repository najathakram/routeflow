/**
 * #2256 — a client invoice dueDate / depositDueDate is stored as the UTC-midnight stamp of the
 * LITERAL day it names (its first ten characters), the #2197 issueDate rule; never `new Date(raw)`,
 * whose offset moves the day. A value naming no real day is a 400.
 *
 * Split out of invoices.service.spec.ts (not merged into it) per the repo's size ratchet
 * (`common/size-ratchet.spec.ts`). Same bootstrap as invoices.service.b2197-issue-date.spec.ts,
 * duplicated deliberately so this file stays self-contained.
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
import { fillSparseCasBasis } from "./testing/sparse-line-fixtures";

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
    fillSparseCasBasis(); // #2645: sparse order fixtures vs the CAS basis pin
    prisma = createMockPrisma();
    // #2612: the split path's invoicedQty bump is a CAS (updateMany); a clean read matches 1.
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

  const nyDefaults = { notes: null, terms: null, timezone: "America/New_York" };
  const day25 = new Date("2026-09-25T00:00:00.000Z");
  // 23:30 at -05:00 is 04:30Z on the 26th (00:30 on the 26th in New York): an offset different
  // from the tenant zone. 20:00 at -04:00 is exactly 00:00Z on the 26th: UTC midnight.
  const OFFSET = "2026-09-25T23:30:00-05:00";
  const UTC_MIDNIGHT = "2026-09-25T20:00:00-04:00";

  describe("create()", () => {
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

    it.each([
      ["an offset different from the tenant zone", OFFSET],
      ["an instant at exactly UTC midnight of the next day", UTC_MIDNIGHT],
      ["a bare calendar date", "2026-09-25"],
    ])("dueDate and depositDueDate keep the literal day: %s", async (_label, raw) => {
      const data = await createWith({ dueDate: raw, depositDueDate: raw });
      expect(data.dueDate).toEqual(day25);
      expect(data.depositDueDate).toEqual(day25);
    });

    it("no due dates stays null", async () => {
      const data = await createWith({});
      expect(data.dueDate).toBeNull();
      expect(data.depositDueDate).toBeNull();
    });

    it.each([
      ["dueDate", "2026-02-31"],
      ["depositDueDate", "not-a-date"],
    ])("a %s that names no real day is a 400 before anything is read", async (field, raw) => {
      await expect(
        service.create({
          customerId: "cust-1",
          [field]: raw,
          items: [{ description: "Widget", qty: 1, unitPrice: 10, taxRate: 0 }],
        } as any),
      ).rejects.toThrow(`${field} must be a calendar date (YYYY-MM-DD)`);
      expect(prisma.customer.findUnique).not.toHaveBeenCalled();
      expect(prisma.invoice.create).not.toHaveBeenCalled();
    });
  });

  describe("update()", () => {
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

    it("a header-only edit keeps the literal due and deposit-due days", async () => {
      prisma.invoice.findUnique.mockResolvedValue(draft);
      prisma.invoice.update.mockResolvedValue({ id: draft.id });

      await service.update(draft.id, { dueDate: OFFSET, depositDueDate: UTC_MIDNIGHT } as any);

      const data = prisma.invoice.update.mock.calls[0][0].data;
      expect(data.dueDate).toEqual(day25);
      expect(data.depositDueDate).toEqual(day25);
    });

    it("WITH items: the item-rewrite write keeps the literal days too", async () => {
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
        dueDate: UTC_MIDNIGHT,
        depositDueDate: OFFSET,
        items: [{ id: "item-1", description: "Widget", qty: 1, unitPrice: 10 }],
      } as any);

      const data = prisma.invoice.update.mock.calls[0][0].data;
      expect(data.dueDate).toEqual(day25);
      expect(data.depositDueDate).toEqual(day25);
    });

    it("a dueDate that names no real day is a 400 before any write", async () => {
      prisma.invoice.findUnique.mockResolvedValue(draft);
      await expect(service.update(draft.id, { dueDate: "2026-13-01" } as any)).rejects.toThrow(
        "dueDate must be a calendar date (YYYY-MM-DD)",
      );
      expect(prisma.invoice.update).not.toHaveBeenCalled();
    });
  });

  describe("updateTerms()", () => {
    const issued = {
      id: "inv-2256t",
      status: InvoiceStatus.SENT,
      total: 100,
      dueDate: new Date("2026-09-01T00:00:00.000Z"),
      internalNotes: null,
      payments: [],
    };

    it.each([OFFSET, UTC_MIDNIGHT])("keeps the literal day for %s", async (raw) => {
      prisma.invoice.findUnique.mockResolvedValue(issued);
      prisma.invoice.update.mockResolvedValue({ id: issued.id });

      await service.updateTerms(issued.id, { dueDate: raw });

      const data = prisma.invoice.update.mock.calls[0][0].data;
      expect(data.dueDate).toEqual(day25);
      expect(data.internalNotes).toContain("2026-09-01 → 2026-09-25");
    });

    it("a dueDate that names no real day is a 400 before any write", async () => {
      prisma.invoice.findUnique.mockResolvedValue(issued);
      await expect(service.updateTerms(issued.id, { dueDate: "2026-02-31" })).rejects.toThrow(
        "dueDate must be a calendar date (YYYY-MM-DD)",
      );
      expect(prisma.invoice.update).not.toHaveBeenCalled();
    });
  });

  describe("createInvoiceFromOrder() overrides", () => {
    const order = {
      id: "ord-2256",
      customerId: "cust-1",
      orderNumber: "ORD-2256",
      subtotal: 20,
      tax: 0,
      lineItems: [
        {
          id: "li-1",
          productId: "p1",
          name: null,
          qty: 2,
          invoicedQty: 0,
          unitPrice: 10,
          originalPrice: null,
          priceType: "STANDARD",
          product: { name: "Widget", unitsPerBox: 0 },
        },
      ],
    };

    it("an override dueDate and depositDueDate keep the literal day", async () => {
      jest.spyOn(service as any, "resolveTenantInvoiceDefaults").mockResolvedValue(nyDefaults);
      jest.spyOn(service as any, "generateInvoiceNumber").mockResolvedValue("INV-2256");
      prisma.customer.findFirst.mockResolvedValue({ defaultPaymentTerms: null });
      prisma.order.findUnique.mockResolvedValue(order);
      prisma.invoice.create.mockImplementation((args: any) =>
        Promise.resolve({ ...args.data, items: [], payments: [], customer: {} }),
      );

      await service.createInvoiceFromOrder("ord-2256", undefined, {
        dueDate: OFFSET,
        depositPercent: 50,
        depositDueDate: UTC_MIDNIGHT,
      });

      const data = prisma.invoice.create.mock.calls[0][0].data;
      expect(data.dueDate).toEqual(day25);
      expect(data.depositDueDate).toEqual(day25);
    });
  });
});
