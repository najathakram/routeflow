/**
 * Moved out of invoices.service.spec.ts (size ratchet, test-only, no assertion changes): send()'s
 * credit-note interactions (WP2), with the #2255 locked re-read in their findUnique sequence.
 */
/**
 * Unit tests for InvoicesService — covers RF-011, RF-012, RF-079.
 *
 * Tests use the standard createMockPrisma() helper so no real DB is needed.
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
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { CheckStatus, InvoiceStatus, NotificationEvent, UserRole } from "@prisma/client";
import { computeLineSubtotal, roundMoney } from "@routeflow/pricing";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";

const mockCompressDocument = compressDocument as jest.Mock;

describe("InvoicesService", () => {
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
    prisma = createMockPrisma();
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
        { provide: EntitlementsService, useValue: mockEntitlements },
        entitlementAuthorityFromEntitlements, // #2241
        { provide: CommissionEngineService, useValue: mockCommissionEngine },
        { provide: NumberingService, useValue: mockNumbering },
      ],
    }).compile();

    service = module.get<InvoicesService>(InvoicesService);
  });

  describe("send() — credit-note interactions (WP2)", () => {
    it("flips a fully-pre-credited DRAFT to PAID, not SENT (stuck-SENT regression)", async () => {
      prisma.invoice.findUnique
        .mockResolvedValueOnce({
          // findOneOrThrow — the invoice as it is before send()
          id: "i1",
          orderId: null,
          status: InvoiceStatus.DRAFT,
          deliveryBatchId: null,
        })
        // #2255 / SA-404: the row markSent locks and re-reads as its first statement.
        .mockResolvedValueOnce({
          id: "i1",
          orderId: null,
          status: InvoiceStatus.DRAFT,
          payments: [],
        })
        .mockResolvedValueOnce({
          // fresh read inside the tx, after the DRAFT→SENT flip already committed —
          // a credit applied at order-create time already covers the full total.
          id: "i1",
          status: InvoiceStatus.SENT,
          total: 100,
          dueDate: null,
          payments: [{ id: "pay-1", amount: 100, status: "PAID" }],
        })
        .mockResolvedValueOnce({
          // final post-tx re-fetch for the return value
          id: "i1",
          invoiceNumber: "INV-1",
          customerId: "c1",
          status: InvoiceStatus.PAID,
          total: 100,
        });
      prisma.invoice.update.mockResolvedValueOnce({
        id: "i1",
        invoiceNumber: "INV-1",
        customerId: "c1",
        orderId: null,
        status: InvoiceStatus.SENT,
        total: 100,
        dueDate: null,
      });
      // Auto-apply finds nothing left to apply — the credit already covered this
      // invoice at order-create time via settleOrderCreditsInTx.
      mockCreditNotes.autoApplyOldestCreditsInTx.mockResolvedValueOnce({
        applied: 0,
        invoiceStatus: null,
      });

      const result = await service.send("i1");

      // The stuck-SENT fix recomputed status from the invoice's own payments and
      // promoted it to PAID instead of leaving it SENT.
      expect(prisma.invoice.update).toHaveBeenCalledWith({
        where: { id: "i1" },
        data: { status: InvoiceStatus.PAID, paidAt: expect.any(Date) },
      });
      expect((result as any).status).toBe(InvoiceStatus.PAID);
    });

    it("passes the order's explicit-amount intent ids as excludeCreditNoteIds", async () => {
      const draft = {
        id: "i2",
        orderId: "ord-2",
        status: InvoiceStatus.DRAFT,
        deliveryBatchId: null,
      };
      prisma.invoice.findUnique
        .mockResolvedValueOnce(draft) // findOneOrThrow
        .mockResolvedValueOnce({ ...draft, payments: [] }); // #2255: markSent's locked re-read
      prisma.order.findFirst.mockResolvedValue({ status: "DELIVERED", orderNumber: "O2" });
      prisma.invoice.update.mockResolvedValueOnce({
        id: "i2",
        invoiceNumber: "INV-2",
        customerId: "c2",
        orderId: "ord-2",
        status: InvoiceStatus.SENT,
        total: 50,
        dueDate: null,
      });
      prisma.orderCreditNote.findMany.mockResolvedValueOnce([
        { creditNoteId: "cn-explicit-1" },
        { creditNoteId: "cn-explicit-2" },
      ]);
      mockCreditNotes.autoApplyOldestCreditsInTx.mockResolvedValueOnce({
        applied: 0,
        invoiceStatus: InvoiceStatus.SENT,
      });

      await service.send("i2");

      expect(prisma.orderCreditNote.findMany).toHaveBeenCalledWith({
        where: { orderId: "ord-2", amount: { not: null } },
        select: { creditNoteId: true },
      });
      expect(mockCreditNotes.autoApplyOldestCreditsInTx).toHaveBeenCalledWith(
        expect.anything(),
        "i2",
        "c2",
        { excludeCreditNoteIds: ["cn-explicit-1", "cn-explicit-2"] },
      );
    });
  });
});
