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

// Mock InvoicesService first: Jest must not traverse invoice-pdf.service.ts (@react-pdf/renderer is ESM-only)
jest.mock("../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({
    createFromOrder: jest.fn().mockResolvedValue({ id: "inv-1" }),
    findAll: jest.fn().mockResolvedValue({ data: [], meta: {} }),
  })),
}));

// Mock NotificationsService: it imports expo-server-sdk, which is ESM-only and fails Jest's CJS parser.
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

const MOCK_PRODUCT = {
  id: "prod-1",
  name: "Tomatoes",
  pricePerUnit: 4.99,
  unit: "punnet",
};

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

/** "YYYY-MM-DD" offset from today — negative n yields a future date. */
const isoDaysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

const operatorPayload = {
  sub: "user-op",
  username: "operator",
  role: "OPERATOR" as const,
  status: "ACTIVE" as const,
  forcePasswordChange: false,
};

const customerPayload = {
  sub: "user-cust",
  username: "customer1",
  role: "CUSTOMER" as const,
  tenantId: "test-tenant",
  status: "ACTIVE" as const,
  forcePasswordChange: false,
};

/**
 * F10(b) (shipping-flow polish): the customer PUSH for a carrier (SHIP) order marked shipped says
 * "shipped", not "Out for Delivery". ROUTE orders keep today's wording; PICKUP wording is owned by #3211.
 * Harness copied from orders.service.spec.ts (that file is at its size cap).
 */
describe("OrdersService.changeStatus: customer push wording for a SHIP order (F10b)", () => {
  let service: OrdersService;
  let notificationsService: { sendToCustomer: jest.Mock };
  let prisma: ReturnType<typeof createMockPrisma>;
  let inventoryService: { recordSale: jest.Mock };
  // P5-08b: captured so the credit-guard tests can assert the post-transaction
  // reconcile never runs on a blocked edit — mirrors how inventoryService is
  // captured below.
  let invoicesService: {
    reconcileOrderDraftInvoice: jest.Mock;
    resyncOrderInvoicesForEdit: jest.Mock;
    revertLinkedInvoicesForOrderEdit: jest.Mock;
  };
  // P6-5: captured so trigger tests can assert eventKey/customerId/senderId/vars.
  let messagingService: Record<
    "notify" | "notifyEvent" | "customisedChannels" | "enabledChannels",
    jest.Mock
  >;
  // WP3: captured so the order-scoped credit-note tests can assert
  // sync/settle are called with the right (order id, customer id, selections).
  let creditNotesService: {
    validateSelectionsForCustomer: jest.Mock;
    syncOrderCreditSelections: jest.Mock;
    settleOrderCreditsInTx: jest.Mock;
    releaseOrderCreditsInTx: jest.Mock;
    previewOrderCreditRelease: jest.Mock;
  };
  // WP3: captured so the credit-limit plan-flag tests can assert whether/how
  // hasFlag is consulted under each PLAN_FLAG_ENFORCEMENT state.
  let entitlementsService: { hasFlag: jest.Mock };
  // B323: a recording mock, not the real AsyncLocalStorage-backed class — module-boundary
  // mocking (this file's convention) means we assert sweepAllPendingOrders() CALLS
  // tenantCtx.run(tenantId, fn) with each group's own tenantId (and still invokes fn so
  // the merge underneath runs), rather than re-deriving ALS behavior in a unit test.
  let tenantCtx: { run: jest.Mock };
  let mockQueue: { add: jest.Mock };
  let mockGateway: {
    emitStopCompleted: jest.Mock;
    emitOrderCreated: jest.Mock;
    emitUrgentOrder: jest.Mock;
    emitOrderStatusChanged: jest.Mock;
    emitLowStock: jest.Mock;
  };

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
            customisedChannels: jest.fn().mockResolvedValue([]),
            enabledChannels: jest.fn().mockResolvedValue(["EMAIL", "PORTAL"]),
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
          useValue: { reverseInvoiceEntries: jest.fn().mockResolvedValue(undefined) },
        },
        // B323: sweepAllPendingOrders() re-enters each group's own tenant scope via
        // tenantCtx.run() before calling into anything ambient-scoped.
        { provide: TenantContextService, useValue: tenantCtx },
      ],
    }).compile();

    service = module.get<OrdersService>(OrdersService);
    notificationsService = module.get(NotificationsService);
    inventoryService = module.get(InventoryService);
    invoicesService = module.get(InvoicesService);
    messagingService = module.get(MessagingService);
    creditNotesService = module.get(CreditNotesService);
    entitlementsService = module.get(EntitlementsService);
  });

  const push = async (over: Record<string, unknown>, to: string) => {
    prisma.order.findUnique.mockResolvedValue({ ...MOCK_ORDER, status: "CONFIRMED", ...over });
    prisma.order.update.mockResolvedValue({ ...MOCK_ORDER, status: to, ...over });
    await service.changeStatus("ord-1", { status: to as never }, operatorPayload as never);
    await new Promise((r) => setImmediate(r));
    const call = notificationsService.sendToCustomer.mock.calls[0];
    return { title: call?.[1] as string, body: call?.[2] as string };
  };

  it("a SHIP order marked shipped: the push says shipped, naming the carrier, never 'Out for Delivery'", async () => {
    const { title, body } = await push(
      { fulfillPath: "SHIP", shippingCarrier: "UPS", routeRunId: null },
      "OUT_FOR_DELIVERY",
    );
    expect(title).not.toMatch(/out for delivery/i);
    expect(body).not.toMatch(/on its way|out for delivery/i);
    expect(title).toBe("Order shipped");
    expect(body).toBe("Your order #ORD-123 has shipped with UPS.");
  });

  it("a SHIP order's push carries the tracking when it is already on the order", async () => {
    const { body } = await push(
      {
        fulfillPath: "SHIP",
        shippingCarrier: "UPS",
        shippingTrackingNumber: "1Z999",
        routeRunId: null,
      },
      "OUT_FOR_DELIVERY",
    );
    expect(body).toContain("has shipped with UPS.");
    expect(body).toContain("Tracking: 1Z999");
  });

  it("unchanged: a ROUTE order out for delivery keeps the 'Out for Delivery' push", async () => {
    const { title, body } = await push({ fulfillPath: "ROUTE" }, "OUT_FOR_DELIVERY");
    expect(title).toBe("Out for Delivery 🚚");
    expect(body).toBe("Your order #ORD-123 is on its way!");
  });

  it("unchanged: a SHIP order's other pushes (delivered) keep their wording", async () => {
    const { title } = await push({ fulfillPath: "SHIP", status: "OUT_FOR_DELIVERY" }, "DELIVERED");
    expect(title).toBe("Order Delivered ✓");
  });

  it("a re-mark after an unmark (shippedAt kept) sends no second push, like the email", async () => {
    const { title } = await push(
      {
        fulfillPath: "SHIP",
        shippingCarrier: "UPS",
        shippedAt: new Date("2026-06-20T00:00:00.000Z"),
      },
      "OUT_FOR_DELIVERY",
    );
    expect(title).toBeUndefined();
    expect(notificationsService.sendToCustomer).not.toHaveBeenCalled();
  });

  it("unchanged: a ROUTE order's re-dispatch still pushes (the once-rule is for carrier orders)", async () => {
    const { title } = await push(
      { fulfillPath: "ROUTE", shippedAt: new Date("2026-06-20T00:00:00.000Z") },
      "OUT_FOR_DELIVERY",
    );
    expect(title).toBe("Out for Delivery 🚚");
  });
});
