/**
 * Row 466: the deposit-at-placement issuance inside createInvoiceFromOrder commits the invoice, then
 * send()s it. A failure after that carries the invoiceId and the order's orderId, whatever the error
 * was. Lives apart from invoices.service.spec.ts, which is size-ratchet capped.
 */

// Prevent Jest from traversing ESM-only dependencies
jest.mock("./invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://example.com/invoice.pdf"),
  })),
}));

// Payment-image attachment (clone of the expense-receipt pattern): mock
// compressDocument so these tests never touch real sharp/image bytes.
jest.mock("../storage/compress.util", () => ({
  compressDocument: jest.fn(),
}));

import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { InvoicesService, addCalendarDays } from "./invoices.service";
import { startOfCalendarDay } from "../common/calendar-date";
import { AfterCommit } from "../common/after-commit";
import { InvoicePdfService } from "./invoice-pdf.service";
import { PrismaService } from "../prisma/prisma.service";
import { NumberingService } from "../import/numbering.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { EmailService } from "../email/email.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { StorageService } from "../storage/storage.service";
import { compressDocument } from "../storage/compress.util";
import { createMockPrisma } from "../testing/prisma-mock";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { MessagingService } from "../messaging/messaging.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { CheckStatus, InvoiceStatus, NotificationEvent, UserRole } from "@prisma/client";
import { computeLineSubtotal, roundMoney } from "@routeflow/pricing";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { fillSparseCasBasis } from "./testing/sparse-line-fixtures";

const mockCompressDocument = compressDocument as jest.Mock;

/** #2175: a caller-owned AfterCommit queue for InTx calls whose emits these tests don't assert. */
const q = new AfterCommit();
describe("InvoicesService — deposit-at-placement send keeps the invoice (row 466)", () => {
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
    // F03/T-B84: voidInvoice's releaseWalletPaymentsInTx calls this unconditionally —
    // without a stub here, voidInvoice tests crash on "not a function" instead of
    // failing on their actual assertion.
    releaseInvoiceCreditsInTx: jest.fn().mockResolvedValue([]),
  };

  const mockStorage = {
    upload: jest.fn().mockResolvedValue("stored"),
    presignedUrl: jest.fn().mockResolvedValue("https://signed/url"),
    delete: jest.fn().mockResolvedValue(undefined),
  };

  // flag.msrp — reset to OFF in beforeEach; MSRP snapshot tests flip it ON.
  const mockEntitlements = {
    hasFlag: jest.fn().mockResolvedValue(false),
  };

  const mockCommissionEngine = {
    syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined),
    syncOrderInvoices: jest.fn().mockResolvedValue(undefined),
    removeInvoiceCommission: jest.fn().mockResolvedValue(undefined),
  };

  // B100/F16b harness note: the five invoice-number mint sites route through
  // NumberingService once P1/P2 land — InvoicesService does not inject it yet, so
  // this provider is unused by today's code and only backs the new REG-B100/pin
  // tests below (see cause-ruling.md §2 D2). Default resolves to the same
  // "INV-2026-0001" the pre-B100 findFirst-null mocks produced, so it is a safe
  // module-wide default for the many unrelated tests that never assert on the
  // minted invoiceNumber.
  const mockNumbering = {
    reserveNext: jest.fn().mockResolvedValue("INV-2026-0001"),
  };

  beforeEach(async () => {
    fillSparseCasBasis(); // #2645: sparse order fixtures vs the CAS basis pin
    prisma = createMockPrisma();
    // #2070: createPartialFromOrder's invoicedQty bump is a CAS (updateMany); a clean read matches 1.
    prisma.orderItem.updateMany.mockResolvedValue({ count: 1 } as any);
    prisma.invoice.findFirst.mockResolvedValue({ items: [] }); // units_v1 guard reads the parent invoice
    mockNumbering.reserveNext.mockClear();
    mockNumbering.reserveNext.mockResolvedValue("INV-2026-0001");
    mockEntitlements.hasFlag.mockReset();
    mockEntitlements.hasFlag.mockResolvedValue(false);
    mockCommissionEngine.syncInvoiceCommissionSafe.mockClear();
    mockCommissionEngine.syncOrderInvoices.mockClear();
    mockCommissionEngine.removeInvoiceCommission.mockClear();
    mockMessaging.notify.mockClear();
    mockMessaging.notifyEvent.mockClear();
    mockCreditNotes.autoApplyOldestCreditsInTx.mockClear();
    mockCreditNotes.autoApplyOldestCreditsInTx.mockResolvedValue({
      applied: 0,
      invoiceStatus: null,
    });
    mockCreditNotes.settleOrderCreditsInTx.mockClear();
    mockCreditNotes.settleOrderCreditsInTx.mockResolvedValue({ applied: 0, unapplied: 0 });
    mockCreditNotes.releaseInvoiceCreditsInTx.mockClear();
    mockCreditNotes.releaseInvoiceCreditsInTx.mockResolvedValue([]);
    mockStorage.upload.mockClear();
    mockStorage.upload.mockResolvedValue("stored");
    mockStorage.presignedUrl.mockClear();
    mockStorage.presignedUrl.mockResolvedValue("https://signed/url");
    mockStorage.delete.mockClear();
    mockStorage.delete.mockResolvedValue(undefined);
    mockCompressDocument.mockReset();
    mockCompressDocument.mockResolvedValue({
      buffer: Buffer.from("compressed-bytes"),
      mimeType: "image/jpeg",
      ext: "jpg",
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvoicesService,
        {
          provide: SellingRestrictionsService,
          useValue: {
            assertLinesSellable: jest.fn().mockResolvedValue(undefined),
            checkLinesSellable: jest.fn().mockResolvedValue({ outcome: "ALLOW", reasons: [] }),
          },
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
            correctSaleForPriceChange: jest.fn(),
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
        // flag.msrp defaults OFF so applyMsrpSnapshots is a no-op — the
        // pre-MSRP tests keep their exact write shapes (msrp stays null).
        {
          provide: EntitlementAuthority,
          inject: [EntitlementsService],
          useFactory: (e: { hasFlag?: (t: string, k: string) => Promise<boolean> }) => ({
            can: (t: string, k: string) => e.hasFlag?.(t, k) ?? Promise.resolve(false),
          }),
        },
        { provide: EntitlementsService, useValue: mockEntitlements },
        { provide: CommissionEngineService, useValue: mockCommissionEngine },
        { provide: NumberingService, useValue: mockNumbering },
      ],
    }).compile();

    service = module.get<InvoicesService>(InvoicesService);
  });

  describe("createInvoiceFromOrder — deposit issuance send fails after the commit", () => {
    const order = {
      id: "ord-dep",
      customerId: "cust-1",
      orderNumber: "ORD-DEP",
      subtotal: 100,
      tax: 0,
      status: "PENDING",
      lineItems: [
        {
          id: "li-1",
          productId: "p1",
          name: null,
          qty: 2,
          invoicedQty: 0,
          unitPrice: 50,
          originalPrice: null,
          priceType: "STANDARD",
          product: { name: "Widget", unitsPerBox: 0 },
        },
      ],
    };

    beforeEach(() => {
      jest
        .spyOn(service as any, "resolveTenantInvoiceDefaults")
        .mockResolvedValue({ notes: null, terms: null, timezone: null });
      jest.spyOn(service as any, "generateInvoiceNumber").mockResolvedValue("INV-DEP");
      prisma.customer.findFirst.mockResolvedValue({
        isTaxExempt: false,
        defaultPaymentTerms: null,
        defaultDepositPercent: null,
      });
      mockSystemConfig.get.mockImplementation((key: string) => {
        if (key === "invoice.depositDefaultPercent") return Promise.resolve("30");
        if (key === "invoice.depositCollectAtOrder") return Promise.resolve("true");
        return Promise.resolve(null);
      });
      prisma.order.findUnique.mockResolvedValue(order);
      prisma.invoice.create.mockImplementation((args: any) =>
        Promise.resolve({ id: "inv-dep-1", ...args.data, items: [], payments: [], customer: {} }),
      );
    });

    it("an HttpException from the issuing send keeps its code and gains invoiceId and orderId", async () => {
      jest
        .spyOn(service, "send")
        .mockRejectedValue(new BadRequestException({ code: "SOME_REFUSAL", message: "no" }));
      const err = await service.createInvoiceFromOrder("ord-dep").catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toMatchObject({
        code: "SOME_REFUSAL",
        invoiceId: "inv-dep-1",
        orderId: "ord-dep",
      });
      expect(prisma.invoice.create).toHaveBeenCalledTimes(1);
    });

    it("a non-HTTP error becomes a coded 500 carrying both ids, never the raw message", async () => {
      jest.spyOn(service, "send").mockRejectedValue(new Error("lock timeout: secret-detail"));
      const err = await service.createInvoiceFromOrder("ord-dep").catch((e) => e);
      expect(err.getStatus()).toBe(500);
      expect(err.getResponse()).toMatchObject({
        code: "INVOICE_SEND_AFTER_CREATE_FAILED",
        invoiceId: "inv-dep-1",
        orderId: "ord-dep",
      });
      expect(JSON.stringify(err.getResponse())).not.toContain("secret-detail");
    });
  });
});
