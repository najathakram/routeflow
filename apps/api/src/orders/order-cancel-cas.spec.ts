// SA-429: driver cases here pin other behaviour; ownership is pinned in driver-edit-access*.spec.ts.
jest.mock("./driver-edit-access", () => ({ assertDriverMayEditOrder: jest.fn() }));
import { oversellReaderOffProvider } from "./testing/policy-reader-provider";
import { Test, TestingModule } from "@nestjs/testing";
import {
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
  Logger,
} from "@nestjs/common";
import { getQueueToken } from "@nestjs/bull";
import { ConfigService } from "@nestjs/config";

// The merge paths now run inside a Postgres advisory lock (`common/db-locks.ts`,
// R3). These specs exercise the merge FOLD's money math, not the lock, so run
// the critical section inline — the real helper would open a `pg` pool.
// `lockRowsNoWait` stays REAL: it is a plain `$executeRaw` on the caller's tx (no pool), and the
// pins below assert the SQL it emits and the 409 it maps 55P03 to.
jest.mock("../common/db-locks", () => ({
  ...jest.requireActual("../common/db-locks"),
  withAdvisoryLock: jest.fn(async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  })),
}));

// Mock InvoicesService before it's imported — prevents Jest from traversing
// invoice-pdf.service.ts which imports @react-pdf/renderer (ESM-only module)
jest.mock("../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({
    createFromOrder: jest.fn().mockResolvedValue({ id: "inv-1" }),
    findAll: jest.fn().mockResolvedValue({ data: [], meta: {} }),
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

import { Reflector } from "@nestjs/core";
import { computeLineSubtotal } from "@routeflow/pricing";
import { OrdersService } from "./orders.service";
import { linePieceQty } from "./line-piece-qty";
import { OrdersController } from "./orders.controller";
import { ChangeRequestsService } from "./change-requests.service";
import { ROLES_KEY } from "../auth/decorators/roles.decorator";
import { InvoicesService } from "../invoices/invoices.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { TenantContextService } from "../tenant/tenant-context.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { NotificationsService } from "../notifications/notifications.service";
import { InventoryService } from "../inventory/inventory.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { PromotionsService } from "../promotions/promotions.service";
import { MessagingService } from "../messaging/messaging.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import {
  OrderStatus,
  UserRole,
  Prisma,
  RouteRunStatus,
  RouteRunStopStatus,
  NotificationEvent,
} from "@prisma/client";

/**
 * SA-404f F2 / SA-470 condition 1: the order-cancel status write is a compare-and-set on the
 * cancellable set (updateMany {id, status IN CANCELLABLE}). When the order left that set between
 * the pre-check and the locked write (e.g. a concurrent DELIVERED), the claim counts 0 and the
 * cancel is refused with 409 ORDER_CHANGED_DURING_EDIT BEFORE any stock, credit, invoice or item
 * write. Red on the pre-fix code, whose unconditional order.update cancelled a delivered order.
 * Split out of orders.service.spec.ts (at its size-ratchet ceiling); same bootstrap, duplicated.
 */
const MOCK_ORDER = {
  id: "ord-1",
  customerId: "cust-1",
  orderNumber: "ORD-123",
  status: "PENDING" as const,
  source: "APP" as const,
  urgent: false,
  subtotal: 14.97,
  tax: 1.5,
  total: 16.47,
  notes: null,
  driverNote: null,
  routeRunId: null,
  routeRunStopId: null,
  deliveredAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  customer: { businessName: "Test Business" },
};

const operatorPayload = {
  sub: "user-op",
  username: "operator",
  role: "OPERATOR" as const,
  status: "ACTIVE" as const,
  forcePasswordChange: false,
};

describe("SA-404f F2 — order cancel compare-and-set", () => {
  let service: OrdersService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let inventoryService: { recordSale: jest.Mock };
  let invoicesService: any;
  let messagingService: any;
  let creditNotesService: any;
  let entitlementsService: any;
  let tenantCtx: { run: jest.Mock };
  let mockQueue: { add: jest.Mock };
  let mockGateway: Record<string, jest.Mock>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    prisma.order.updateMany.mockResolvedValue({ count: 1 }); // SA-404f F2: cancel CAS claims
    tenantCtx = { run: jest.fn((_tenantId: string | null, fn: () => unknown) => fn()) };
    mockQueue = { add: jest.fn() };
    mockGateway = {
      emitStopCompleted: jest.fn(),
      emitOrderCreated: jest.fn(),
      emitUrgentOrder: jest.fn(),
      emitOrderStatusChanged: jest.fn(),
      emitLowStock: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        oversellReaderOffProvider,
        OrdersService,
        { provide: PrismaService, useValue: prisma },
        { provide: getQueueToken("invoices"), useValue: mockQueue },
        { provide: RouteFlowGateway, useValue: mockGateway },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue(0.1) },
        },
        {
          provide: InvoicesService,
          useValue: {
            createFromOrder: jest.fn().mockResolvedValue({ id: "inv-1" }),
            // W4: createInvoiceFromOrder now returns an array of sibling invoices.
            createInvoiceFromOrder: jest
              .fn()
              .mockResolvedValue([{ id: "inv-1", invoiceNumber: "INV-1", total: 0 }]),
            createInvoiceFromOrderWithTenant: jest.fn().mockResolvedValue([{ id: "inv-1" }]),
            send: jest.fn().mockResolvedValue({ id: "inv-1", status: "SENT" }),
            findOpenOrderDraft: jest.fn().mockResolvedValue(null),
            reconcileOrderDraftInvoice: jest.fn().mockResolvedValue({ id: "inv-1" }),
            resyncOrderInvoicesForEdit: jest.fn().mockResolvedValue([{ id: "inv-1" }]),
            followPartialPrices: jest.fn().mockResolvedValue({ issuedPartialsUnchanged: [] }),
            projectEditedInvoiceTotals: jest.fn().mockResolvedValue([]),
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
          useValue: {
            recordSale: jest.fn().mockResolvedValue({
              unitCost: new Prisma.Decimal(0),
              stockAfter: new Prisma.Decimal(0),
            }),
          },
        },
        {
          provide: SellingRestrictionsService,
          useValue: {
            assertLinesSellable: jest.fn().mockResolvedValue(undefined),
            checkLinesSellable: jest.fn().mockResolvedValue({ outcome: "OFF", reasons: [] }),
            getPolicy: jest.fn().mockResolvedValue({ enabled: false }),
          },
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
        // B65: deleteOrder's per-invoice teardown reverses regulated-ledger entries.
        {
          provide: RegulatedLedgerService,
          useValue: {
            reverseInvoiceEntries: jest.fn().mockResolvedValue(undefined),
            syncInvoiceEntries: jest.fn(),
          },
        },
        // B323: sweepAllPendingOrders() re-enters each group's own tenant scope via
        // tenantCtx.run() before calling into anything ambient-scoped.
        { provide: TenantContextService, useValue: tenantCtx },
      ],
    }).compile();

    service = module.get<OrdersService>(OrdersService);
    inventoryService = module.get(InventoryService);
    invoicesService = module.get(InvoicesService);
    messagingService = module.get(MessagingService);
    creditNotesService = module.get(CreditNotesService);
    entitlementsService = module.get(EntitlementsService);
  });

  const CONFIRMED = { ...MOCK_ORDER, status: "CONFIRMED" as const };
  const arrange = (claimed: number) => {
    prisma.order.findUnique.mockResolvedValue(CONFIRMED);
    prisma.order.findFirst.mockResolvedValue(CONFIRMED); // cancelImpact's own read
    prisma.order.update.mockResolvedValue({ ...CONFIRMED, status: "CANCELLED" });
    prisma.order.updateMany.mockReset().mockResolvedValue({ count: claimed });
    prisma.invoice.findMany
      .mockResolvedValueOnce([
        { id: "s1", invoiceNumber: "INV-2", status: "SENT", total: 60, payments: [] },
      ])
      .mockResolvedValueOnce([{ id: "s1" }]);
    prisma.orderItem.findMany.mockResolvedValue([]);
  };

  it("claim count 0 (the order left the cancellable set) ⇒ 409 ORDER_CHANGED_DURING_EDIT and NO write after it", async () => {
    arrange(0);
    const err = await service
      .changeStatus("ord-1", { status: "CANCELLED" as any }, operatorPayload as any)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({
      code: "ORDER_CHANGED_DURING_EDIT",
    });
    // The status write is the CAS, never an unconditional update.
    expect(prisma.order.update).not.toHaveBeenCalled();
    expect(prisma.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "ord-1", status: { in: expect.not.arrayContaining(["DELIVERED"]) } },
      }),
    );
    // Nothing after the refused claim: no credit release, no invoice void, no stock or item write.
    expect(creditNotesService.releaseOrderCreditsInTx).not.toHaveBeenCalled();
    expect(invoicesService.releaseWalletPaymentsInTx).not.toHaveBeenCalled();
    expect(invoicesService.voidInvoiceInTx).not.toHaveBeenCalled();
    expect(prisma.orderItem.updateMany).not.toHaveBeenCalled();
    expect(prisma.product.update).not.toHaveBeenCalled();
    expect(prisma.stockMovement.create).not.toHaveBeenCalled();
  });

  it("control: claim count 1 ⇒ the cancel proceeds (credits released, invoice voided)", async () => {
    arrange(1);
    await service.changeStatus("ord-1", { status: "CANCELLED" as any }, operatorPayload as any);
    expect(creditNotesService.releaseOrderCreditsInTx).toHaveBeenCalledWith(
      expect.anything(),
      "ord-1",
    );
    expect(invoicesService.voidInvoiceInTx).toHaveBeenCalledWith(expect.anything(), "s1", "ord-1");
  });

  // Money safety: a cash refund (EXTERNAL_REFUND, refundedAt set) left the till, so voiding the order's invoices would pay
  // it out twice. The guard (invoice-cash-refund-guard.ts) runs right after the Order -> Invoice locks, before ANY write.
  it("a cash-refunded return on the order's invoices ⇒ 409 ORDER_HAS_CASH_REFUND with the ORDER wording and NOTHING is written", async () => {
    arrange(1);
    prisma.return.findFirst.mockResolvedValue({ id: "ret-1" });
    const settle = jest.spyOn(service as any, "settleStockForEdit").mockResolvedValue(undefined);
    const err = await service
      .changeStatus("ord-1", { status: "CANCELLED" as any }, operatorPayload as any)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getStatus()).toBe(409);
    expect((err as ConflictException).getResponse()).toEqual({
      code: "ORDER_HAS_CASH_REFUND",
      message:
        "Part of this order was refunded in cash. Issue a credit note instead of cancelling.",
    });
    // No status claim, no stock credit, no credit release, no wallet release, no void, no item write.
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
    expect(prisma.order.update).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
    expect(creditNotesService.releaseOrderCreditsInTx).not.toHaveBeenCalled();
    expect(invoicesService.releaseWalletPaymentsInTx).not.toHaveBeenCalled();
    expect(invoicesService.voidInvoiceInTx).not.toHaveBeenCalled();
    expect(prisma.orderItem.updateMany).not.toHaveBeenCalled();
    expect(prisma.stockMovement.create).not.toHaveBeenCalled();
  });

  it("the cash-refund guard reads ONCE, before the status claim, the stock credit, the credit release, the wallet release and the void", async () => {
    arrange(1);
    const settle = jest.spyOn(service as any, "settleStockForEdit").mockResolvedValue(undefined);
    await service.changeStatus("ord-1", { status: "CANCELLED" as any }, operatorPayload as any);
    const guardRead = prisma.return.findFirst.mock.invocationCallOrder;
    expect(guardRead).toHaveLength(1);
    const writes: Array<jest.MockInstance<any, any>> = [
      prisma.order.updateMany,
      settle,
      creditNotesService.releaseOrderCreditsInTx,
      invoicesService.releaseWalletPaymentsInTx,
      invoicesService.voidInvoiceInTx,
    ];
    for (const write of writes) {
      expect(write).toHaveBeenCalled();
      expect(guardRead[0]).toBeLessThan(write.mock.invocationCallOrder[0]);
    }
  });

  // #2472 (2): whether the cancel returns stock is decided from the order's status UNDER the cancel
  // lock, never the unlocked pre-read — a DRAFT (which never reserved stock) must not be credited.
  it("#2472: pre-read CONFIRMED but DRAFT under the lock ⇒ no stock credit, no line marking", async () => {
    arrange(1);
    prisma.order.findUnique.mockImplementation(async (args: any) =>
      args?.select && Object.keys(args.select).length === 1 && args.select.status
        ? { status: "DRAFT" }
        : CONFIRMED,
    );
    const settle = jest.spyOn(service as any, "settleStockForEdit").mockResolvedValue(undefined);
    await service.changeStatus("ord-1", { status: "CANCELLED" as any }, operatorPayload as any);
    expect(settle).not.toHaveBeenCalled();
    expect(prisma.orderItem.updateMany).not.toHaveBeenCalled();
  });

  it("#2472 control: CONFIRMED under the lock too ⇒ the stock credit runs", async () => {
    arrange(1);
    const settle = jest.spyOn(service as any, "settleStockForEdit").mockResolvedValue(undefined);
    await service.changeStatus("ord-1", { status: "CANCELLED" as any }, operatorPayload as any);
    expect(settle).toHaveBeenCalledTimes(1);
  });

  // #2472 Opus fold (Opus on #2515): the stock credit itself must run AS the locked status — a DRAFT
  // pre-read promoted to PENDING before the lock took stock, so the cancel must credit it back
  // (settleStockForEdit no-ops on DRAFT; passing the stale pre-read would cancel the lines with no
  // credit and a later reopen would take the stock twice, B64).
  // SA-492b: prove the credit WRITE runs (not only the arg): one active, undelivered line on a stocked
  // product; the real settleStockForEdit must increment the product's stock by it.
  const oneLine = () => {
    prisma.orderItem.findMany.mockResolvedValue([
      {
        productId: "prod-1",
        qty: 5,
        deliveredQty: 0,
        status: "CONFIRMED",
        unitsPerBox: null,
        boxes: null,
        pieces: null,
        unitLabel: null,
      },
    ] as any);
    prisma.product.findMany.mockResolvedValue([
      { id: "prod-1", name: "Tomatoes", currentStock: 10, unitsPerBox: null },
    ] as any);
    prisma.product.update.mockResolvedValue({ id: "prod-1", currentStock: 15 } as any);
  };
  const lockedAs = (preRead: "DRAFT", locked: "PENDING" | "DRAFT") => {
    const pre = { ...MOCK_ORDER, status: preRead };
    prisma.order.findUnique.mockImplementation(async (args: any) =>
      args?.select && Object.keys(args.select).length === 1 && args.select.status
        ? { status: locked }
        : pre,
    );
    prisma.order.findFirst.mockResolvedValue(pre);
  };
  const credit = () =>
    prisma.product.update.mock.calls.find(
      (c: any[]) => c[0]?.data?.currentStock?.increment !== undefined,
    );

  it("#2472 fold: DRAFT pre-read but PENDING under the lock ⇒ the real stock credit WRITES (+5)", async () => {
    arrange(1);
    oneLine();
    lockedAs("DRAFT", "PENDING");
    const settle = jest.spyOn(service as any, "settleStockForEdit"); // NOT mocked
    await service.changeStatus("ord-1", { status: "CANCELLED" as any }, operatorPayload as any);
    expect((settle.mock.calls[0] as any[])[1]).toMatchObject({ id: "ord-1", status: "PENDING" });
    expect(credit()?.[0]).toEqual({
      where: { id: "prod-1" },
      data: { currentStock: { increment: 5 } },
    });
  });

  it("#2472 fold mirror: DRAFT under the lock too ⇒ no credit write (a draft never took stock)", async () => {
    arrange(1);
    oneLine();
    lockedAs("DRAFT", "DRAFT");
    await service.changeStatus("ord-1", { status: "CANCELLED" as any }, operatorPayload as any);
    expect(credit()).toBeUndefined();
  });
});
