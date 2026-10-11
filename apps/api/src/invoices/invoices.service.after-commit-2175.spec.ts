/**
 * #2175 (ruling SA-487, option A) — InvoicesService's realtime `emitInvoiceUpdated` leaves a
 * transaction only AFTER that transaction commits (common/after-commit.ts).
 *
 * Before: every emit fired from INSIDE `tenantTransaction(...)`, so a later rollback (a failed
 * commit, a serialization retry) had already told operators and buyers about a change that never
 * happened. Now a tx-owning method queues its emits on an `AfterCommit` via `withAfterCommit`, and
 * an InTx helper takes its caller's queue.
 *
 * Pins, per site:
 *  - tx-owning methods (recordPayment, updatePayment, deletePayment, deleteInvoice, voidPayment,
 *    setCheckStatus — both branches): a FORCED COMMIT FAILURE (the body runs to completion, the
 *    "commit" then rejects) emits NOTHING, with the write right before the emit proven reached;
 *    a successful commit emits EXACTLY ONCE, and not before the transaction promise resolves.
 *  - caller-owned-queue helpers (recordDeliveryPaymentInTx, resyncOrderInvoicesForEdit,
 *    reconcileOrderDraftInvoice's deposit-mirror branch): nothing is sent until the caller's
 *    `after.flush()`; a caller tx without its queue is refused.
 *
 * Split out of invoices.service.spec.ts per the size ratchet; the bootstrap is copied from
 * invoices.service.b2256-due-date.spec.ts so this file stays self-contained.
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
import { AfterCommit } from "../common/after-commit";
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";

describe("InvoicesService — #2175 realtime emits leave the transaction only after it commits", () => {
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
        { provide: EntitlementsService, useValue: mockEntitlements },
        entitlementAuthorityFromEntitlements, // #2241
        { provide: CommissionEngineService, useValue: mockCommissionEngine },
        { provide: NumberingService, useValue: mockNumbering },
      ],
    }).compile();

    service = module.get<InvoicesService>(InvoicesService);
  });
  beforeEach(() => {
    mockGateway.emitInvoiceUpdated.mockClear();
    mockCommissionEngine.syncInvoiceCommissionSafe.mockClear();
  });

  // The tx client is the prisma mock itself (as the sibling specs do).
  /** The body runs to completion (reaching the emit line), THEN the commit rejects. */
  function failTheCommit() {
    prisma.tenantTransaction.mockImplementation(async (fn: any) => {
      await fn(prisma);
      throw new Error("commit failed");
    });
  }
  /** A commit that succeeds — and proves no emit left while the tx was still open. */
  function commitCheckingNoEmitInside() {
    prisma.tenantTransaction.mockImplementation(async (fn: any) => {
      const r = await fn(prisma);
      expect(mockGateway.emitInvoiceUpdated).not.toHaveBeenCalled();
      return r;
    });
  }
  function expectOneEmitFor(invoiceId: string) {
    expect(mockGateway.emitInvoiceUpdated).toHaveBeenCalledTimes(1);
    const [tenantId, payload] = mockGateway.emitInvoiceUpdated.mock.calls[0] as any[];
    expect(tenantId).toBe("test-tenant");
    expect(payload.invoiceId).toBe(invoiceId);
  }

  const invoiceRow = (over: any = {}) => ({
    id: "inv-1",
    invoiceNumber: "INV-1",
    customerId: "c1",
    status: InvoiceStatus.SENT,
    total: 100,
    subtotal: 100,
    dueDate: null,
    paidAt: null,
    orderId: null,
    payments: [],
    ...over,
  });
  const paidRow = (over: any = {}) => ({
    id: "pay-1",
    amount: 30,
    status: "PAID",
    method: "CASH",
    imageKey: null,
    ...over,
  });

  // ─── Sites 1-6: tx-owning methods ─────────────────────────────────────────

  type Site = {
    name: string;
    arrange: () => void;
    act: () => Promise<unknown>;
    /** The write right before the emit — proves the failed-commit body reached the emit line. */
    lastWrite: () => jest.Mock;
    invoiceId: string;
  };

  const sites: Site[] = [
    {
      name: "recordPayment",
      arrange: () => {
        prisma.invoice.findUnique.mockResolvedValue(invoiceRow());
        prisma.paymentCounter.upsert.mockResolvedValue({ next: 2 });
        prisma.invoicePayment.create.mockResolvedValue({ id: "pay-new" });
        prisma.invoice.update.mockResolvedValue(invoiceRow({ status: InvoiceStatus.PARTIAL }));
      },
      act: () => service.recordPayment("inv-1", { amount: 40, method: "CASH" } as any),
      lastWrite: () => prisma.invoice.update,
      invoiceId: "inv-1",
    },
    {
      name: "updatePayment",
      arrange: () => {
        prisma.invoice.findUnique.mockResolvedValue(invoiceRow({ payments: [paidRow()] }));
        prisma.invoicePayment.update.mockResolvedValue({});
        prisma.invoice.update.mockResolvedValue(invoiceRow({ status: InvoiceStatus.PARTIAL }));
      },
      act: () => service.updatePayment("inv-1", "pay-1", { amount: 40, method: "CASH" } as any),
      lastWrite: () => prisma.invoice.update,
      invoiceId: "inv-1",
    },
    {
      name: "deletePayment",
      arrange: () => {
        prisma.invoice.findUnique.mockResolvedValue(invoiceRow({ payments: [paidRow()] }));
        prisma.invoicePayment.delete.mockResolvedValue({});
        prisma.invoice.update.mockResolvedValue(invoiceRow());
      },
      act: () => service.deletePayment("inv-1", "pay-1"),
      lastWrite: () => prisma.invoice.update,
      invoiceId: "inv-1",
    },
    {
      name: "deleteInvoice",
      arrange: () => {
        prisma.invoice.findUnique.mockResolvedValue(invoiceRow());
        prisma.creditNote.findMany.mockResolvedValue([]);
        prisma.invoice.delete.mockResolvedValue({});
      },
      act: () => service.deleteInvoice("inv-1"),
      lastWrite: () => prisma.invoice.delete,
      invoiceId: "inv-1",
    },
    {
      name: "voidPayment",
      arrange: () => {
        prisma.invoicePayment.findFirst.mockResolvedValue(paidRow());
        prisma.invoicePayment.update.mockResolvedValue({});
        prisma.invoice.findUnique.mockResolvedValue(
          invoiceRow({
            status: InvoiceStatus.PARTIAL,
            payments: [paidRow()],
            order: { routeRunId: null, routeRunStopId: null },
          }),
        );
        prisma.invoice.update.mockResolvedValue({});
      },
      act: () => service.voidPayment("inv-1", "pay-1"),
      lastWrite: () => prisma.invoice.update,
      invoiceId: "inv-1",
    },
    {
      name: "setCheckStatus (DEPOSITED/CLEARED branch)",
      arrange: () => {
        prisma.invoicePayment.findFirst.mockResolvedValue(
          paidRow({ method: "CHECK", checkStatus: "RECORDED" }),
        );
        prisma.invoicePayment.update.mockResolvedValue({});
        prisma.invoice.findFirst.mockResolvedValue(invoiceRow({ status: InvoiceStatus.PARTIAL }));
      },
      act: () => service.setCheckStatus("inv-1", "pay-1", { status: "DEPOSITED" } as any),
      lastWrite: () => prisma.invoicePayment.update,
      invoiceId: "inv-1",
    },
    {
      name: "setCheckStatus (BOUNCED branch)",
      arrange: () => {
        prisma.invoicePayment.findFirst.mockResolvedValue(
          paidRow({ method: "CHECK", checkStatus: "DEPOSITED" }),
        );
        prisma.invoicePayment.updateMany.mockResolvedValue({ count: 1 });
        prisma.invoice.findUnique.mockResolvedValue(
          invoiceRow({ status: InvoiceStatus.PARTIAL, payments: [paidRow({ method: "CHECK" })] }),
        );
        prisma.invoiceItem.create.mockResolvedValue({});
        prisma.invoice.update.mockResolvedValue({});
      },
      act: () =>
        service.setCheckStatus("inv-1", "pay-1", { status: "BOUNCED", nsfFeeAmount: 25 } as any),
      lastWrite: () => prisma.invoice.update,
      invoiceId: "inv-1",
    },
  ];

  describe.each(sites.map((s) => [s.name, s] as const))("%s", (_name, site) => {
    it("a forced commit failure emits NOTHING (the body did reach the emit line)", async () => {
      site.arrange();
      failTheCommit();

      await expect(site.act()).rejects.toThrow("commit failed");

      expect(site.lastWrite()).toHaveBeenCalled();
      expect(mockGateway.emitInvoiceUpdated).not.toHaveBeenCalled();
    });

    it("a successful commit emits EXACTLY once, only after the transaction resolved", async () => {
      site.arrange();
      commitCheckingNoEmitInside();

      await site.act();

      expectOneEmitFor(site.invoiceId);
    });
  });

  // ─── Site 7: recordDeliveryPaymentInTx — the caller's queue ───────────────

  describe("recordDeliveryPaymentInTx (caller-owned queue)", () => {
    const payable = [
      {
        id: "inv-a",
        total: 100,
        status: InvoiceStatus.SENT,
        dueDate: null,
        invoiceNumber: "INV-A",
        customerId: "c1",
      },
      {
        id: "inv-b",
        total: 50,
        status: InvoiceStatus.SENT,
        dueDate: null,
        invoiceNumber: "INV-B",
        customerId: "c1",
      },
    ];

    beforeEach(() => {
      prisma.invoice.findMany.mockResolvedValue(payable.map((p) => ({ ...p })));
      prisma.invoice.findUnique.mockImplementation(async ({ where }: any) => ({
        status: payable.find((p) => p.id === where.id)?.status,
      }));
      prisma.invoicePayment.findMany.mockResolvedValue([]);
      prisma.paymentCounter.upsert.mockResolvedValue({ next: 2 });
      prisma.invoicePayment.create.mockResolvedValue({ id: "pay-x" });
      prisma.invoice.update.mockResolvedValue({});
    });

    it("sends nothing until the caller flushes; the flush sends one emit per invoice paid", async () => {
      const after = new AfterCommit();

      const res = await (service as any).recordDeliveryPaymentInTx(
        prisma,
        after,
        ["ord-1"],
        150,
        "CASH",
      );

      expect(res.invoiceIds).toEqual(["inv-a", "inv-b"]);
      expect(prisma.invoice.update).toHaveBeenCalledTimes(2);
      expect(mockGateway.emitInvoiceUpdated).not.toHaveBeenCalled();

      after.flush();

      expect(mockGateway.emitInvoiceUpdated).toHaveBeenCalledTimes(2);
      const ids = mockGateway.emitInvoiceUpdated.mock.calls.map((c: any) => c[1].invoiceId);
      expect(ids.sort()).toEqual(["inv-a", "inv-b"]);
    });
  });

  // ─── Site 8: resyncOrderInvoicesForEdit ───────────────────────────────────

  describe("resyncOrderInvoicesForEdit (caller tx)", () => {
    function armResync() {
      prisma.invoice.findMany.mockResolvedValue([
        {
          id: "inv-1",
          status: InvoiceStatus.SENT,
          deliveryBatchId: null,
          discount: 0,
          shippingFee: 0,
          dueDate: null,
          items: [{ orderItemId: "oi-std" }],
          payments: [{ amount: 30, status: "PAID" }],
        },
      ]);
      prisma.order.findUnique.mockResolvedValue({
        id: "ord-1",
        customerId: "cust-1",
        subtotal: 50,
        tax: 0,
        lineItems: [
          {
            id: "oi-std",
            productId: "p-std",
            qty: 10,
            deliveredQty: 10,
            unitPrice: 5,
            subtotal: 50,
            unitsPerBox: null,
            boxes: null,
            originalPrice: null,
            priceType: "STANDARD",
            notes: null,
            categoryTaxAmount: 0,
            trackedCategoryId: null,
            product: { name: "Std", unitsPerBox: null, trackedCategoryId: null },
          },
        ],
      });
      prisma.customer.findUnique.mockResolvedValue({ isTaxExempt: false });
      prisma.invoiceItem.deleteMany.mockResolvedValue({ count: 1 });
      prisma.invoice.update.mockImplementation((args: any) =>
        Promise.resolve({
          id: args.where.id,
          invoiceNumber: `INV-${args.where.id}`,
          customerId: "cust-1",
          status: args.data.status,
          total: args.data.total,
          items: [],
        }),
      );
      prisma.orderItem.update.mockResolvedValue({});
      prisma.orderItem.findMany.mockResolvedValue([{ id: "oi-std" }]);
    }

    it("refuses a caller tx that does not pass its AfterCommit queue", async () => {
      armResync();
      await expect(service.resyncOrderInvoicesForEdit("ord-1", prisma)).rejects.toThrow(
        "must pass its AfterCommit queue",
      );
      expect(mockGateway.emitInvoiceUpdated).not.toHaveBeenCalled();
    });

    it("with the queue: 0 emits before the flush, one per rebuilt invoice after it", async () => {
      armResync();
      const after = new AfterCommit();

      await service.resyncOrderInvoicesForEdit("ord-1", prisma, after);
      expect(prisma.invoice.update).toHaveBeenCalled();
      expect(mockGateway.emitInvoiceUpdated).not.toHaveBeenCalled();

      after.flush();
      expectOneEmitFor("inv-1");
    });
  });

  // ─── Site 9: reconcileOrderDraftInvoice — deposit-mirror emit ─────────────

  describe("reconcileOrderDraftInvoice deposit mirror (caller tx)", () => {
    function armDepositReconcile() {
      prisma.invoice.findFirst.mockResolvedValue(null); // no open DRAFT pending mirror
      prisma.order.findFirst.mockResolvedValue({ status: "PENDING" });
      prisma.invoice.findMany.mockResolvedValue([
        {
          id: "inv-dep",
          status: InvoiceStatus.SENT,
          deliveryBatchId: null,
          discount: 0,
          shippingFee: 0,
          depositPercent: 50,
          dueDate: new Date("2026-10-01"),
          items: [],
          payments: [{ amount: 20, status: "PAID" }],
        },
      ]);
      prisma.order.findUnique.mockResolvedValue({
        id: "o-dep",
        customerId: "c1",
        subtotal: 50,
        tax: 5,
        lineItems: [
          {
            id: "li1",
            productId: "p1",
            qty: 10,
            deliveredQty: 10,
            unitPrice: 5,
            originalPrice: null,
            priceType: "STANDARD",
            product: { name: "P1" },
            status: "PENDING",
          },
        ],
      });
      prisma.customer.findFirst.mockResolvedValue({ isTaxExempt: false });
      prisma.invoiceItem.deleteMany.mockResolvedValue({});
      prisma.invoice.update.mockImplementation((args: any) =>
        Promise.resolve({ id: "inv-dep", ...args.data }),
      );
      prisma.orderItem.findMany.mockResolvedValue([{ id: "li1" }]);
      prisma.orderItem.update.mockResolvedValue({});
      prisma.invoice.aggregate.mockResolvedValue({ _sum: { shippingFee: 0 } });
    }

    it("with tx + queue: the rebuild is written, nothing is sent until the flush", async () => {
      armDepositReconcile();
      const after = new AfterCommit();

      await service.reconcileOrderDraftInvoice("o-dep", { basis: "order", tx: prisma, after });
      expect(prisma.invoice.update).toHaveBeenCalled();
      expect(mockGateway.emitInvoiceUpdated).not.toHaveBeenCalled();

      after.flush();
      expectOneEmitFor("inv-dep");
    });

    it("refuses a caller tx that does not pass its AfterCommit queue", async () => {
      armDepositReconcile();
      await expect(
        service.reconcileOrderDraftInvoice("o-dep", { basis: "order", tx: prisma }),
      ).rejects.toThrow("must pass its AfterCommit queue");
      expect(mockGateway.emitInvoiceUpdated).not.toHaveBeenCalled();
    });
  });
});
