/**
 * F2 (selling restrictions): billing a DRAFT order SELLS its lines. createInvoiceFromOrder and
 * createPartialFromOrder refuse a banned catalog line on a DRAFT order with the engine's standard
 * 409 (assertLinesSellable, channel STAFF) BEFORE a number is reserved, an invoice written, the
 * split flag audited or the deposit mirror SENT. A non-DRAFT order keeps F-05's flag-not-block
 * (invoices.split-restricted-lines.spec.ts).
 */
jest.mock("./invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({ getOrGenerate: jest.fn() })),
}));
jest.mock("../storage/compress.util", () => ({ compressDocument: jest.fn() }));
import { Test } from "@nestjs/testing";
import { ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
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
import { fillSparseCasBasis } from "./testing/sparse-line-fixtures";

describe("InvoicesService — DRAFT order invoicing is gated (F2)", () => {
  let service: InvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    fillSparseCasBasis(); // #2645: sparse order fixtures vs the CAS basis pin
    prisma = createMockPrisma();
    prisma.invoice.findFirst.mockResolvedValue({ items: [] });
    // #2643: the split bumps each order line's invoicedQty through a CAS updateMany; a mock that
    // matches nothing reads as a concurrent edit (409). Same stub as #2632/#2643's specs.
    prisma.orderItem.updateMany.mockResolvedValue({ count: 1 } as any);
    const module = await Test.createTestingModule({
      providers: [
        { provide: EntitlementAuthority, useValue: { can: jest.fn().mockResolvedValue(false) } },
        InvoicesService,
        {
          provide: SellingRestrictionsService,
          useValue: {
            assertLinesSellable: jest.fn().mockResolvedValue(undefined),
            checkLinesSellable: jest.fn().mockResolvedValue({ outcome: "ALLOW", reasons: [] }),
          },
        },
        { provide: PrismaService, useValue: prisma },
        {
          provide: RouteFlowGateway,
          useValue: {
            emitInvoiceUpdated: jest.fn(),
            emitOrderCreated: jest.fn(),
            emitOrderStatusChanged: jest.fn(),
          },
        },
        { provide: EmailService, useValue: { sendInvoice: jest.fn() } },
        { provide: InvoicePdfService, useValue: { getOrGenerate: jest.fn() } },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
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
          useValue: { notify: jest.fn().mockResolvedValue([]), notifyEvent: jest.fn() },
        },
        { provide: StorageService, useValue: {} },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        entitlementAuthorityFromEntitlements, // #2241: EntitlementAuthority
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
          useValue: { reserveNext: jest.fn().mockResolvedValue("INV-2026-0001") },
        },
      ],
    }).compile();
    service = module.get(InvoicesService);
  });

  const refusal = () =>
    new ConflictException({
      code: API_ERROR_CODES.SELLING_RESTRICTED,
      message: "Cigs cannot be sold",
      blockedLines: [{ productId: "p-a", productName: "Cigs" }],
    });
  const restrictions = () => (service as any).sellingRestrictions;
  let numberSpy: jest.SpyInstance;
  let sendSpy: jest.SpyInstance;

  const setup = (status: string | undefined, banned: boolean, depositMirror = false) => {
    jest.spyOn(service as any, "resolveDefaultTerms").mockResolvedValue({
      dueDays: 30,
      ...(depositMirror ? { effectiveDepositPercent: 50 } : {}),
    });
    jest.spyOn(service as any, "resolveTenantInvoiceDefaults").mockResolvedValue({});
    numberSpy = jest.spyOn(service as any, "generateInvoiceNumber").mockResolvedValue("INV-1");
    sendSpy = jest.spyOn(service, "send").mockResolvedValue({ id: "sent" } as any);
    (service as any).systemConfig.get.mockResolvedValue(depositMirror ? "true" : null);
    prisma.customer.findFirst.mockResolvedValue({ isTaxExempt: false });
    prisma.invoice.aggregate.mockResolvedValue({ _sum: { shippingFee: 0 } });
    prisma.invoice.create.mockImplementation((args: any) =>
      Promise.resolve({ ...args.data, id: "inv-1", items: [], payments: [], customer: {} }),
    );
    restrictions().assertLinesSellable.mockImplementation(() =>
      banned ? Promise.reject(refusal()) : Promise.resolve(undefined),
    );
    // The flag path (non-DRAFT) reads checkLinesSellable: a ban there is flagged, never thrown.
    restrictions().checkLinesSellable.mockResolvedValue(
      banned
        ? {
            outcome: "BLOCK",
            reasons: [{ productId: "p-a", productName: "Cigs", ruleId: "r1", message: "no" }],
          }
        : { outcome: "ALLOW", reasons: [] },
    );
    prisma.order.findUnique.mockResolvedValue({
      id: "ord-1",
      status,
      customerId: "cust-1",
      orderNumber: "ORD",
      subtotal: 20,
      tax: 0,
      shippingFee: 0,
      lineItems: [
        {
          id: "oi-a",
          productId: "p-a",
          qty: 1,
          invoicedQty: 0,
          unitPrice: 10,
          subtotal: 10,
          priceType: "STANDARD",
          trackedCategoryId: null,
          categoryTaxAmount: 0,
          product: { name: "a", unitsPerBox: 0, trackedCategoryId: null },
        },
        {
          id: "oi-b",
          productId: "p-b",
          qty: 1,
          invoicedQty: 0,
          unitPrice: 10,
          subtotal: 10,
          priceType: "STANDARD",
          trackedCategoryId: null,
          categoryTaxAmount: 0,
          product: { name: "b", unitsPerBox: 0, trackedCategoryId: null },
        },
      ],
    });
  };

  const expectNothingWritten = () => {
    expect(prisma.invoice.create).not.toHaveBeenCalled();
    expect(prisma.invoice.update).not.toHaveBeenCalled();
    expect(prisma.orderItem.updateMany).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
    expect(numberSpy).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();
  };

  describe("createInvoiceFromOrder", () => {
    it("a banned product on a DRAFT order is refused with the standard 409 and writes nothing", async () => {
      setup("DRAFT", true);
      const err: any = await service.createInvoiceFromOrder("ord-1").catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse().code).toBe(API_ERROR_CODES.SELLING_RESTRICTED);
      expect(restrictions().assertLinesSellable).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: "test-tenant",
          customerId: "cust-1",
          channel: "STAFF",
          lines: [{ productId: "p-a" }, { productId: "p-b" }],
        }),
      );
      expectNothingWritten();
    });

    it("the depositCollectAtOrder (SENT at placement) path is gated before anything is created", async () => {
      setup("DRAFT", true, true);
      await expect(service.createInvoiceFromOrder("ord-1")).rejects.toBeInstanceOf(
        ConflictException,
      );
      expectNothingWritten();
    });

    it("control: an allowed product on a DRAFT order still creates the invoice", async () => {
      setup("DRAFT", false);
      const out = (await service.createInvoiceFromOrder("ord-1")) as any[];
      expect(out).toHaveLength(1);
      expect(restrictions().assertLinesSellable).toHaveBeenCalledTimes(1);
      expect(prisma.invoice.create).toHaveBeenCalledTimes(1);
    });

    it("control: a deposit-mirror DRAFT with an allowed product is still SENT", async () => {
      setup("DRAFT", false, true);
      await service.createInvoiceFromOrder("ord-1");
      expect(sendSpy).toHaveBeenCalledTimes(1);
    });

    it("control: a non-DRAFT order with the banned product is flagged, never refused", async () => {
      setup("PENDING", true);
      const out = (await service.createInvoiceFromOrder("ord-1")) as any[];
      expect(out).toHaveLength(1);
      expect(restrictions().assertLinesSellable).not.toHaveBeenCalled();
      expect(out[0].restrictedLines).toHaveLength(1);
    });
  });

  describe("createPartialFromOrder", () => {
    const dto = { items: [{ orderItemId: "oi-a", qty: 1 }] } as any;
    const partialSetup = setup;

    it("a banned product on a DRAFT order is refused with the standard 409 and writes nothing", async () => {
      partialSetup("DRAFT", true);
      const err: any = await service.createPartialFromOrder("ord-1", dto).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse().code).toBe(API_ERROR_CODES.SELLING_RESTRICTED);
      expect(restrictions().assertLinesSellable).toHaveBeenCalledWith(
        expect.objectContaining({
          customerId: "cust-1",
          channel: "STAFF",
          lines: [{ productId: "p-a" }],
        }),
      );
      expectNothingWritten();
    });

    it("the send:true path is gated too", async () => {
      partialSetup("DRAFT", true);
      await expect(
        service.createPartialFromOrder("ord-1", { ...dto, send: true }),
      ).rejects.toBeInstanceOf(ConflictException);
      expectNothingWritten();
    });

    it("control: an allowed product on a DRAFT order still creates the partial", async () => {
      partialSetup("DRAFT", false);
      await service.createPartialFromOrder("ord-1", dto);
      expect(prisma.invoice.create).toHaveBeenCalledTimes(1);
    });

    it("control: a non-DRAFT order with the banned product is not refused", async () => {
      partialSetup("PENDING", true);
      await service.createPartialFromOrder("ord-1", dto);
      expect(restrictions().assertLinesSellable).not.toHaveBeenCalled();
      expect(prisma.invoice.create).toHaveBeenCalledTimes(1);
    });
  });
  // F2b: the pre-check runs outside the transaction; the DRAFT can be edited before the write. The
  // transaction re-reads the billed lines under the Order row lock and judges again BEFORE the invoice
  // row exists. (The office path reserves its number before the transaction opens, by design (pool
  // starvation, fix-round-2.md D1), so a refusal here leaves a series gap, never an invoice.)
  describe("F2b: re-judged inside the transaction when the DRAFT changed after the pre-check", () => {
    const dto = { items: [{ orderItemId: "oi-a", qty: 1 }] } as any;
    /** the in-tx read: what the order's lines are NOW */
    const inTx = (status: string, lines: Array<{ id: string; productId: string }>) => {
      prisma.order.findFirst.mockResolvedValue({ status });
      prisma.orderItem.findMany.mockResolvedValue(lines);
    };
    const banPBanned = () =>
      restrictions().assertLinesSellable.mockImplementation(
        async (p: { lines: Array<{ productId: string }> }) => {
          if (p.lines.some((l) => l.productId === "p-banned")) throw refusal();
        },
      );

    it("split: a banned product swapped in after the pre-check is refused in the tx, no invoice, no line bump", async () => {
      setup("DRAFT", false);
      banPBanned();
      inTx("DRAFT", [
        { id: "oi-a", productId: "p-banned" },
        { id: "oi-b", productId: "p-b" },
      ]);

      const err: any = await service.createInvoiceFromOrder("ord-1").catch((e) => e);

      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse().code).toBe(API_ERROR_CODES.SELLING_RESTRICTED);
      expect(restrictions().assertLinesSellable).toHaveBeenCalledTimes(2); // pre-check ok, in-tx refused
      expect(prisma.invoice.create).not.toHaveBeenCalled();
      expect(prisma.orderItem.updateMany).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
      expect(sendSpy).not.toHaveBeenCalled();
    });

    it("partial: the same race is refused in the tx and writes no invoice", async () => {
      setup("DRAFT", false);
      banPBanned();
      inTx("DRAFT", [{ id: "oi-a", productId: "p-banned" }]);

      const err: any = await service.createPartialFromOrder("ord-1", dto).catch((e) => e);

      expect(err.getResponse().code).toBe(API_ERROR_CODES.SELLING_RESTRICTED);
      expect(prisma.invoice.create).not.toHaveBeenCalled();
      expect(prisma.orderItem.updateMany).not.toHaveBeenCalled();
    });

    it("control: an unchanged product set is not judged a second time", async () => {
      setup("DRAFT", false);
      inTx("DRAFT", [
        { id: "oi-a", productId: "p-a" },
        { id: "oi-b", productId: "p-b" },
      ]);

      await service.createInvoiceFromOrder("ord-1");

      expect(restrictions().assertLinesSellable).toHaveBeenCalledTimes(1);
      expect(prisma.invoice.create).toHaveBeenCalledTimes(1);
    });

    it("control: a DRAFT promoted meanwhile (judged by its promotion) is not re-judged here", async () => {
      setup("DRAFT", false);
      banPBanned();
      inTx("PENDING", [{ id: "oi-a", productId: "p-banned" }]);

      await service.createPartialFromOrder("ord-1", dto);

      expect(restrictions().assertLinesSellable).toHaveBeenCalledTimes(1);
      expect(prisma.invoice.create).toHaveBeenCalledTimes(1);
    });

    it("a billed line deleted since the pre-check is a retryable 409 and writes nothing", async () => {
      setup("DRAFT", false);
      inTx("DRAFT", []); // oi-a is gone

      await expect(service.createPartialFromOrder("ord-1", dto)).rejects.toMatchObject({
        response: { code: API_ERROR_CODES.ORDER_CHANGED_DURING_EDIT },
      });
      expect(prisma.invoice.create).not.toHaveBeenCalled();
    });
  });
});
