/**
 * Row 466 ("the record lies"): create-and-send commits the draft first. A send failure after that
 * carries the draft's invoiceId, whatever the error. Lives apart from invoices.service.spec.ts, which is
 * size-ratchet capped. Same harness as that spec (createMockPrisma, no real DB).
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
describe("InvoicesService — create-and-send keeps the draft (row 466)", () => {
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

  // ─── Row 466: create-and-send must not lie when the send step fails after the commit ───────────
  describe("row 466 — a send failure after the draft committed carries the invoiceId", () => {
    const CREATED = "inv-466";
    const seedCreate = () => {
      prisma.customer.findUnique.mockResolvedValue({ id: "cust-1", isTaxExempt: false });
      prisma.product.findMany.mockResolvedValue([]);
      jest.spyOn(service as any, "resolveTenantInvoiceDefaults").mockResolvedValue({
        notes: null,
        terms: null,
      });
      prisma.invoice.create.mockImplementation((args: any) =>
        Promise.resolve({ id: CREATED, ...args.data, items: [], customer: {}, payments: [] }),
      );
    };
    const createAndSend = () =>
      service.create({
        customerId: "cust-1",
        send: true,
        items: [{ description: "Widget", qty: 1, unitPrice: 10 }],
      } as any);

    it("a VOID-after-create refusal (400) keeps its status and message and adds invoiceId", async () => {
      seedCreate();
      // The real send(): the row reads back VOID, so sendRefusal throws a plain 400.
      prisma.invoice.findUnique.mockResolvedValue({
        id: CREATED,
        orderId: null,
        status: InvoiceStatus.VOID,
        deliveryBatchId: null,
      });
      const err = await createAndSend().catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getStatus()).toBe(400);
      expect(err.getResponse()).toMatchObject({ invoiceId: CREATED, statusCode: 400 });
      expect(typeof (err.getResponse() as any).message).toBe("string");
      expect(prisma.invoice.create).toHaveBeenCalledTimes(1); // the draft exists exactly once
    });

    it("a 409 from the send step keeps its code and gains invoiceId", async () => {
      seedCreate();
      jest
        .spyOn(service, "send")
        .mockRejectedValue(
          new ConflictException({ code: "INVOICE_CHANGED_CONCURRENTLY", message: "changed" }),
        );
      const err = await createAndSend().catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toMatchObject({
        code: "INVOICE_CHANGED_CONCURRENTLY",
        message: "changed",
        invoiceId: CREATED,
      });
    });

    it("EMAIL_SEND_FAILED still carries its code and now also invoiceId", async () => {
      seedCreate();
      jest
        .spyOn(service, "send")
        .mockRejectedValue(
          new BadRequestException({ code: "EMAIL_SEND_FAILED", message: "smtp down" }),
        );
      const err = await createAndSend().catch((e) => e);
      expect(err.getResponse()).toMatchObject({
        code: "EMAIL_SEND_FAILED",
        message: "smtp down",
        invoiceId: CREATED,
      });
    });

    it("a non-HTTP error becomes a coded 500 with invoiceId, never the raw message", async () => {
      seedCreate();
      jest
        .spyOn(service, "send")
        .mockRejectedValue(new Error("pdf renderer exploded: secret-detail"));
      const err = await createAndSend().catch((e) => e);
      expect(err.getStatus()).toBe(500);
      const body = err.getResponse() as any;
      expect(body).toMatchObject({ code: "INVOICE_SEND_AFTER_CREATE_FAILED", invoiceId: CREATED });
      expect(JSON.stringify(body)).not.toContain("secret-detail");
      expect(err.cause).toBeInstanceOf(Error); // Sentry still sees the original
    });

    it("without send=true nothing is wrapped and the draft is returned", async () => {
      seedCreate();
      const send = jest.spyOn(service, "send");
      const inv = await service.create({
        customerId: "cust-1",
        items: [{ description: "Widget", qty: 1, unitPrice: 10 }],
      } as any);
      expect(inv).toMatchObject({ id: CREATED });
      expect(send).not.toHaveBeenCalled();
    });

    it("createPartialFromOrder(send=true) carries invoiceId on a send failure too", async () => {
      prisma.customer.findUnique.mockResolvedValue({ isTaxExempt: false } as any);
      prisma.invoice.aggregate.mockResolvedValue({ _sum: { shippingFee: 0 } });
      prisma.order.findUnique.mockResolvedValue({
        id: "ord-p1",
        customerId: "cust-1",
        orderNumber: "ORD-P1",
        subtotal: 50,
        tax: 5,
        shippingFee: 0,
        lineItems: [
          {
            id: "oi-1",
            productId: "p-1",
            qty: 10,
            invoicedQty: 0,
            boxes: null,
            pieces: null,
            unitsPerBox: null,
            unitPrice: 5,
            subtotal: 50,
            product: { name: "Widget", unitsPerBox: null },
          },
        ],
      });
      prisma.invoice.create.mockImplementation((args: any) =>
        Promise.resolve({ id: CREATED, ...args.data, items: [], payments: [], customer: {} }),
      );
      prisma.orderItem.update.mockResolvedValue({} as any);
      jest.spyOn(service, "send").mockRejectedValue(new BadRequestException("blocked"));
      const err = await service
        .createPartialFromOrder("ord-p1", {
          items: [{ orderItemId: "oi-1", qty: 10 }],
          send: true,
        } as any)
        .catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toMatchObject({ invoiceId: CREATED, message: "blocked" });
    });
  });
});
