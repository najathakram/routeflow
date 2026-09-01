/**
 * F07 — order lifecycle: the adjacent behaviours the fix must NOT regress.
 *
 * The GREEN-PRE-FIX half of `orders.lifecycle-conservation.spec.ts`. Its four
 * tests (T4, T7, T9, T14 from
 * `.claude/pipeline/2026-09-01-f07-order-lifecycle/test-plan.md`) are
 * deliberately passing on today's tree, so they live here rather than in the
 * gate file — the F07 red gate runs
 * `orders.lifecycle-conservation.spec.ts` + `invoices.send-settle.spec.ts` and
 * must report `0 passed`. This file is run by the ordinary `src/orders` suite
 * (before AND after the fix), which is exactly where a regression pin belongs.
 *
 * What each one holds down:
 *
 * - **T4 (REG-B56 / R2)** — the EXISTING "payments that must be refunded"
 *   refusal. R2 adds a delivered-goods refusal to the same guard; this pins
 *   that the new branch does not swallow the old message when a cancel is
 *   blocked SOLELY by an external payment. Discriminating today and after.
 * - **T7 (REG-B64 / R5)** — a DRAFT cancel credits back nothing (a draft never
 *   decremented stock). ⚠️ VACUOUS PRE-FIX: no cancel path writes stock at all
 *   on the current tree, so `product.update` never being called holds for every
 *   possible fixture. It only starts discriminating once R4 lands and the
 *   CONFIRMED cancel DOES write stock — at which point it is the proof that
 *   `settleStockForEdit`'s DRAFT guard is reached with the PRE-cancel status.
 * - **T9 (REG-B64 / R6)** — reopening an order with no item-CANCELLED lines (a
 *   pre-F07 cancel) writes no stock, so era consistency holds. ⚠️ Vacuous
 *   pre-fix for the same reason as T7: `reopenOrder` writes no stock in any
 *   scenario today. Discriminating once R6 lands.
 * - **T14 (REG-B105 / R10)** — the existing open-draft reconcile path is
 *   untouched by the DELIVERED else-branch's new retry loop. Discriminating
 *   today and after.
 *
 * Harness is copied verbatim from the gate file (same module-boundary
 * `jest.mock`s for the ESM-only `InvoicesService`/`NotificationsService`
 * imports, same `createMockPrisma()` whose `tenantTransaction` spreads the SAME
 * model mocks into `tx`, same `useValue` collaborator set). No test here spies
 * on a private method: the cancel fixtures prime `assertCancellableOrThrow`'s
 * own reads so the guard passes naturally.
 */

// Mock InvoicesService before it's imported — prevents Jest from traversing
// invoice-pdf.service.ts which imports @react-pdf/renderer (ESM-only module).
jest.mock("../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({
    createFromOrder: jest.fn().mockResolvedValue({ id: "inv-1" }),
    findAll: jest.fn().mockResolvedValue({ data: [], meta: {} }),
    createInvoiceFromOrderWithTenant: jest.fn().mockResolvedValue([{ id: "inv-1" }]),
    findOpenOrderDraft: jest.fn().mockResolvedValue(null),
    reconcileOrderDraftInvoice: jest.fn().mockResolvedValue({ id: "inv-1" }),
    releaseWalletPaymentsInTx: jest.fn().mockResolvedValue({ credits: [], advances: 0 }),
    voidInvoiceInTx: jest.fn().mockResolvedValue({ id: "inv-1", status: "VOID" }),
  })),
}));

// Mock NotificationsService — it imports expo-server-sdk which is ESM-only
// and fails Jest's CommonJS parser.
jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({
    sendToCustomer: jest.fn().mockResolvedValue(undefined),
    sendToDriver: jest.fn().mockResolvedValue(undefined),
  })),
}));

import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, ConflictException } from "@nestjs/common";
import { getQueueToken } from "@nestjs/bull";
import { ConfigService } from "@nestjs/config";

import { OrdersService } from "./orders.service";
import { InvoicesService } from "../invoices/invoices.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { createMockPrisma } from "../testing/prisma-mock";
import { NotificationsService } from "../notifications/notifications.service";
import { InventoryService } from "../inventory/inventory.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { PromotionsService } from "../promotions/promotions.service";
import { MessagingService } from "../messaging/messaging.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";

const MOCK_ORDER = {
  id: "ord-1",
  customerId: "cust-1",
  orderNumber: "ORD-123",
  status: "PENDING" as const,
  source: "APP" as const,
  urgent: false,
  subtotal: 0,
  tax: 0,
  total: 0,
  notes: null as string | null,
  driverNote: null,
  routeRunId: null as string | null,
  routeRunStopId: null as string | null,
  deliveredAt: null as Date | null,
  orderDate: null as Date | null,
  fulfillPath: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const operatorPayload = {
  sub: "user-op",
  username: "operator",
  role: "OPERATOR" as const,
  status: "ACTIVE" as const,
  forcePasswordChange: false,
};

describe("OrdersService — F07 lifecycle-conservation pins (green pre-fix)", () => {
  let service: OrdersService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let invoicesService: {
    createInvoiceFromOrderWithTenant: jest.Mock;
    findOpenOrderDraft: jest.Mock;
    reconcileOrderDraftInvoice: jest.Mock;
    releaseWalletPaymentsInTx: jest.Mock;
    voidInvoiceInTx: jest.Mock;
  };
  let creditNotesService: {
    previewOrderCreditRelease: jest.Mock;
    releaseOrderCreditsInTx: jest.Mock;
    settleOrderCreditsInTx: jest.Mock;
  };
  let notificationsService: { sendToCustomer: jest.Mock; sendToDriver: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrisma();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrdersService,
        { provide: PrismaService, useValue: prisma },
        { provide: getQueueToken("invoices"), useValue: { add: jest.fn() } },
        {
          provide: RouteFlowGateway,
          useValue: {
            emitStopCompleted: jest.fn(),
            emitOrderCreated: jest.fn(),
            emitUrgentOrder: jest.fn(),
            emitOrderStatusChanged: jest.fn(),
            emitLowStock: jest.fn(),
          },
        },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(0.1) } },
        {
          provide: InvoicesService,
          useValue: {
            createFromOrder: jest.fn().mockResolvedValue({ id: "inv-1" }),
            createInvoiceFromOrder: jest
              .fn()
              .mockResolvedValue([{ id: "inv-1", invoiceNumber: "INV-1", total: 0 }]),
            createInvoiceFromOrderWithTenant: jest.fn().mockResolvedValue([{ id: "inv-1" }]),
            send: jest.fn().mockResolvedValue({ id: "inv-1", status: "SENT" }),
            findOpenOrderDraft: jest.fn().mockResolvedValue(null),
            reconcileOrderDraftInvoice: jest.fn().mockResolvedValue({ id: "inv-1" }),
            resyncOrderInvoicesForEdit: jest.fn().mockResolvedValue([{ id: "inv-1" }]),
            revertLinkedInvoicesForOrderEdit: jest.fn().mockResolvedValue([]),
            voidInvoice: jest.fn().mockResolvedValue({ id: "inv-1", status: "VOID" }),
            voidInvoiceInTx: jest.fn().mockResolvedValue({ id: "inv-1", status: "VOID" }),
            releaseWalletPaymentsInTx: jest.fn().mockResolvedValue({ credits: [], advances: 0 }),
          },
        },
        {
          provide: SystemConfigService,
          useValue: {
            get: jest.fn().mockResolvedValue(null),
            set: jest.fn().mockResolvedValue(undefined),
            getAll: jest.fn().mockResolvedValue({}),
          },
        },
        {
          provide: NotificationsService,
          useValue: {
            sendToCustomer: jest.fn().mockResolvedValue(undefined),
            sendToDriver: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: InventoryService,
          useValue: { recordSale: jest.fn().mockResolvedValue({}) },
        },
        {
          provide: AuthorizationGuardService,
          useValue: {
            assertAuthorizedOrThrow: jest.fn().mockResolvedValue(undefined),
            checkAuthorized: jest.fn().mockResolvedValue({ blocked: [] }),
          },
        },
        {
          provide: PromotionsService,
          useValue: { activeForCatalog: jest.fn().mockResolvedValue([]) },
        },
        {
          provide: MessagingService,
          useValue: {
            notify: jest.fn().mockResolvedValue([]),
            notifyEvent: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: CreditNotesService,
          useValue: {
            validateSelectionsForCustomer: jest.fn().mockResolvedValue(undefined),
            syncOrderCreditSelections: jest.fn().mockResolvedValue(undefined),
            settleOrderCreditsInTx: jest.fn().mockResolvedValue({ applied: 0, unapplied: 0 }),
            releaseOrderCreditsInTx: jest.fn().mockResolvedValue([]),
            previewOrderCreditRelease: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: CommissionEngineService,
          useValue: {
            syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined),
            syncOrderInvoices: jest.fn().mockResolvedValue(undefined),
            removeInvoiceCommission: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: EntitlementsService,
          useValue: { hasFlag: jest.fn().mockResolvedValue(true) },
        },
        // B65: not yet wired into OrdersService's constructor — a registered-
        // but-unconsumed provider, mirroring the gate file's harness so the two
        // module definitions stay diff-able.
        {
          provide: RegulatedLedgerService,
          useValue: { reverseInvoiceEntries: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();

    service = module.get<OrdersService>(OrdersService);
    invoicesService = module.get(InvoicesService);
    creditNotesService = module.get(CreditNotesService);
    notificationsService = module.get(NotificationsService);
  });

  // ─── T4 (REG-B56 / R2) ────────────────────────────────────────────────────

  it("REG-B56 (T4): an external CASH payment still produces the existing refund-first message — the delivered-goods branch doesn't swallow the payments branch", async () => {
    prisma.order.findUnique.mockResolvedValue({ ...MOCK_ORDER, status: "CONFIRMED" });
    prisma.order.findFirst.mockResolvedValue({
      id: "ord-1",
      status: "CONFIRMED",
      orderNumber: "ORD-1",
    });
    prisma.invoice.findMany.mockResolvedValue([
      {
        id: "inv-1",
        invoiceNumber: "INV-1",
        status: "SENT",
        total: 50,
        payments: [{ method: "CASH", amount: 50, status: "COMPLETED" }],
      },
    ]);
    // Zero delivered units — this cancel is blocked SOLELY by the payment.
    prisma.orderItem.findMany.mockResolvedValue([{ qty: 2, deliveredQty: 0 }]);
    creditNotesService.previewOrderCreditRelease.mockResolvedValue([]);

    const attempt = service.changeStatus("ord-1", { status: "CANCELLED" } as any, operatorPayload);

    await expect(attempt).rejects.toBeInstanceOf(BadRequestException);
    await expect(attempt).rejects.toThrow(/payments that must be refunded/i);
    expect(prisma.order.update).not.toHaveBeenCalled();
  });

  // ─── T7 (REG-B64 / R5) ────────────────────────────────────────────────────

  it("REG-B64 (T7): a DRAFT cancel credits back nothing — a draft never held a stock reservation", async () => {
    prisma.order.findUnique.mockResolvedValue({ ...MOCK_ORDER, status: "DRAFT" });
    // No spy on the private guard: nothing is delivered and no invoice carries
    // external money, so `assertCancellableOrThrow` clears this cancel on its
    // own reads.
    prisma.order.findFirst.mockResolvedValue({
      id: "ord-1",
      status: "DRAFT",
      orderNumber: "ORD-1",
    });
    prisma.orderItem.findMany.mockResolvedValue([
      { id: "li-1", productId: "prod-1", qty: 5, deliveredQty: 0, status: "PENDING" },
    ]);
    prisma.invoice.findMany.mockResolvedValue([]);
    creditNotesService.previewOrderCreditRelease.mockResolvedValue([]);

    await service.changeStatus("ord-1", { status: "CANCELLED" } as any, operatorPayload);

    expect(prisma.product.update).not.toHaveBeenCalled();

    // …and it must not MARK the lines either. The credit and the mark are one
    // decision: `reopenOrder` re-decrements exactly the lines a cancel marked,
    // so marking a line that was never credited makes a draft's
    // cancel→reopen round trip take stock the order never held. Caught by
    // review after the first implementation marked lines unconditionally.
    const flips = (prisma.orderItem.updateMany as jest.Mock).mock.calls.filter(
      (c: any[]) => c[0]?.data?.status === "CANCELLED",
    );
    expect(flips).toHaveLength(0);
  });

  // ─── T9 (REG-B64 / R6) ────────────────────────────────────────────────────

  it("REG-B64 (T9): reopening an order with no item-CANCELLED lines (a pre-F07 cancel) writes no stock at all", async () => {
    prisma.order.findUnique.mockResolvedValue({
      id: "ord-1",
      status: "CANCELLED",
      notes: null,
      lineItems: [],
    });
    prisma.invoice.findFirst.mockResolvedValue(null);
    prisma.orderItem.findMany.mockResolvedValue([]);

    await service.reopenOrder("ord-1");

    expect(prisma.product.update).not.toHaveBeenCalled();
  });

  // ─── T14 (REG-B105 / R10) ─────────────────────────────────────────────────

  it("REG-B105 (T14): an existing open draft still reconciles instead of creating a fresh invoice", async () => {
    prisma.order.findUnique.mockResolvedValue({ ...MOCK_ORDER, status: "CONFIRMED" });
    prisma.order.update.mockResolvedValue({ ...MOCK_ORDER, status: "DELIVERED", total: 100 });
    invoicesService.findOpenOrderDraft.mockResolvedValue({ id: "inv-draft" });

    await service.changeStatus("ord-1", { status: "DELIVERED" } as any, operatorPayload);

    expect(invoicesService.reconcileOrderDraftInvoice).toHaveBeenCalledWith("ord-1", {
      basis: "order",
    });
    expect(invoicesService.createInvoiceFromOrderWithTenant).not.toHaveBeenCalled();
  });

  // ─── T24 (REG-B116 / R16) ─────────────────────────────────────────────────

  it("REG-B116 (T24): a P2002 order-number race still retries the whole create transaction with a fresh sequence", async () => {
    // The test plan originally claimed this was "already pinned by the existing
    // orders.service.spec.ts suite". Review checked: no such test existed
    // anywhere in apps/api, so R16 — "the P2002 retry is unchanged" — was the
    // one requirement the matrix reported as covered while nothing exercised
    // it. B116 rewrites the body of exactly this transaction, so the retry
    // deserves a real pin rather than an assurance.
    prisma.customer.findUnique.mockResolvedValue({ id: "cust-1", user: { status: "ACTIVE" } });
    prisma.customer.findFirst.mockResolvedValue({ pricingTier: 1, fulfillPath: null });
    prisma.product.findMany.mockResolvedValue([
      { id: "prod-1", name: "Widget A", pricePerUnit: 10, unitsPerBox: 0, currentStock: 1000 },
    ]);
    prisma.customerPrice.findMany.mockResolvedValue([]);
    prisma.orderItem.findMany.mockResolvedValue([]);
    prisma.order.findFirst.mockResolvedValue(null);

    const conflict = Object.assign(new Error("Unique constraint failed"), {
      code: "P2002",
      meta: { target: ["tenantId", "orderNumber"] },
    });
    let attempts = 0;
    prisma.order.create.mockImplementation(({ data }: any) => {
      attempts += 1;
      if (attempts < 3) return Promise.reject(conflict);
      return Promise.resolve({
        id: "ord-new",
        orderNumber: "ORD-00003",
        customerId: data.customerId,
        status: data.status,
        total: data.total,
        urgent: false,
        createdAt: new Date(),
        customer: { id: data.customerId, businessName: "Acme Wholesale" },
      });
    });

    const created = await service.create(
      { customerId: "cust-1", items: [{ productId: "prod-1", qty: 1, unitPrice: 9 }] } as any,
      operatorPayload,
    );

    // Two collisions are absorbed and the third attempt wins — the caller sees
    // one order, not an error, and exactly three attempts were made.
    expect(attempts).toBe(3);
    expect(created).toEqual(expect.objectContaining({ id: "ord-new" }));
  });

  // ─── T23 (REG-B105 / R9) ──────────────────────────────────────────────────

  it("REG-B105 (T23): a failed auto-invoice still notifies the customer of the delivery before it reports the failure", async () => {
    prisma.order.findUnique.mockResolvedValue({ ...MOCK_ORDER, status: "CONFIRMED" });
    prisma.order.update.mockResolvedValue({ ...MOCK_ORDER, status: "DELIVERED", total: 100 });
    invoicesService.findOpenOrderDraft.mockResolvedValue(null);
    invoicesService.createInvoiceFromOrderWithTenant.mockRejectedValue(
      new ConflictException("Invoice number conflict — please retry."),
    );

    // R9 reports the failure to the operator…
    await expect(
      service.changeStatus("ord-1", { status: "DELIVERED" } as any, operatorPayload),
    ).rejects.toBeInstanceOf(ConflictException);

    // …but the goods physically arrived, so the customer must still hear about
    // it. Raising inline (the first implementation did) returns early and
    // silently suppresses the delivery push for exactly the orders that most
    // need operator attention.
    expect(notificationsService.sendToCustomer).toHaveBeenCalledWith(
      MOCK_ORDER.customerId,
      expect.stringContaining("Delivered"),
      expect.any(String),
      expect.objectContaining({ orderId: "ord-1" }),
    );
  });
});
