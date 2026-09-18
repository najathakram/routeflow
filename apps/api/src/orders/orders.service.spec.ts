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
  status: "ACTIVE" as const,
  forcePasswordChange: false,
};

describe("OrdersService", () => {
  let service: OrdersService;
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
  let messagingService: { notify: jest.Mock; notifyEvent: jest.Mock };
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
          useValue: { reverseInvoiceEntries: jest.fn().mockResolvedValue(undefined) },
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

  // ─── findAll ──────────────────────────────────────────────────────────────

  describe("findAll", () => {
    it("should return paginated orders for operators", async () => {
      prisma.order.findMany.mockResolvedValue([MOCK_ORDER]);
      prisma.order.count.mockResolvedValue(1);

      const result = await service.findAll({ page: 1, limit: 20 }, operatorPayload);

      expect(result.data).toHaveLength(1);
      expect(result.meta.total).toBe(1);
    });

    // ── PR-B: find the orders that contained a given product ────────────────
    it("productId narrows to orders carrying that line, alongside other filters", async () => {
      prisma.order.findMany.mockResolvedValue([]);
      prisma.order.count.mockResolvedValue(0);

      await service.findAll(
        { page: 1, limit: 20, productId: "prod-A", status: "PENDING" as any },
        operatorPayload,
      );

      const where = prisma.order.findMany.mock.calls.at(-1)?.[0].where;
      // AND-ed, not a replacement — the status filter must survive.
      expect(where.lineItems).toEqual({ some: { productId: "prod-A" } });
      expect(where.status).toBe("PENDING");
    });

    it("omits the line filter entirely when no productId is given", async () => {
      prisma.order.findMany.mockResolvedValue([]);
      prisma.order.count.mockResolvedValue(0);

      await service.findAll({ page: 1, limit: 20 }, operatorPayload);

      expect(prisma.order.findMany.mock.calls.at(-1)?.[0].where.lineItems).toBeUndefined();
    });

    it("a CUSTOMER filtering by product stays scoped to their OWN orders", async () => {
      prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
      prisma.order.findMany.mockResolvedValue([]);
      prisma.order.count.mockResolvedValue(0);

      await service.findAll({ page: 1, limit: 20, productId: "prod-A" }, customerPayload);

      const where = prisma.order.findMany.mock.calls.at(-1)?.[0].where;
      expect(where.customerId).toBe("cust-1");
      expect(where.lineItems).toEqual({ some: { productId: "prod-A" } });
    });

    it("should scope to customer when role is CUSTOMER", async () => {
      prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
      prisma.order.findMany.mockResolvedValue([]);
      prisma.order.count.mockResolvedValue(0);

      await service.findAll({ page: 1, limit: 20 }, customerPayload);

      expect(prisma.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ customerId: "cust-1" }),
        }),
      );
    });

    it("should throw ForbiddenException when customer record not found", async () => {
      prisma.customer.findFirst.mockResolvedValue(null);

      await expect(service.findAll({ page: 1, limit: 20 }, customerPayload)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it("should filter by status", async () => {
      prisma.order.findMany.mockResolvedValue([]);
      prisma.order.count.mockResolvedValue(0);

      await service.findAll({ status: "PENDING" as any, page: 1, limit: 20 }, operatorPayload);

      expect(prisma.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: "PENDING" }),
        }),
      );
    });

    it("includes a PENDING-filtered change-request count for the list badge (P5-11)", async () => {
      prisma.order.findMany.mockResolvedValue([]);
      prisma.order.count.mockResolvedValue(0);

      await service.findAll({ page: 1, limit: 20 }, operatorPayload);

      expect(prisma.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          include: expect.objectContaining({
            _count: { select: { changeRequests: { where: { status: "PENDING" } } } },
          }),
        }),
      );
    });

    // ── Ad-hoc trips + fulfillment mode: ListOrdersDto.fulfillPath filter ──
    it("passes fulfillPath through to the where clause when supplied", async () => {
      prisma.order.findMany.mockResolvedValue([]);
      prisma.order.count.mockResolvedValue(0);

      await service.findAll({ page: 1, limit: 20, fulfillPath: "SHIP" as any }, operatorPayload);

      const where = prisma.order.findMany.mock.calls.at(-1)?.[0].where;
      expect(where.fulfillPath).toBe("SHIP");
    });

    it("omits the fulfillPath key entirely when not supplied (every existing order stays visible)", async () => {
      prisma.order.findMany.mockResolvedValue([]);
      prisma.order.count.mockResolvedValue(0);

      await service.findAll({ page: 1, limit: 20 }, operatorPayload);

      expect(prisma.order.findMany.mock.calls.at(-1)?.[0].where).not.toHaveProperty("fulfillPath");
    });
  });

  // ─── T3 (REG-B144) — search composes with customerId/role scope instead of
  // being swallowed by an `else if` chain, and matches order NUMBER as well as
  // customer businessName.
  describe("REG-B144 — search composes with customerId/role scope", () => {
    it("OPERATOR: search alone produces an OR across orderNumber and customer.businessName", async () => {
      prisma.order.findMany.mockResolvedValue([]);
      prisma.order.count.mockResolvedValue(0);

      await service.findAll({ page: 1, limit: 20, search: "ORD-77" } as any, operatorPayload);

      // Assert the WHOLE `where`: today it is `{ customer: { businessName: … } }`
      // (the documented wrong shape), so the failure names the real value rather
      // than reading `undefined` off a key that does not exist yet.
      const where = prisma.order.findMany.mock.calls.at(-1)?.[0].where;
      expect(where).toEqual({
        OR: [
          { orderNumber: { contains: "ORD-77", mode: "insensitive" } },
          { customer: { businessName: { contains: "ORD-77", mode: "insensitive" } } },
        ],
      });
    });

    it("OPERATOR: customerId AND search compose — neither swallows the other", async () => {
      prisma.order.findMany.mockResolvedValue([]);
      prisma.order.count.mockResolvedValue(0);

      await service.findAll(
        { page: 1, limit: 20, customerId: "c1", search: "ORD-77" } as any,
        operatorPayload,
      );

      const where = prisma.order.findMany.mock.calls.at(-1)?.[0].where;
      // Control (passes today): the customer scope is applied either way.
      expect(where.customerId).toBe("c1");
      // Distinguisher: today the whole `where` is `{ customerId: "c1" }` — the
      // `else if` chain drops `search` entirely.
      expect(where).toEqual({
        customerId: "c1",
        OR: [
          { orderNumber: { contains: "ORD-77", mode: "insensitive" } },
          { customer: { businessName: { contains: "ORD-77", mode: "insensitive" } } },
        ],
      });
    });

    it("CUSTOMER role: search stays scoped to the caller's own orders AND composes the OR", async () => {
      prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
      prisma.order.findMany.mockResolvedValue([]);
      prisma.order.count.mockResolvedValue(0);

      await service.findAll({ page: 1, limit: 20, search: "ORD-77" } as any, customerPayload);

      const where = prisma.order.findMany.mock.calls.at(-1)?.[0].where;
      // Control (passes today): the caller stays scoped to their own orders.
      expect(where.customerId).toBe("cust-1");
      // Distinguisher: today the whole `where` is `{ customerId: "cust-1" }` —
      // the CUSTOMER branch swallows `search`.
      expect(where).toEqual({
        customerId: "cust-1",
        OR: [
          { orderNumber: { contains: "ORD-77", mode: "insensitive" } },
          { customer: { businessName: { contains: "ORD-77", mode: "insensitive" } } },
        ],
      });
    });
  });

  // ─── T2 (REG-B169) — orderBy carries an id tiebreaker (createdAt ties are
  // structural: every line in one bulk create/import shares the same tx clock).
  describe("REG-B169 — orderBy carries an id tiebreaker", () => {
    it("default sort orders by createdAt desc, id desc", async () => {
      prisma.order.findMany.mockResolvedValue([]);
      prisma.order.count.mockResolvedValue(0);

      await service.findAll({ page: 1, limit: 20 } as any, operatorPayload);

      expect(prisma.order.findMany.mock.calls.at(-1)?.[0].orderBy).toEqual([
        { createdAt: "desc" },
        { id: "desc" },
      ]);
    });
  });

  // ─── findOne ──────────────────────────────────────────────────────────────

  describe("findOne", () => {
    it("should return an order for operators", async () => {
      prisma.order.findUnique.mockResolvedValue(MOCK_ORDER);
      const result = await service.findOne("ord-1", operatorPayload);
      expect(result).toEqual(MOCK_ORDER);
    });

    it("should throw NotFoundException when order does not exist", async () => {
      prisma.order.findUnique.mockResolvedValue(null);
      await expect(service.findOne("nonexistent", operatorPayload)).rejects.toThrow(
        NotFoundException,
      );
    });

    it("should throw ForbiddenException when customer does not own the order", async () => {
      prisma.order.findUnique.mockResolvedValue(MOCK_ORDER);
      prisma.customer.findFirst.mockResolvedValue({ id: "cust-other" });

      await expect(service.findOne("ord-1", customerPayload)).rejects.toThrow(ForbiddenException);
    });
  });

  // ─── Security: F2-005 (driver order-detail scope + urgent) / F10-002 ────────
  describe("security — F2-005 / F10-002", () => {
    const driverPayload = {
      sub: "user-drv",
      username: "driver1",
      role: "DRIVER" as const,
      status: "ACTIVE" as const,
      forcePasswordChange: false,
    };

    // ── F2-005: findOne driver-ownership gate ──────────────────────────────
    it("F2-005: DRIVER cannot read an order on another driver's run (403)", async () => {
      prisma.order.findUnique.mockResolvedValue({
        ...MOCK_ORDER,
        routeRun: { status: "SCHEDULED", startedAt: null, driverId: "drv-2" },
        revisions: [],
      });
      prisma.driver.findFirst.mockResolvedValue({ id: "drv-1" });

      await expect(service.findOne("ord-1", driverPayload)).rejects.toThrow(ForbiddenException);
    });

    it("F2-005: DRIVER cannot read an order that is not on any run (403)", async () => {
      prisma.order.findUnique.mockResolvedValue({ ...MOCK_ORDER, routeRun: null, revisions: [] });
      prisma.driver.findFirst.mockResolvedValue({ id: "drv-1" });

      await expect(service.findOne("ord-1", driverPayload)).rejects.toThrow(ForbiddenException);
    });

    it("F2-005: DRIVER CAN read an order on a run they are assigned to (200)", async () => {
      prisma.order.findUnique.mockResolvedValue({
        ...MOCK_ORDER,
        routeRun: { status: "SCHEDULED", startedAt: null, driverId: "drv-1" },
        revisions: [],
      });
      prisma.driver.findFirst.mockResolvedValue({ id: "drv-1" });

      const result = await service.findOne("ord-1", driverPayload);
      expect(result.id).toBe("ord-1");
    });

    it("F2-005: OPERATOR still reads any order without a driver lookup", async () => {
      prisma.order.findUnique.mockResolvedValue({ ...MOCK_ORDER, revisions: [] });
      const result = await service.findOne("ord-1", operatorPayload);
      expect(result.id).toBe("ord-1");
      expect(prisma.driver.findFirst).not.toHaveBeenCalled();
    });

    // ── F2-005: DRIVER denied on PATCH /:id/urgent at the controller guard ──
    it("F2-005: toggleUrgent @Roles excludes DRIVER (OPERATOR + CUSTOMER only)", () => {
      const roles = new Reflector().get(ROLES_KEY, OrdersController.prototype.toggleUrgent);
      expect(roles).toEqual([UserRole.OPERATOR, UserRole.CUSTOMER]);
      expect(roles).not.toContain(UserRole.DRIVER);
    });

    // ── F10-002: a CUSTOMER edit of a CONFIRMED order forces re-confirmation ─
    const confirmedForEdit = () => ({
      ...MOCK_ORDER,
      status: "CONFIRMED" as const,
      routeRun: null,
      lineItems: [
        {
          id: "li-1",
          orderId: "ord-1",
          productId: "prod-1",
          qty: 2,
          unitPrice: 5,
          subtotal: 10,
          status: "PENDING",
          boxes: null,
          pieces: null,
          priceType: "STANDARD",
          originalPrice: null,
        },
      ],
    });

    const editDto = { items: [{ id: "li-1", action: "UPDATE" as const, qty: 3, unitPrice: 5 }] };

    function primeEditMocks() {
      prisma.order.findUnique.mockResolvedValue(confirmedForEdit());
      prisma.orderItem.findMany.mockResolvedValue([
        { id: "li-1", productId: "prod-1", qty: 3, unitPrice: 5, subtotal: 15, status: "PENDING" },
      ]);
      prisma.orderRevision.aggregate.mockResolvedValue({ _max: { revisionNumber: null } });
      // The CUSTOMER edit path re-checks order ownership inside the tx; make the
      // signed-in customer own MOCK_ORDER (customerId "cust-1"). Ignored by the
      // OPERATOR/DRIVER paths.
      prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
      prisma.product.findMany.mockResolvedValue([
        {
          id: "prod-1",
          name: "Tomatoes",
          pricePerUnit: 5,
          unit: "punnet",
          trackedCategoryId: null,
        },
      ]);
    }

    it("F10-002: CUSTOMER editing a CONFIRMED order reverts it to PENDING", async () => {
      primeEditMocks();

      // Buyers send the full item list ({productId, qty}) — a diff-shaped
      // payload is rejected on the customer path (A4), so this test uses the
      // shape the buyer portals actually send.
      await service.updateOrderItems(
        "ord-1",
        { items: [{ productId: "prod-1", qty: 3 }] },
        customerPayload,
      );

      expect(prisma.order.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "ord-1" },
          data: expect.objectContaining({ status: "PENDING" }),
        }),
      );
    });

    it("F10-002: OPERATOR editing a CONFIRMED order still reverts it to PENDING", async () => {
      primeEditMocks();

      await service.updateOrderItems("ord-1", editDto, operatorPayload);

      const lastUpdate = prisma.order.update.mock.calls.at(-1)?.[0];
      expect(lastUpdate.data.status).toBe("PENDING");
    });

    it("F10-002: a DRIVER edit does NOT silently revert the order", async () => {
      primeEditMocks();

      await service.updateOrderItems("ord-1", editDto, driverPayload);

      const lastUpdate = prisma.order.update.mock.calls.at(-1)?.[0];
      expect(lastUpdate.data.status).toBeUndefined();
    });
  });

  // ─── getOrderTracking (F2-002 ownership) ────────────────────────────────────
  describe("getOrderTracking", () => {
    it("throws ForbiddenException when a customer requests another customer's order", async () => {
      prisma.order.findUnique.mockResolvedValue({ ...MOCK_ORDER, routeRunStop: null });
      prisma.customer.findFirst.mockResolvedValue({ id: "cust-other" });

      await expect(service.getOrderTracking("ord-1", customerPayload)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it("returns tracking for the owning customer", async () => {
      prisma.order.findUnique.mockResolvedValue({ ...MOCK_ORDER, routeRunStop: null });
      prisma.customer.findFirst.mockResolvedValue({ id: MOCK_ORDER.customerId });

      const result = await service.getOrderTracking("ord-1", customerPayload);
      expect(result).toEqual({ status: MOCK_ORDER.status, tracking: null });
    });

    it("does not run an ownership lookup for operators", async () => {
      prisma.order.findUnique.mockResolvedValue({ ...MOCK_ORDER, routeRunStop: null });

      await service.getOrderTracking("ord-1", operatorPayload);
      expect(prisma.customer.findFirst).not.toHaveBeenCalled();
    });
  });

  // ─── create ───────────────────────────────────────────────────────────────

  describe("create", () => {
    it("should create an order with correct subtotal, tax, and total", async () => {
      prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
      prisma.product.findMany.mockResolvedValue([MOCK_PRODUCT]);
      prisma.order.create.mockResolvedValue(MOCK_ORDER);
      // Tax rate is read from SystemConfigService at request time; seed 10%
      (service as any).systemConfig.get.mockImplementation((key: string) =>
        key === "settings.taxRate" ? "10" : null,
      );

      const result = await service.create(
        { items: [{ productId: "prod-1", qty: 3 }], urgent: false },
        customerPayload,
      );

      // Totals are rounded to cents (money discipline): 14.97, tax 1.497→1.50,
      // total 14.97+1.50 = 16.47 (not the raw FP 16.467000000000002).
      expect(prisma.order.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            customerId: "cust-1",
            subtotal: 14.97,
            tax: 1.5,
            total: 16.47,
          }),
        }),
      );
    });

    it("P5-04: applies the best active promotion to a buyer line (net unitPrice + originalPrice + PROMO)", async () => {
      prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
      prisma.customer.findUnique.mockResolvedValue({ pricingTier: 1 });
      prisma.customerPrice.findMany.mockResolvedValue([]);
      prisma.product.findMany.mockResolvedValue([MOCK_PRODUCT]); // pricePerUnit 4.99
      prisma.order.create.mockResolvedValue(MOCK_ORDER);
      (service as any).systemConfig.get.mockResolvedValue("0");
      // Two matching promos → the lower net (20% off) must win.
      (service as any).promotionsService.activeForCatalog.mockResolvedValue([
        {
          id: "promo-a",
          type: "PERCENT",
          value: 10,
          minQty: null,
          scope: "ALL",
          category: null,
          productIds: [],
        },
        {
          id: "promo-b",
          type: "PERCENT",
          value: 20,
          minQty: null,
          scope: "ALL",
          category: null,
          productIds: [],
        },
      ]);

      await service.create({ items: [{ productId: "prod-1", qty: 3 }] }, customerPayload);

      // 20% off $4.99 → $3.99 net; strikethrough $4.99; PROMO; subtotal 3 × 3.99 = 11.97.
      expect(prisma.order.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            lineItems: {
              create: expect.arrayContaining([
                expect.objectContaining({
                  productId: "prod-1",
                  unitPrice: 3.99,
                  originalPrice: 4.99,
                  priceType: "PROMO",
                  subtotal: 11.97,
                }),
              ]),
            },
          }),
        }),
      );
    });

    it("P5-04: does NOT apply promotions to an operator-created order (staff path unchanged)", async () => {
      prisma.customer.findUnique.mockResolvedValue({ pricingTier: 1, user: { status: "ACTIVE" } });
      prisma.customerPrice.findMany.mockResolvedValue([]);
      prisma.product.findMany.mockResolvedValue([MOCK_PRODUCT]);
      prisma.order.create.mockResolvedValue(MOCK_ORDER);
      (service as any).systemConfig.get.mockResolvedValue("0");
      const activeForCatalog = (service as any).promotionsService.activeForCatalog as jest.Mock;
      activeForCatalog.mockResolvedValue([
        {
          id: "promo-a",
          type: "PERCENT",
          value: 20,
          minQty: null,
          scope: "ALL",
          category: null,
          productIds: [],
        },
      ]);

      await service.create(
        { customerId: "cust-1", items: [{ productId: "prod-1", qty: 3 }] } as any,
        operatorPayload,
      );

      // Promotions are never even fetched for staff, and the line stays at list price.
      expect(activeForCatalog).not.toHaveBeenCalled();
      expect(prisma.order.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            lineItems: {
              create: expect.arrayContaining([
                expect.objectContaining({
                  unitPrice: 4.99,
                  priceType: "STANDARD",
                  originalPrice: null,
                }),
              ]),
            },
          }),
        }),
      );
    });

    // ── Tier ladder (previously zero coverage — every earlier test mocked tier 1) ──

    const TIERED_PRODUCT = {
      id: "prod-1",
      name: "Tomatoes",
      pricePerUnit: 10,
      priceTier3: 8,
      priceTier4: 0, // DB default — tier never configured
      priceTier5: 7,
      unit: "each",
    };

    /** Buyer-path mocks for a customer on `tier`, no promos, no overrides. */
    const seedBuyerTierMocks = (tier: number) => {
      // customer.findFirst now serves BOTH the buyer's own-record lookup (where.userId)
      // and the pricingTier read (where.id — findUnique's exclusive select dropped tenantId).
      prisma.customer.findFirst.mockImplementation(({ where }: any) =>
        Promise.resolve(where?.id ? { pricingTier: tier } : { id: "cust-1" }),
      );
      prisma.customerPrice.findMany.mockResolvedValue([]);
      prisma.product.findMany.mockResolvedValue([TIERED_PRODUCT]);
      prisma.order.create.mockResolvedValue(MOCK_ORDER);
      (service as any).systemConfig.get.mockResolvedValue("0");
      (service as any).promotionsService.activeForCatalog.mockResolvedValue([]);
    };

    it("bills a tier-3 customer the tier-3 price as SPECIAL with the list strikethrough", async () => {
      seedBuyerTierMocks(3);

      await service.create({ items: [{ productId: "prod-1", qty: 2 }] }, customerPayload);

      expect(prisma.order.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            lineItems: {
              create: expect.arrayContaining([
                expect.objectContaining({
                  unitPrice: 8,
                  originalPrice: 10,
                  priceType: "SPECIAL",
                  subtotal: 16,
                }),
              ]),
            },
          }),
        }),
      );
    });

    it("R2: stamps each line's position from the scan/array order (0-based)", async () => {
      seedBuyerTierMocks(1);
      await service.create({ items: [{ productId: "prod-1", qty: 1 }] }, customerPayload);
      expect(prisma.order.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            lineItems: {
              create: expect.arrayContaining([expect.objectContaining({ position: 0 })]),
            },
          }),
        }),
      );
    });

    it("a per-product CustomerPrice override beats the customer's default tier", async () => {
      seedBuyerTierMocks(1); // default tier 1 …
      prisma.customerPrice.findMany.mockResolvedValue([
        { productId: "prod-1", pricingTier: 5 }, // … but this product is on tier 5
      ]);

      await service.create({ items: [{ productId: "prod-1", qty: 1 }] }, customerPayload);

      expect(prisma.order.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            lineItems: {
              create: expect.arrayContaining([
                expect.objectContaining({ unitPrice: 7, originalPrice: 10, priceType: "SPECIAL" }),
              ]),
            },
          }),
        }),
      );
    });

    it("an msrp-only CustomerPrice row ({pricingTier: null}) still prices at the customer's default tier", async () => {
      // MSRP made CustomerPrice.pricingTier nullable: a row may carry ONLY an
      // MSRP override. That row must be pricing-inert — the customer's default
      // tier keeps winning, and the display-only msrp value never touches money.
      seedBuyerTierMocks(3); // default tier 3 → tier price 8
      prisma.customerPrice.findMany.mockResolvedValue([
        { productId: "prod-1", pricingTier: null, msrp: 5 },
      ]);

      await service.create({ items: [{ productId: "prod-1", qty: 1 }] }, customerPayload);

      expect(prisma.order.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            lineItems: {
              create: expect.arrayContaining([
                expect.objectContaining({ unitPrice: 8, originalPrice: 10, priceType: "SPECIAL" }),
              ]),
            },
          }),
        }),
      );
    });

    it("an unset tier column (DB default 0) falls back to the list price — never $0.00", async () => {
      seedBuyerTierMocks(4); // priceTier4 is 0 → inherit list

      await service.create({ items: [{ productId: "prod-1", qty: 1 }] }, customerPayload);

      expect(prisma.order.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            lineItems: {
              create: expect.arrayContaining([
                expect.objectContaining({ unitPrice: 10, subtotal: 10 }),
              ]),
            },
          }),
        }),
      );
    });

    it("RF-198 price-race compares against the TIER price, not list", async () => {
      // Buyer on tier 3 echoes the tier price → no conflict.
      seedBuyerTierMocks(3);
      await expect(
        service.create({ items: [{ productId: "prod-1", qty: 1, unitPrice: 8 }] }, customerPayload),
      ).resolves.toBeDefined();

      // Same buyer echoing the (different) list price → the cart is stale.
      seedBuyerTierMocks(3);
      await expect(
        service.create(
          { items: [{ productId: "prod-1", qty: 1, unitPrice: 10 }] },
          customerPayload,
        ),
      ).rejects.toThrow(/Prices have been updated/);
    });

    // ── B13: non-staff never set prices via the DISCOUNTED-branch override ──

    it("B13: a DRIVER-supplied below-list unitPrice is ignored — bills at list price as STANDARD", async () => {
      // Driver resolves the target customer via customer.findUnique (not
      // findFirst), and the same mock backs the later pricingTier lookup.
      prisma.customer.findUnique.mockResolvedValue({ id: "cust-1", pricingTier: 1 });
      prisma.customerPrice.findMany.mockResolvedValue([]);
      prisma.product.findMany.mockResolvedValue([MOCK_PRODUCT]); // pricePerUnit 4.99
      prisma.order.create.mockResolvedValue(MOCK_ORDER);
      (service as any).systemConfig.get.mockResolvedValue("0");
      const driverPayload = { ...operatorPayload, role: "DRIVER" as const };

      await service.create(
        { customerId: "cust-1", items: [{ productId: "prod-1", qty: 1, unitPrice: 1 }] },
        driverPayload,
      );

      // Pre-fix this hand-crafted below-list price would have been honored
      // verbatim (DISCOUNTED at $1) — the gate must fall it through to list.
      expect(prisma.order.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            lineItems: {
              create: expect.arrayContaining([
                expect.objectContaining({
                  unitPrice: 4.99,
                  priceType: "STANDARD",
                  originalPrice: null,
                }),
              ]),
            },
          }),
        }),
      );
    });

    it("B13: an OPERATOR below-list override still bills DISCOUNTED at the override price", async () => {
      prisma.customer.findUnique.mockResolvedValue({
        id: "cust-1",
        pricingTier: 1,
        user: { status: "ACTIVE" },
      });
      prisma.customerPrice.findMany.mockResolvedValue([]);
      prisma.product.findMany.mockResolvedValue([MOCK_PRODUCT]); // pricePerUnit 4.99
      prisma.order.create.mockResolvedValue(MOCK_ORDER);
      (service as any).systemConfig.get.mockResolvedValue("0");

      await service.create(
        { customerId: "cust-1", items: [{ productId: "prod-1", qty: 1, unitPrice: 3 }] },
        operatorPayload,
      );

      expect(prisma.order.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            lineItems: {
              create: expect.arrayContaining([
                expect.objectContaining({
                  unitPrice: 3,
                  priceType: "DISCOUNTED",
                  originalPrice: 4.99,
                }),
              ]),
            },
          }),
        }),
      );
    });

    it("B13: a CUSTOMER echoing their tier price stays on the tier ladder (SPECIAL), never a staff DISCOUNTED override", async () => {
      // Tier-3 price is 8, list is 10 (TIERED_PRODUCT). Sending unitPrice: 8
      // used to satisfy overridePrice < listPrice and get mislabeled DISCOUNTED
      // by the (now-gated) staff-only branch instead of the tier ladder.
      seedBuyerTierMocks(3);

      await service.create(
        { items: [{ productId: "prod-1", qty: 1, unitPrice: 8 }] },
        customerPayload,
      );

      expect(prisma.order.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            lineItems: {
              create: expect.arrayContaining([
                expect.objectContaining({ unitPrice: 8, originalPrice: 10, priceType: "SPECIAL" }),
              ]),
            },
          }),
        }),
      );
    });

    it("should throw BadRequestException when operator creates without valid customerId", async () => {
      prisma.customer.findUnique.mockResolvedValue(null);
      await expect(service.create({ items: [] } as any, operatorPayload)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should throw ForbiddenException when customer record not found", async () => {
      prisma.customer.findFirst.mockResolvedValue(null);

      await expect(service.create({ items: [] } as any, customerPayload)).rejects.toThrow(
        ForbiddenException,
      );
    });

    // ── B131 sibling: a removed (soft-deleted) customer is not an order target.
    // Removal writes Customer.deletedAt + User.status = "INACTIVE"; the
    // pre-existing guard only caught "SUSPENDED", so a stale detail page or a
    // queued mobile/API request could still create an order for a removed
    // customer — and that order could then be invoiced.
    it("REG-B131: staff create() refuses a removed customer with the not-found message", async () => {
      prisma.customer.findUnique.mockResolvedValue({
        id: "cust-1",
        pricingTier: 1,
        deletedAt: new Date("2026-09-01T00:00:00Z"),
        user: { status: "ACTIVE" },
      });
      // Everything past the customer gate is mocked to succeed, so pre-fix the
      // call RESOLVED and wrote an order row — the distinguisher.
      prisma.customerPrice.findMany.mockResolvedValue([]);
      prisma.product.findMany.mockResolvedValue([MOCK_PRODUCT]);
      prisma.order.create.mockResolvedValue(MOCK_ORDER);
      (service as any).systemConfig.get.mockResolvedValue("0");

      await expect(
        service.create(
          { customerId: "cust-1", items: [{ productId: "prod-1", qty: 1 }] } as any,
          operatorPayload,
        ),
      ).rejects.toThrow(new BadRequestException("Customer not found"));
      expect(prisma.order.create).not.toHaveBeenCalled();
    });

    it("REG-B131: driver create() refuses a removed customer with the not-found message", async () => {
      prisma.customer.findUnique.mockResolvedValue({
        id: "cust-1",
        pricingTier: 1,
        deletedAt: new Date("2026-09-01T00:00:00Z"),
      });
      prisma.customerPrice.findMany.mockResolvedValue([]);
      prisma.product.findMany.mockResolvedValue([MOCK_PRODUCT]);
      prisma.order.create.mockResolvedValue(MOCK_ORDER);
      (service as any).systemConfig.get.mockResolvedValue("0");
      const driverPayload = { ...operatorPayload, role: "DRIVER" as const };

      await expect(
        service.create(
          { customerId: "cust-1", items: [{ productId: "prod-1", qty: 1 }] } as any,
          driverPayload,
        ),
      ).rejects.toThrow(new BadRequestException("Customer not found"));
      expect(prisma.order.create).not.toHaveBeenCalled();
    });

    it("REG-B131 T14: a removed customer's own (still-valid) session cannot create an order", async () => {
      // Removal deactivates the User, but an access token minted moments before it stays valid for
      // up to 15 minutes — the buyer's own create() is the last path that could still write an
      // order for a removed customer. Honest stand-in for Postgres: applies the `where` the
      // service actually sends, so a where-only fix is observable (L-081).
      prisma.customer.findFirst.mockImplementation((({ where }: any) =>
        Promise.resolve(
          where?.deletedAt === null
            ? null
            : { id: "cust-1", pricingTier: 1, deletedAt: new Date("2026-09-01T00:00:00Z") },
        )) as any);
      // Everything past the customer gate succeeds, so pre-fix the call RESOLVED and wrote an
      // order row — the distinguisher.
      prisma.customerPrice.findMany.mockResolvedValue([]);
      prisma.product.findMany.mockResolvedValue([MOCK_PRODUCT]);
      prisma.order.create.mockResolvedValue(MOCK_ORDER);
      (service as any).systemConfig.get.mockResolvedValue("0");
      (service as any).promotionsService.activeForCatalog.mockResolvedValue([]);

      await expect(
        service.create({ items: [{ productId: "prod-1", qty: 1 }] } as any, customerPayload),
      ).rejects.toThrow(new ForbiddenException("Customer record not found"));
      expect(prisma.order.create).not.toHaveBeenCalled();
    });

    it("B131 P13: a live self-serve customer still creates", async () => {
      seedBuyerTierMocks(1);

      await service.create({ items: [{ productId: "prod-1", qty: 1 }] }, customerPayload);

      expect(prisma.order.create).toHaveBeenCalled();
    });

    // create() was only the first door. Every OTHER self-serve write path resolved the acting
    // customer with a bare `{ userId: user.sub }`, so inside the ~15-minute access-token window a
    // removed customer could still MUTATE an order even though they could no longer place one.
    // Honest stand-in for Postgres in each: the fixture applies the `where` the service actually
    // sends, so a where-only fix is observable (L-081).
    const REMOVED_CUSTOMER = {
      id: "cust-1",
      pricingTier: 1,
      deletedAt: new Date("2026-09-01T00:00:00Z"),
    };
    /** `findFirst` that honours `deletedAt: null`; `where.id` still serves the pricingTier read. */
    const seedRemovedBuyerLookup = () =>
      prisma.customer.findFirst.mockImplementation((({ where }: any) => {
        if (where?.userId !== undefined) {
          return Promise.resolve(where.deletedAt === null ? null : REMOVED_CUSTOMER);
        }
        return Promise.resolve({ pricingTier: 1 });
      }) as any);

    it("REG-B131 T18: a removed customer's session cannot edit order items", async () => {
      seedRemovedBuyerLookup();
      prisma.order.findUnique.mockResolvedValue({
        ...MOCK_ORDER,
        status: "PENDING",
        lineItems: [
          {
            id: "li-1",
            orderId: "ord-1",
            productId: "prod-1",
            qty: 2,
            unitPrice: 4.99,
            subtotal: 9.98,
            status: "PENDING",
            boxes: null,
            pieces: null,
          },
        ],
      });
      // Everything past the ownership gate succeeds, so pre-fix the call RESOLVED and replaced
      // the order's lines — the distinguisher.
      prisma.product.findMany.mockResolvedValue([
        { id: "prod-1", pricePerUnit: 4.99, unitsPerBox: null },
      ]);
      prisma.orderItem.findMany.mockResolvedValue([]);

      await expect(
        service.updateOrderItems(
          "ord-1",
          { items: [{ productId: "prod-1", qty: 5 }] },
          customerPayload,
        ),
      ).rejects.toThrow(ForbiddenException);

      expect(prisma.orderItem.deleteMany).not.toHaveBeenCalled();
      expect(prisma.orderItem.create).not.toHaveBeenCalled();
      expect(prisma.orderItem.update).not.toHaveBeenCalled();
      expect(prisma.order.update).not.toHaveBeenCalled();
    });

    it("REG-B131 T19: a removed customer's session cannot change order status", async () => {
      seedRemovedBuyerLookup();
      // PENDING → CANCELLED is exactly what a LIVE owner is allowed to do here, so pre-fix this
      // resolved and wrote the status — the distinguisher.
      prisma.order.findUnique.mockResolvedValue(MOCK_ORDER);
      prisma.order.findFirst.mockResolvedValue(MOCK_ORDER); // cancelImpact's own read
      prisma.order.update.mockResolvedValue({ ...MOCK_ORDER, status: "CANCELLED" });
      prisma.invoice.findMany.mockResolvedValue([]);

      await expect(
        service.changeStatus("ord-1", { status: "CANCELLED" as any }, customerPayload),
      ).rejects.toThrow(ForbiddenException);

      expect(prisma.order.update).not.toHaveBeenCalled();
    });

    it("B131 P17: a live self-serve customer still edits items", async () => {
      prisma.customer.findFirst.mockImplementation((({ where }: any) =>
        Promise.resolve(
          where?.userId !== undefined ? { id: "cust-1" } : { pricingTier: 1 },
        )) as any);
      prisma.order.findUnique.mockResolvedValue({
        ...MOCK_ORDER,
        status: "PENDING",
        lineItems: [
          {
            id: "li-1",
            orderId: "ord-1",
            productId: "prod-1",
            qty: 2,
            unitPrice: 4.99,
            subtotal: 9.98,
            status: "PENDING",
            boxes: null,
            pieces: null,
          },
        ],
      });
      prisma.product.findMany.mockResolvedValue([
        { id: "prod-1", pricePerUnit: 4.99, unitsPerBox: null },
      ]);
      prisma.orderItem.findMany.mockResolvedValue([]);

      await service.updateOrderItems(
        "ord-1",
        { items: [{ productId: "prod-1", qty: 5 }] },
        customerPayload,
      );

      expect(prisma.orderItem.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ productId: "prod-1", qty: 5 }) }),
      );
    });

    it("should throw BadRequestException when product not found", async () => {
      prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
      prisma.product.findMany.mockResolvedValue([]); // no matching products

      await expect(
        service.create({ items: [{ productId: "nonexistent", qty: 1 }] }, customerPayload),
      ).rejects.toThrow(BadRequestException);
    });

    // ── B142: create()'s archived-line guard, and its ONE exemption ───────────
    // Fable train-2 fix round, item 4: the guard stays on staff/buyer create();
    // only the driver change-request draft path (ChangeRequestsService.approve)
    // is exempt, via an explicit `options.allowArchived` it alone passes.

    it("REG-B142-E staff create rejects a new archived line", async () => {
      prisma.customer.findUnique.mockResolvedValue({ pricingTier: 1, user: { status: "ACTIVE" } });
      prisma.product.findMany.mockResolvedValue([{ ...MOCK_PRODUCT, isActive: false }]);

      await expect(
        service.create(
          { customerId: "cust-1", items: [{ productId: "prod-1", qty: 1 }] } as any,
          operatorPayload,
        ),
      ).rejects.toThrow(/archived/i);

      expect(prisma.order.create).not.toHaveBeenCalled();
    });

    it("REG-B142-F buyer create rejects a new archived line", async () => {
      prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
      prisma.product.findMany.mockResolvedValue([{ ...MOCK_PRODUCT, isActive: false }]);

      await expect(
        service.create({ items: [{ productId: "prod-1", qty: 1 }] }, customerPayload),
      ).rejects.toThrow(/archived/i);

      expect(prisma.order.create).not.toHaveBeenCalled();
    });

    it("REG-B142-G change-request draft create allows an archived line via options.allowArchived", async () => {
      // Mirrors ChangeRequestsService.approve's `this.ordersService.create(...,
      // { skipAutoMerge: false, allowArchived: true })` call — the pseudo-buyer
      // draft rolls an existing (possibly since-archived) line to the
      // customer's next delivery, and must NOT hit the archived-line guard.
      prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
      prisma.product.findMany.mockResolvedValue([{ ...MOCK_PRODUCT, isActive: false }]);
      prisma.order.create.mockResolvedValue(MOCK_ORDER);

      await service.create(
        { items: [{ productId: "prod-1", qty: 1 }], status: "DRAFT" } as any,
        customerPayload,
        { allowArchived: true },
      );

      expect(prisma.order.create).toHaveBeenCalled();
    });

    it("should generate an order number starting with ORD-", async () => {
      prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
      prisma.product.findMany.mockResolvedValue([MOCK_PRODUCT]);
      prisma.order.create.mockResolvedValue(MOCK_ORDER);

      await service.create({ items: [{ productId: "prod-1", qty: 1 }] }, customerPayload);

      expect(prisma.order.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            orderNumber: expect.stringMatching(/^ORD-/),
          }),
        }),
      );
    });

    it("creates an unlisted (catalog-free) line as a MANUAL-priced item with no stock movement", async () => {
      // Operator resolves the customer (with user.status) then the pricing tier —
      // both via customer.findUnique, so one object satisfies both reads.
      prisma.customer.findUnique.mockResolvedValue({
        id: "cust-1",
        user: { status: "ACTIVE" },
        pricingTier: 1,
      });
      prisma.product.findMany.mockResolvedValue([]); // no catalog ids for an unlisted line
      prisma.order.create.mockResolvedValue(MOCK_ORDER);
      (service as any).systemConfig.get.mockImplementation((key: string) =>
        key === "settings.taxRate" ? "0" : null,
      );

      await service.create(
        {
          customerId: "cust-1",
          items: [{ name: "Rush delivery fee", qty: 2, unitPrice: 10 }] as any,
        },
        operatorPayload,
      );

      expect(prisma.order.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            lineItems: {
              create: expect.arrayContaining([
                expect.objectContaining({
                  productId: null,
                  name: "Rush delivery fee",
                  unitPrice: 10,
                  subtotal: 20,
                  priceType: "MANUAL",
                }),
              ]),
            },
          }),
        }),
      );
      // No catalog product behind the line → stock is never touched.
      expect(prisma.product.update).not.toHaveBeenCalled();
    });

    it("rejects an unlisted line from a buyer (CUSTOMER role)", async () => {
      prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
      prisma.product.findMany.mockResolvedValue([]);

      await expect(
        service.create(
          { items: [{ name: "Sneaky fee", qty: 1, unitPrice: 5 }] as any },
          customerPayload,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    // ── RF-4: per-category regulated tax folded into the order total ──────────
    describe("RF-4 — per-category regulated tax", () => {
      const REG_PRODUCT = {
        id: "prod-1",
        name: "Cabernet",
        pricePerUnit: 10,
        unit: "bottle",
        unitsPerBox: 0,
        trackedCategoryId: "cat-alc",
        trackedSubcategoryId: null,
      };
      const setup = (category: any, taxRate = "0") => {
        prisma.customer.findUnique.mockResolvedValue({
          id: "cust-1",
          pricingTier: 1,
          user: { status: "ACTIVE" },
        });
        prisma.customerPrice.findMany.mockResolvedValue([]);
        prisma.product.findMany.mockResolvedValue([REG_PRODUCT]);
        prisma.trackedCategory.findMany.mockResolvedValue([category]);
        prisma.order.create.mockResolvedValue(MOCK_ORDER);
        (service as any).systemConfig.get.mockImplementation((k: string) =>
          k === "settings.taxRate" ? taxRate : null,
        );
      };

      it("PERCENT_OF_SALE 5% → per-line categoryTaxAmount + folded order total", async () => {
        setup({
          id: "cat-alc",
          name: "Alcohol",
          taxType: "PERCENT_OF_SALE",
          rate: 0.05,
          unitBasis: null,
          priceIncludesTax: false,
        });

        // qty 2 × $10 = $20 subtotal; category tax 5% × 20 = $1.00; tax 0; total $21.
        await service.create(
          { customerId: "cust-1", items: [{ productId: "prod-1", qty: 2 }] } as any,
          operatorPayload,
        );

        expect(prisma.order.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              subtotal: 20,
              tax: 0,
              total: 21,
              hasRegulated: true,
              lineItems: {
                create: expect.arrayContaining([
                  expect.objectContaining({
                    productId: "prod-1",
                    subtotal: 20,
                    categoryTaxAmount: 1,
                    trackedCategoryId: "cat-alc",
                  }),
                ]),
              },
            }),
          }),
        );
      });

      it("PERCENT_OF_SALE 5% composes with a 10% regular sales tax", async () => {
        setup(
          {
            id: "cat-alc",
            name: "Alcohol",
            taxType: "PERCENT_OF_SALE",
            rate: 0.05,
            unitBasis: null,
            priceIncludesTax: false,
          },
          "10",
        );

        // subtotal 20; regular tax 10% = 2; category tax 5% = 1; total 20+2+1 = 23.
        await service.create(
          { customerId: "cust-1", items: [{ productId: "prod-1", qty: 2 }] } as any,
          operatorPayload,
        );

        expect(prisma.order.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ subtotal: 20, tax: 2, total: 23 }),
          }),
        );
      });

      it("EXCISE_PER_UNIT $0.10/piece × N pieces (per-unit basis, not the subtotal)", async () => {
        setup({
          id: "cat-alc",
          name: "Cigarettes",
          taxType: "EXCISE_PER_UNIT",
          rate: 0.1,
          unitBasis: "pack",
          priceIncludesTax: false,
        });

        // qty 5 pieces × $10 = $50 subtotal; excise $0.10 × 5 = $0.50; total $50.50.
        await service.create(
          { customerId: "cust-1", items: [{ productId: "prod-1", qty: 5 }] } as any,
          operatorPayload,
        );

        expect(prisma.order.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              subtotal: 50,
              tax: 0,
              total: 50.5,
              lineItems: {
                create: expect.arrayContaining([
                  expect.objectContaining({ categoryTaxAmount: 0.5 }),
                ]),
              },
            }),
          }),
        );
      });

      it("non-regulated line stays categoryTaxAmount 0 (total unchanged)", async () => {
        prisma.customer.findUnique.mockResolvedValue({
          id: "cust-1",
          pricingTier: 1,
          user: { status: "ACTIVE" },
        });
        prisma.customerPrice.findMany.mockResolvedValue([]);
        prisma.product.findMany.mockResolvedValue([
          { id: "prod-1", name: "Widget", pricePerUnit: 10, unit: "ea", trackedCategoryId: null },
        ]);
        prisma.order.create.mockResolvedValue(MOCK_ORDER);
        (service as any).systemConfig.get.mockImplementation((k: string) =>
          k === "settings.taxRate" ? "0" : null,
        );

        await service.create(
          { customerId: "cust-1", items: [{ productId: "prod-1", qty: 2 }] } as any,
          operatorPayload,
        );

        expect(prisma.order.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              subtotal: 20,
              total: 20,
              lineItems: {
                create: expect.arrayContaining([expect.objectContaining({ categoryTaxAmount: 0 })]),
              },
            }),
          }),
        );
      });
    });

    describe("optional shipping fee", () => {
      it("creates an order without shippingFee → shippingFee 0, totals match the pre-feature formula (regression lock)", async () => {
        prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
        prisma.product.findMany.mockResolvedValue([MOCK_PRODUCT]);
        prisma.order.create.mockResolvedValue(MOCK_ORDER);
        (service as any).systemConfig.get.mockImplementation((key: string) =>
          key === "settings.taxRate" ? "10" : null,
        );

        await service.create(
          { items: [{ productId: "prod-1", qty: 3 }], urgent: false },
          customerPayload,
        );

        expect(prisma.order.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              subtotal: 14.97,
              tax: 1.5,
              total: 16.47,
              shippingFee: 0,
            }),
          }),
        );
      });

      it("creates an order with shippingFee: 5 → added to the total AFTER tax, never taxed itself", async () => {
        prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
        prisma.product.findMany.mockResolvedValue([MOCK_PRODUCT]);
        prisma.order.create.mockResolvedValue(MOCK_ORDER);
        (service as any).systemConfig.get.mockImplementation((key: string) =>
          key === "settings.taxRate" ? "10" : null,
        );

        await service.create(
          { items: [{ productId: "prod-1", qty: 3 }], urgent: false, shippingFee: 5 },
          customerPayload,
        );

        // 14.97 subtotal + 1.5 tax + 5 fee = 21.47 — fee is untaxed (not folded into subtotal).
        expect(prisma.order.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              subtotal: 14.97,
              tax: 1.5,
              total: 21.47,
              shippingFee: 5,
            }),
          }),
        );
      });

      it("combines an order-level discount with a shipping fee correctly", async () => {
        prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
        prisma.product.findMany.mockResolvedValue([MOCK_PRODUCT]);
        prisma.order.create.mockResolvedValue(MOCK_ORDER);
        (service as any).systemConfig.get.mockImplementation((key: string) =>
          key === "settings.taxRate" ? "10" : null,
        );

        await service.create(
          {
            items: [{ productId: "prod-1", qty: 3 }],
            urgent: false,
            discountAmount: 2,
            shippingFee: 5,
          },
          customerPayload,
        );

        // 14.97 + 1.5 - 2 (discount) + 5 (fee) = 19.47.
        expect(prisma.order.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              subtotal: 14.97,
              tax: 1.5,
              total: 19.47,
              discountAmount: 2,
              shippingFee: 5,
            }),
          }),
        );
      });
    });

    // ─── WP3: order-scoped credit-note application ──────────────────────────

    describe("appliedCreditNotes (WP3 — order-scoped credit-note application)", () => {
      // B318 flipped these three from customerPayload to operatorPayload: they exercise the
      // validate/sync/settle MECHANISM, which the fix below now gates to staff callers only —
      // see the REG-B318 tests further down for the non-staff denial these three used to miss.
      it("validates selections up-front — a rejected selection throws before the order is created", async () => {
        prisma.customer.findUnique.mockResolvedValue({
          id: "cust-1",
          deletedAt: null,
          user: { status: "ACTIVE" },
        });
        prisma.product.findMany.mockResolvedValue([MOCK_PRODUCT]);
        (service as any).systemConfig.get.mockResolvedValue("0");
        creditNotesService.validateSelectionsForCustomer.mockRejectedValueOnce(
          new BadRequestException("Credit note belongs to a different customer"),
        );

        await expect(
          service.create(
            {
              customerId: "cust-1",
              items: [{ productId: "prod-1", qty: 1 }],
              appliedCreditNotes: [{ creditNoteId: "cn-1" }],
            } as any,
            operatorPayload,
          ),
        ).rejects.toThrow(BadRequestException);

        expect(creditNotesService.validateSelectionsForCustomer).toHaveBeenCalledWith(
          expect.anything(),
          "cust-1",
          [{ creditNoteId: "cn-1" }],
        );
        // Rejected up-front, before any stock mutation / order write.
        expect(prisma.order.create).not.toHaveBeenCalled();
        expect(creditNotesService.syncOrderCreditSelections).not.toHaveBeenCalled();
      });

      it("stores + settles the caller's credit-note selection against the created order id", async () => {
        prisma.customer.findUnique.mockResolvedValue({
          id: "cust-1",
          deletedAt: null,
          user: { status: "ACTIVE" },
        });
        prisma.product.findMany.mockResolvedValue([MOCK_PRODUCT]);
        prisma.order.create.mockResolvedValue(MOCK_ORDER); // id: "ord-1", customerId: "cust-1"
        (service as any).systemConfig.get.mockResolvedValue("0");

        const selections = [{ creditNoteId: "cn-1", amount: 20 }];
        await service.create(
          {
            customerId: "cust-1",
            items: [{ productId: "prod-1", qty: 1 }],
            appliedCreditNotes: selections,
          } as any,
          operatorPayload,
        );

        expect(creditNotesService.syncOrderCreditSelections).toHaveBeenCalledWith(
          expect.anything(),
          MOCK_ORDER.id,
          "cust-1",
          selections,
        );
        expect(creditNotesService.settleOrderCreditsInTx).toHaveBeenCalledWith(
          expect.anything(),
          MOCK_ORDER.id,
        );
      });

      it("omitting appliedCreditNotes leaves credit selections untouched (no sync/settle call)", async () => {
        prisma.customer.findUnique.mockResolvedValue({
          id: "cust-1",
          deletedAt: null,
          user: { status: "ACTIVE" },
        });
        prisma.product.findMany.mockResolvedValue([MOCK_PRODUCT]);
        prisma.order.create.mockResolvedValue(MOCK_ORDER);
        (service as any).systemConfig.get.mockResolvedValue("0");

        await service.create(
          { customerId: "cust-1", items: [{ productId: "prod-1", qty: 1 }] } as any,
          operatorPayload,
        );

        expect(creditNotesService.syncOrderCreditSelections).not.toHaveBeenCalled();
        expect(creditNotesService.settleOrderCreditsInTx).not.toHaveBeenCalled();
      });

      // B318: the edit path (updateOrderItems' isStaffCreditEdit) already strips
      // appliedCreditNotes for non-staff callers. Create had no matching gate — a buyer or
      // driver token could consume a customer's credit notes on create without any staff
      // involvement, the exact asymmetry the edit path was built to prevent.
      it.each([
        ["CUSTOMER", customerPayload],
        ["DRIVER", { ...operatorPayload, role: "DRIVER" as const }],
      ])(
        "REG-B318 appliedCreditNotes on order create is ignored unless the caller is OPERATOR or TENANT_ADMIN (%s)",
        async (_role, user) => {
          // Satisfies both branches: CUSTOMER resolves its own record via findFirst
          // (customerId in the dto is ignored there), DRIVER requires dto.customerId
          // and resolves it via findUnique.
          prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
          prisma.customer.findUnique.mockResolvedValue({ id: "cust-1", deletedAt: null });
          prisma.product.findMany.mockResolvedValue([MOCK_PRODUCT]);
          prisma.order.create.mockResolvedValue(MOCK_ORDER);
          (service as any).systemConfig.get.mockResolvedValue("0");

          await service.create(
            {
              customerId: "cust-1",
              items: [{ productId: "prod-1", qty: 1 }],
              appliedCreditNotes: [{ creditNoteId: "cn-1" }],
            } as any,
            user as any,
          );

          // Silently ignored, not rejected — the order still gets created, just without
          // ever touching the customer's credit notes.
          expect(prisma.order.create).toHaveBeenCalled();
          expect(creditNotesService.validateSelectionsForCustomer).not.toHaveBeenCalled();
          expect(creditNotesService.syncOrderCreditSelections).not.toHaveBeenCalled();
          expect(creditNotesService.settleOrderCreditsInTx).not.toHaveBeenCalled();
        },
      );
    });

    // ── Ad-hoc trips + fulfillment mode: fulfillPath default chain ──────────
    describe("fulfillPath default chain", () => {
      // customer.findFirst serves BOTH the buyer's own-record lookup (where.userId)
      // and the pricing-tier/fulfillPath lookup (where.id) since the tenant-scope
      // sweep converted the latter from findUnique.
      let tierRecord: any;
      beforeEach(() => {
        tierRecord = null;
        prisma.customer.findFirst.mockImplementation(({ where }: any) =>
          Promise.resolve(where?.userId ? { id: "cust-1" } : tierRecord),
        );
        prisma.product.findMany.mockResolvedValue([MOCK_PRODUCT]);
        prisma.order.create.mockResolvedValue(MOCK_ORDER);
        (service as any).systemConfig.get.mockResolvedValue("0");
      });

      it("an explicit dto.fulfillPath wins over the customer's own default", async () => {
        tierRecord = { pricingTier: 1, fulfillPath: "SHIP" };

        await service.create(
          { items: [{ productId: "prod-1", qty: 1 }], fulfillPath: "ROUTE" } as any,
          customerPayload,
        );

        expect(prisma.order.create).toHaveBeenCalledWith(
          expect.objectContaining({ data: expect.objectContaining({ fulfillPath: "ROUTE" }) }),
        );
      });

      it("falls back to the customer's own default when dto.fulfillPath is omitted", async () => {
        tierRecord = { pricingTier: 1, fulfillPath: "SHIP" };

        await service.create({ items: [{ productId: "prod-1", qty: 1 }] } as any, customerPayload);

        expect(prisma.order.create).toHaveBeenCalledWith(
          expect.objectContaining({ data: expect.objectContaining({ fulfillPath: "SHIP" }) }),
        );
      });

      it("defaults to ROUTE when neither the dto nor the customer specify a path", async () => {
        tierRecord = { pricingTier: 1, fulfillPath: null };

        await service.create({ items: [{ productId: "prod-1", qty: 1 }] } as any, customerPayload);

        expect(prisma.order.create).toHaveBeenCalledWith(
          expect.objectContaining({ data: expect.objectContaining({ fulfillPath: "ROUTE" }) }),
        );
      });
    });

    // ── WP1: boxed-payload qty-zeroing fix ───────────────────────────────────
    // The web New-sale screen sends boxes:0/pieces:0 for plain-qty lines. The old
    // `item.boxes != null || item.pieces != null` check treated an explicit zero
    // the same as a real split and overwrote a valid qty with 0 (live bug: lines
    // stored qty 0.000 at full unitPrice, order total $0, invoice ungeneratable).
    describe("WP1 — boxes:0/pieces:0 payload no longer zeroes qty", () => {
      const BOXED_PRODUCT = {
        id: "prod-box",
        name: "Cola Case",
        pricePerUnit: 30,
        unitsPerBox: 24,
      };

      beforeEach(() => {
        prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
        prisma.order.create.mockResolvedValue(MOCK_ORDER);
        (service as any).systemConfig.get.mockResolvedValue("0");
      });

      it("(a) non-boxed product: boxes:0/pieces:0 stores the real qty, not 0", async () => {
        prisma.product.findMany.mockResolvedValue([MOCK_PRODUCT]); // pricePerUnit 4.99

        await service.create(
          { items: [{ productId: "prod-1", qty: 1, boxes: 0, pieces: 0 }] } as any,
          customerPayload,
        );

        expect(prisma.order.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              lineItems: {
                create: expect.arrayContaining([
                  expect.objectContaining({ qty: 1, boxes: null, pieces: null, subtotal: 4.99 }),
                ]),
              },
            }),
          }),
        );
      });

      it("(b) boxed product: boxes:0/pieces:0 stores a box-unaware qty-1 line (boxes/pieces null), priced at the box price — not a zeroed split", async () => {
        prisma.product.findMany.mockResolvedValue([BOXED_PRODUCT]);

        await service.create(
          { items: [{ productId: "prod-box", qty: 1, boxes: 0, pieces: 0 }] } as any,
          customerPayload,
        );

        expect(prisma.order.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              lineItems: {
                create: expect.arrayContaining([
                  expect.objectContaining({ qty: 1, boxes: null, pieces: null, subtotal: 30 }),
                ]),
              },
            }),
          }),
        );
      });

      it("(c) regression guard: a real box/piece split still normalizes byte-identically", async () => {
        prisma.product.findMany.mockResolvedValue([BOXED_PRODUCT]);

        await service.create(
          { items: [{ productId: "prod-box", qty: 1, boxes: 2, pieces: 0 }] } as any,
          customerPayload,
        );

        expect(prisma.order.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              lineItems: {
                create: expect.arrayContaining([
                  expect.objectContaining({ qty: 48, boxes: 2, pieces: 0, subtotal: 60 }),
                ]),
              },
            }),
          }),
        );
      });

      it("(d) an all-zero {qty:1, boxes:0, pieces:0} payload never throws", async () => {
        prisma.product.findMany.mockResolvedValue([MOCK_PRODUCT]);

        await expect(
          service.create(
            { items: [{ productId: "prod-1", qty: 1, boxes: 0, pieces: 0 }] } as any,
            customerPayload,
          ),
        ).resolves.toBeDefined();
      });

      it("(e) a crafted payload that derives qty 0 throws BadRequest — order NOT created", async () => {
        // Defence in depth behind the DTO's @Min(1): an all-zero line has no box
        // entry to fall back on, so the invariant is the only thing standing
        // between it and a $0 line at full unitPrice (the live money bug's shape).
        prisma.product.findMany.mockResolvedValue([BOXED_PRODUCT]);

        await expect(
          service.create(
            { items: [{ productId: "prod-box", qty: 0, boxes: 0, pieces: 0 }] } as any,
            customerPayload,
          ),
        ).rejects.toThrow(BadRequestException);
        expect(prisma.order.create).not.toHaveBeenCalled();
      });

      it("(f) unitsPerBox 1: a boxes-carrying payload keeps the operator's qty (not zeroed, not rejected)", async () => {
        // The web sends `boxes` whenever unitsPerBox is truthy — including 1, which
        // is NOT case packaging. normalizeBoxesPieces' non-boxed branch reads `qty`,
        // so the line must fall back to it rather than deriving 0 and tripping (e).
        prisma.product.findMany.mockResolvedValue([
          { id: "prod-single", name: "Single", pricePerUnit: 9, unitsPerBox: 1 },
        ]);

        await service.create(
          { items: [{ productId: "prod-single", qty: 2, boxes: 2, pieces: 0 }] } as any,
          customerPayload,
        );

        expect(prisma.order.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              lineItems: {
                create: expect.arrayContaining([
                  expect.objectContaining({ qty: 2, boxes: null, pieces: null, subtotal: 18 }),
                ]),
              },
            }),
          }),
        );
      });
    });

    // WP1 (client-release-blockers): pins the boxed-line qty BASIS the stock
    // decrement uses on create() — box-split lines decrement in PIECES, a
    // bare-qty line on the same boxed product decrements in SELLING UNITS.
    // This is a regression guard, not a semantic change: the finding that
    // motivated WP1's settleStockForEdit refactor flagged this mixed-basis
    // contract, and settle must reproduce it exactly (held/requested are
    // compared in each line's own stored denomination) — so this spec
    // documents what create() already does today.
    describe("WP1 — boxed-line qty basis on CREATE (regression, no behavior change)", () => {
      const BOXED_12 = {
        id: "prod-box12",
        name: "Water Case",
        pricePerUnit: 24,
        unitsPerBox: 12,
        currentStock: 500,
      };

      beforeEach(() => {
        prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
        prisma.order.create.mockResolvedValue(MOCK_ORDER);
        (service as any).systemConfig.get.mockResolvedValue("0");
      });

      /**
       * B116 (REG-B116 / R15) replaced create()'s per-line `tx.product.update`
       * with ONE aggregated raw `UPDATE … FROM (VALUES …)`, so the qty BASIS
       * this describe() pins is now read off that statement's bindings. Same
       * oracle (27 pieces / 2 selling units), new call site — the returned
       * reader hands back the `[productId, qty]` pairs in VALUES-list order.
       */
      function captureStockDecrement() {
        const txExecuteRaw: jest.Mock = jest.fn().mockResolvedValue(0);
        prisma.tenantTransaction.mockImplementation((fn: any) =>
          fn({
            ...(prisma as unknown as Record<string, any>),
            $executeRaw: txExecuteRaw,
            $queryRaw: jest.fn().mockResolvedValue([]),
          }),
        );
        const isSql = (v: any) => typeof v?.sql === "string" && Array.isArray(v?.values);
        const sqlText = (v: any): string =>
          v == null
            ? ""
            : typeof v === "string"
              ? v
              : isSql(v)
                ? v.sql
                : Array.isArray(v)
                  ? v.map(sqlText).join(" ")
                  : "";
        const flatValues = (v: any): any[] =>
          v == null
            ? []
            : isSql(v)
              ? flatValues(v.values)
              : Array.isArray(v)
                ? v.flatMap(flatValues)
                : [v];
        return () => {
          // The lock statement is a separate `SELECT … FOR UPDATE`; only the
          // decrement names currentStock.
          const call = txExecuteRaw.mock.calls.find((c: any[]) =>
            (sqlText(c[0]) + " " + sqlText(c.slice(1))).includes("currentStock"),
          );
          if (!call) return [];
          // Tagged-template form binds after the strings; function form
          // (`$executeRaw(Prisma.sql…)`) carries both inside call[0].
          return isSql(call[0]) ? flatValues(call[0]) : flatValues(call.slice(1));
        };
      }

      it("a box/piece split ({boxes:2, pieces:3}) decrements 27 — the PIECES basis", async () => {
        prisma.product.findMany.mockResolvedValue([BOXED_12]);
        const readDecrement = captureStockDecrement();

        await service.create(
          { items: [{ productId: "prod-box12", qty: 1, boxes: 2, pieces: 3 }] } as any,
          customerPayload,
        );

        expect(prisma.product.update).not.toHaveBeenCalled();
        // The money basis is the leading (productId, qty) pair. The trailing
        // bound value is the tenantId the raw UPDATE re-states for itself —
        // raw SQL bypasses the tenant proxy that scoped the ORM call it
        // replaced — so it is asserted separately rather than folded into the
        // basis oracle.
        expect(readDecrement().slice(0, 2)).toEqual(["prod-box12", 27]);
        expect(readDecrement()).toContain("test-tenant");
      });

      it("the same boxed product ordered legacy-style with bare qty:2 (no boxes/pieces keys) decrements 2 — the SELLING-UNITS basis", async () => {
        prisma.product.findMany.mockResolvedValue([BOXED_12]);
        const readDecrement = captureStockDecrement();

        await service.create(
          { items: [{ productId: "prod-box12", qty: 2 }] } as any,
          customerPayload,
        );

        expect(prisma.product.update).not.toHaveBeenCalled();
        expect(readDecrement().slice(0, 2)).toEqual(["prod-box12", 2]);
        expect(readDecrement()).toContain("test-tenant");
      });
    });
  });

  // ─── REG-B309: driver order-create route linkage ──────────────────────────
  // Today `create()`'s routeRunId/routeRunStopId branch (orders.service.ts
  // ~2569-2582) runs for ANY role with zero validation — no check that the run
  // belongs to the calling driver, that it is in progress, or that the stop is
  // still open. These tests pin the ownership/status guard the fix must add,
  // mirroring the pattern already used by `completeWithPayment`/`reopenStop` in
  // routes.service.ts.

  describe("REG-B309 driver order-create route linkage", () => {
    const driverPayload = { ...operatorPayload, sub: "user-drv-1", role: "DRIVER" as const };

    /** Baseline mocks so create() clears the customer/product/order-write path. */
    const seedDriverCreateMocks = () => {
      prisma.customer.findUnique.mockResolvedValue({ id: "cust-1", pricingTier: 1 });
      prisma.customerPrice.findMany.mockResolvedValue([]);
      prisma.product.findMany.mockResolvedValue([MOCK_PRODUCT]);
      prisma.order.create.mockResolvedValue(MOCK_ORDER);
      (service as any).systemConfig.get.mockResolvedValue("0");
    };

    it("REG-B309 a DRIVER creating an order may only link it to a stop on their own active run", async () => {
      seedDriverCreateMocks();
      prisma.driver.findFirst.mockResolvedValue({ id: "drv-1" });
      prisma.routeRun.findFirst.mockResolvedValue({
        id: "run-9",
        driverId: "drv-OTHER",
        status: RouteRunStatus.IN_PROGRESS,
      });

      await expect(
        service.create(
          {
            customerId: "cust-1",
            items: [{ productId: "prod-1", qty: 1 }],
            routeRunId: "run-9",
          } as any,
          driverPayload,
        ),
      ).rejects.toThrow(ForbiddenException);

      expect(prisma.order.create).not.toHaveBeenCalled();
    });

    it("REG-B309 links the order when the run is the driver's own, in progress, and the stop is open", async () => {
      seedDriverCreateMocks();
      prisma.driver.findFirst.mockResolvedValue({ id: "drv-1" });
      prisma.routeRun.findFirst.mockResolvedValue({
        id: "run-1",
        driverId: "drv-1",
        status: RouteRunStatus.IN_PROGRESS,
      });
      prisma.routeRunStop.findFirst.mockResolvedValue({
        id: "stop-1",
        status: RouteRunStopStatus.PENDING,
        routeRunId: "run-1",
      });

      await service.create(
        {
          customerId: "cust-1",
          items: [{ productId: "prod-1", qty: 1 }],
          routeRunId: "run-1",
          routeRunStopId: "stop-1",
        } as any,
        driverPayload,
      );

      expect(prisma.order.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ routeRunId: "run-1", routeRunStopId: "stop-1" }),
        }),
      );
      // L-113 shape proof: the exact where/select of both ownership lookups.
      expect(prisma.routeRun.findFirst).toHaveBeenCalledWith({
        where: { id: "run-1" },
        select: { id: true, driverId: true, status: true },
      });
      expect(prisma.routeRunStop.findFirst).toHaveBeenCalledWith({
        where: { id: "stop-1" },
        select: { id: true, status: true, routeRunId: true },
      });
    });

    it("REG-B309 a completed or skipped stop cannot receive a new order", async () => {
      seedDriverCreateMocks();
      prisma.driver.findFirst.mockResolvedValue({ id: "drv-1" });
      prisma.routeRun.findFirst.mockResolvedValue({
        id: "run-1",
        driverId: "drv-1",
        status: RouteRunStatus.IN_PROGRESS,
      });
      prisma.routeRunStop.findFirst.mockResolvedValue({
        id: "stop-1",
        status: RouteRunStopStatus.COMPLETED,
        routeRunId: "run-1",
      });

      await expect(
        service.create(
          {
            customerId: "cust-1",
            items: [{ productId: "prod-1", qty: 1 }],
            routeRunId: "run-1",
            routeRunStopId: "stop-1",
          } as any,
          driverPayload,
        ),
      ).rejects.toThrow(BadRequestException);

      expect(prisma.order.create).not.toHaveBeenCalled();
    });

    it("REG-B309 a stop that belongs to a different run than the one supplied is rejected", async () => {
      seedDriverCreateMocks();
      prisma.driver.findFirst.mockResolvedValue({ id: "drv-1" });
      prisma.routeRun.findFirst.mockResolvedValue({
        id: "run-1",
        driverId: "drv-1",
        status: RouteRunStatus.IN_PROGRESS,
      });
      prisma.routeRunStop.findFirst.mockResolvedValue({
        id: "stop-1",
        status: RouteRunStopStatus.PENDING,
        routeRunId: "run-1",
      });

      await expect(
        service.create(
          {
            customerId: "cust-1",
            items: [{ productId: "prod-1", qty: 1 }],
            routeRunId: "run-2",
            routeRunStopId: "stop-1",
          } as any,
          driverPayload,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    // B309 (Opus MAJOR): the link block above is role-agnostic and the
    // controller admits CUSTOMER, so a buyer could POST routeRunId/
    // routeRunStopId directly and attach their own order to a driver's
    // manifest — the DRIVER-only ownership checks above never run for them.
    it("REG-B309 a CUSTOMER cannot link an order to a route run or stop", async () => {
      prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
      prisma.product.findMany.mockResolvedValue([MOCK_PRODUCT]);
      prisma.order.create.mockResolvedValue(MOCK_ORDER);
      (service as any).systemConfig.get.mockResolvedValue("0");

      await expect(
        service.create(
          {
            items: [{ productId: "prod-1", qty: 1 }],
            routeRunId: "run-1",
          } as any,
          customerPayload,
        ),
      ).rejects.toThrow(BadRequestException);

      expect(prisma.order.create).not.toHaveBeenCalled();
    });
  });

  // ─── createSale (order + invoice in one step) ─────────────────────────────

  describe("W6 license guard blocks unlicensed regulated sales", () => {
    const blocked = new ConflictException({
      code: "REGULATED_AUTH_REQUIRED",
      blockedCategories: [],
    });

    it("create is blocked BEFORE the order is persisted", async () => {
      prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
      prisma.product.findMany.mockResolvedValue([MOCK_PRODUCT]);
      (service as any).systemConfig.get.mockImplementation((k: string) =>
        k === "settings.taxRate" ? "10" : null,
      );
      (service as any).authGuard.assertAuthorizedOrThrow.mockRejectedValueOnce(blocked);

      await expect(
        service.create({ items: [{ productId: "prod-1", qty: 1 }] }, customerPayload),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.order.create).not.toHaveBeenCalled(); // blocked before the stock tx
    });

    it("updateOrderItems is blocked on a non-draft order before mutating items", async () => {
      prisma.order.findUnique.mockResolvedValue({
        ...MOCK_ORDER,
        status: "PENDING",
        lineItems: [],
      });
      (service as any).authGuard.assertAuthorizedOrThrow.mockRejectedValueOnce(blocked);

      await expect(
        service.updateOrderItems(
          "ord-1",
          { items: [{ productId: "prod-1", qty: 1 }] } as any,
          operatorPayload,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.orderItem.deleteMany).not.toHaveBeenCalled();
    });

    it("changeStatus DRAFT→PENDING promotion is blocked before the transition commits", async () => {
      prisma.order.findUnique.mockResolvedValue({ ...MOCK_ORDER, status: "DRAFT" });
      (service as any).authGuard.assertAuthorizedOrThrow.mockRejectedValueOnce(blocked);

      await expect(
        service.changeStatus("ord-1", { status: "PENDING" as any }, operatorPayload),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.order.update).not.toHaveBeenCalled();
    });
  });

  describe("createSale", () => {
    const user = { sub: "op-1", role: UserRole.OPERATOR, tenantId: "test-tenant" } as any;
    const baseDto = {
      customerId: "cust-1",
      items: [{ productId: "p1", qty: 2, unitPrice: 5 }],
      deliveredNow: true,
    } as any;
    const fakeOrder = { id: "ord-1", customerId: "cust-1", orderNumber: "ORD-1" } as any;

    beforeEach(() => {
      // Don't exercise the heavy real create() — assert the orchestration around it.
      jest.spyOn(service, "create").mockResolvedValue(fakeOrder);
    });

    it("van sale (deliveredNow=true): isolates the order, marks it DELIVERED, invoices once, sends", async () => {
      const invoices = (service as any).invoicesService;
      const result = await service.createSale({ ...baseDto, deliveredNow: true }, user);

      // A discrete sale never merges into an existing open order.
      expect(service.create).toHaveBeenCalledWith(
        expect.objectContaining({ customerId: "cust-1", status: "PENDING" }),
        user,
        { skipAutoMerge: true },
      );
      // Marked DELIVERED *directly* — bypasses changeStatus so the auto DRAFT invoice
      // never fires (no duplicate). Generated exactly one invoice, then issued it.
      expect(prisma.forTenant().order.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "ord-1" },
          data: expect.objectContaining({ status: OrderStatus.DELIVERED }),
        }),
      );
      expect(invoices.createInvoiceFromOrder).toHaveBeenCalledTimes(1);
      expect(invoices.createInvoiceFromOrder).toHaveBeenCalledWith("ord-1", undefined, {
        dueDate: undefined,
        terms: undefined,
      });
      expect(invoices.send).toHaveBeenCalledWith("inv-1");
      expect(result).toEqual(expect.objectContaining({ id: "inv-1" }));
    });

    it("bill before delivery (deliveredNow=false, send=false): PENDING order, draft invoice, not sent", async () => {
      const invoices = (service as any).invoicesService;
      await service.createSale({ ...baseDto, deliveredNow: false, send: false }, user);

      expect(prisma.forTenant().order.update).not.toHaveBeenCalled();
      expect(invoices.createInvoiceFromOrder).toHaveBeenCalledTimes(1);
      expect(invoices.send).not.toHaveBeenCalled();
    });

    it("deliver later NEVER auto-sends, even with send=true (the draft is the order's pending mirror)", async () => {
      const invoices = (service as any).invoicesService;
      await service.createSale({ ...baseDto, deliveredNow: false, send: true }, user);
      expect(invoices.send).not.toHaveBeenCalled();
    });

    it("backdated van sale threads orderDate through and delivers on that date, not today", async () => {
      const businessDate = isoDaysAgo(5);
      await service.createSale({ ...baseDto, deliveredNow: true, orderDate: businessDate }, user);

      expect(service.create).toHaveBeenCalledWith(
        expect.objectContaining({ orderDate: businessDate }),
        user,
        { skipAutoMerge: true },
      );
      expect(prisma.forTenant().order.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: OrderStatus.DELIVERED,
            deliveredAt: new Date(businessDate),
          }),
        }),
      );
    });

    // WP4 — the "New sale" screen's chosen Terms/Due Date must reach the invoice
    // instead of silently being discarded in favor of the tenant default.
    it("sale with an explicit dueDate threads it through to the created invoice", async () => {
      const invoices = (service as any).invoicesService;
      await service.createSale({ ...baseDto, dueDate: "2026-10-03", terms: "Net 60" }, user);

      expect(invoices.createInvoiceFromOrder).toHaveBeenCalledWith("ord-1", undefined, {
        dueDate: "2026-10-03",
        terms: "Net 60",
      });
    });

    it("sale without a dueDate leaves the tenant-default (+30) path unchanged", async () => {
      const invoices = (service as any).invoicesService;
      await service.createSale({ ...baseDto }, user);

      expect(invoices.createInvoiceFromOrder).toHaveBeenCalledWith("ord-1", undefined, {
        dueDate: undefined,
        terms: undefined,
      });
    });

    // ── WP4: the delivery-date picker (`deliveredOn` replaces the binary) ────

    it("a past deliveredOn delivers on THAT date and issues the invoice, overriding deliveredNow", async () => {
      const invoices = (service as any).invoicesService;
      const past = isoDaysAgo(3);

      await service.createSale({ ...baseDto, deliveredNow: false, deliveredOn: past }, user);

      expect(prisma.forTenant().order.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: OrderStatus.DELIVERED,
            deliveredAt: new Date(past),
          }),
        }),
      );
      expect(invoices.send).toHaveBeenCalledWith("inv-1");
    });

    it("a future deliveredOn schedules the order instead of delivering it", async () => {
      const invoices = (service as any).invoicesService;
      const future = isoDaysAgo(-4);

      await service.createSale({ ...baseDto, deliveredNow: true, deliveredOn: future }, user);

      expect(prisma.forTenant().order.update).not.toHaveBeenCalled();
      expect(service.create).toHaveBeenCalledWith(
        expect.objectContaining({ requestedDeliveryDate: future }),
        user,
        { skipAutoMerge: true },
      );
      expect(invoices.send).not.toHaveBeenCalled();
    });

    it("today's deliveredOn behaves exactly like deliveredNow", async () => {
      const invoices = (service as any).invoicesService;

      await service.createSale(
        { ...baseDto, deliveredNow: false, deliveredOn: isoDaysAgo(0) },
        user,
      );

      expect(prisma.forTenant().order.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: OrderStatus.DELIVERED }),
        }),
      );
      expect(invoices.send).toHaveBeenCalledWith("inv-1");
    });

    it("a non-staff caller may not backdate via deliveredOn (parseOrderDate's rule)", async () => {
      await expect(
        service.createSale({ ...baseDto, deliveredOn: isoDaysAgo(3) }, {
          sub: "drv-1",
          role: UserRole.DRIVER,
        } as any),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(service.create).not.toHaveBeenCalled();
    });

    it("omitting deliveredOn leaves the deliveredNow path byte-unchanged", async () => {
      await service.createSale({ ...baseDto, requestedDeliveryDate: "2026-09-01" }, user);

      expect(service.create).toHaveBeenCalledWith(
        expect.objectContaining({ requestedDeliveryDate: "2026-09-01" }),
        user,
        { skipAutoMerge: true },
      );
    });
  });

  // ── WP1: createSale end-to-end through the REAL create() (not mocked away
  // like the sibling describe above), proving the qty-zeroing fix reaches the
  // full "New sale" flow and doesn't regress to the "invoice could not be
  // generated" 500 the live bug produced. ──────────────────────────────────
  describe("createSale — qty-zeroing fix, end-to-end (WP1)", () => {
    it("a deliveredNow sale with boxes:0/pieces:0 lines prices from the real qty and generates its invoice", async () => {
      prisma.customer.findUnique.mockResolvedValue({
        id: "cust-1",
        user: { status: "ACTIVE" },
        pricingTier: 1,
        fulfillPath: null,
      });
      prisma.product.findMany.mockResolvedValue([MOCK_PRODUCT]); // pricePerUnit 4.99
      prisma.order.create.mockResolvedValue(MOCK_ORDER); // id "ord-1"
      (service as any).systemConfig.get.mockResolvedValue("0");
      const invoices = (service as any).invoicesService;

      const result = await service.createSale(
        {
          customerId: "cust-1",
          items: [{ productId: "prod-1", qty: 1, boxes: 0, pieces: 0 }],
          deliveredNow: true,
        } as any,
        operatorPayload,
      );

      // The real create() must NOT have zeroed the qty (the live money bug this
      // WP fixes) — the line prices at unitPrice × 1, not unitPrice × 0.
      expect(prisma.order.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            lineItems: {
              create: expect.arrayContaining([
                expect.objectContaining({ qty: 1, boxes: null, pieces: null, subtotal: 4.99 }),
              ]),
            },
          }),
        }),
      );
      // The invoice is generated (non-empty) and issued — the flow completes
      // instead of hitting the "order created but invoice could not be
      // generated" InternalServerErrorException.
      expect(invoices.createInvoiceFromOrder).toHaveBeenCalledTimes(1);
      expect(invoices.send).toHaveBeenCalledWith("inv-1");
      expect(result).toEqual(expect.objectContaining({ id: "inv-1" }));
    });
  });

  // ─── Backdated orders (orderDate) ─────────────────────────────────────────

  describe("create — orderDate", () => {
    const seedStaffCreate = () => {
      prisma.customer.findUnique.mockResolvedValue({
        id: "cust-1",
        pricingTier: 1,
        user: { status: "ACTIVE" },
      });
      prisma.customerPrice.findMany.mockResolvedValue([]);
      prisma.product.findMany.mockResolvedValue([MOCK_PRODUCT]);
      prisma.order.create.mockResolvedValue(MOCK_ORDER);
      (service as any).systemConfig.get.mockResolvedValue("0");
    };

    it("persists the staff-supplied business date", async () => {
      seedStaffCreate();
      const businessDate = isoDaysAgo(4);

      await service.create(
        { customerId: "cust-1", items: [{ productId: "prod-1", qty: 1 }], orderDate: businessDate },
        operatorPayload,
      );

      expect(prisma.order.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ orderDate: new Date(businessDate) }),
        }),
      );
    });

    it("rejects a buyer-supplied order date (403)", async () => {
      await expect(
        service.create(
          { items: [{ productId: "prod-1", qty: 1 }], orderDate: isoDaysAgo(4) },
          customerPayload,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("rejects a driver-supplied order date (403)", async () => {
      const driverPayload = { ...operatorPayload, role: "DRIVER" as const };

      await expect(
        service.create(
          {
            customerId: "cust-1",
            items: [{ productId: "prod-1", qty: 1 }],
            orderDate: isoDaysAgo(4),
          },
          driverPayload,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("rejects a future order date", async () => {
      seedStaffCreate();

      await expect(
        service.create(
          {
            customerId: "cust-1",
            items: [{ productId: "prod-1", qty: 1 }],
            orderDate: isoDaysAgo(-3),
          },
          operatorPayload,
        ),
      ).rejects.toThrow(/future/i);
    });

    it("rejects an order date more than 2 years old", async () => {
      seedStaffCreate();

      await expect(
        service.create(
          {
            customerId: "cust-1",
            items: [{ productId: "prod-1", qty: 1 }],
            orderDate: isoDaysAgo(1000),
          },
          operatorPayload,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("refuses to backdate when the order would auto-merge into an open one", async () => {
      seedStaffCreate();
      // findActiveOrder resolves a merge target — folding in would drop the date.
      prisma.order.findFirst.mockResolvedValue({ id: "ord-open", lineItems: [] });

      await expect(
        service.create(
          {
            customerId: "cust-1",
            items: [{ productId: "prod-1", qty: 1 }],
            orderDate: isoDaysAgo(4),
          },
          operatorPayload,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.order.create).not.toHaveBeenCalled();
    });

    it("allows a backdated order when the caller already chose a separate order", async () => {
      seedStaffCreate();
      prisma.order.findFirst.mockResolvedValue({ id: "ord-open", lineItems: [] });

      await expect(
        service.create(
          {
            customerId: "cust-1",
            items: [{ productId: "prod-1", qty: 1 }],
            orderDate: isoDaysAgo(4),
          },
          operatorPayload,
          { skipAutoMerge: true },
        ),
      ).resolves.toBeDefined();
    });

    it("stores a dated order as skipAutoMerge even when the caller didn't ask for it", async () => {
      seedStaffCreate();

      await service.create(
        {
          customerId: "cust-1",
          items: [{ productId: "prod-1", qty: 1 }],
          orderDate: isoDaysAgo(4),
        },
        operatorPayload,
      );

      expect(prisma.order.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ skipAutoMerge: true }) }),
      );
    });

    it("an undated order keeps the caller's merge preference", async () => {
      seedStaffCreate();
      const dto = { customerId: "cust-1", items: [{ productId: "prod-1", qty: 1 }] };

      await service.create(dto, operatorPayload);
      expect(prisma.order.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ skipAutoMerge: false }) }),
      );

      prisma.order.create.mockClear();
      await service.create(dto, operatorPayload, { skipAutoMerge: true });
      expect(prisma.order.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ skipAutoMerge: true }) }),
      );
    });

    it("a dated order is not a merge candidate — the consolidation never deletes it", async () => {
      const order = (id: string, skipAutoMerge: boolean) => ({
        id,
        customerId: "cust-1",
        status: "PENDING",
        skipAutoMerge,
        lineItems: [],
      });
      // Apply the service's own where-filter to a fixture set, the way the DB would.
      prisma.order.findMany.mockImplementation(({ where }: any) =>
        Promise.resolve(
          [order("ord-dated", true), order("ord-a", false), order("ord-b", false)].filter(
            (o) => o.skipAutoMerge === where.skipAutoMerge,
          ),
        ),
      );

      await service.mergeAllPendingForCustomer("cust-1");

      const deleted = prisma.order.delete.mock.calls.map((c: any[]) => c[0].where.id);
      expect(deleted).toEqual(["ord-b"]);
      expect(deleted).not.toContain("ord-dated");
    });

    it("the pending sweep only groups orders that are merge participants", async () => {
      prisma.order.groupBy.mockResolvedValue([]);

      await service.sweepAllPendingOrders();

      expect(prisma.order.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ skipAutoMerge: false }) }),
      );
    });
  });

  describe("sweepAllPendingOrders — tenant scoping (B323)", () => {
    it("REG-B323 sweepAllPendingOrders runs each customer group inside its own tenant context and skips null-tenant groups", async () => {
      const mergeSpy = jest
        .spyOn(service, "mergeAllPendingForCustomer")
        .mockImplementation(async (customerId: string) =>
          customerId === "cust-a" ? "ord-a-winner" : "ord-b-winner",
        );
      const warnSpy = jest
        .spyOn((service as any).logger, "warn")
        .mockImplementation(() => undefined);

      // First call: the main (customerId, tenantId) groupBy. Second call: the
      // tenantId: null-only sweep added for F1 below — a normal two-tenant sweep has
      // no null-tenant pending orders at all.
      prisma.order.groupBy
        .mockResolvedValueOnce([
          { customerId: "cust-a", tenantId: "tenant-a", _count: { _all: 2 } },
          { customerId: "cust-b", tenantId: "tenant-b", _count: { _all: 3 } },
        ])
        .mockResolvedValueOnce([]);

      const result = await service.sweepAllPendingOrders();

      // each group's merge ran inside ITS OWN tenant's context — never the other
      // group's, and never ambient/unscoped.
      expect(tenantCtx.run).toHaveBeenCalledTimes(2);
      expect(tenantCtx.run).toHaveBeenNthCalledWith(1, "tenant-a", expect.any(Function));
      expect(tenantCtx.run).toHaveBeenNthCalledWith(2, "tenant-b", expect.any(Function));
      expect(mergeSpy).toHaveBeenCalledWith("cust-a");
      expect(mergeSpy).toHaveBeenCalledWith("cust-b");
      expect(warnSpy).not.toHaveBeenCalled();

      expect(result).toEqual({ customers: 2, merged: 2, skipped: 0 });
    });

    it("REG-B323 a customer with one tenant-scoped pending order and one legacy null-tenant order is counted and warned, never dropped silently", async () => {
      const mergeSpy = jest.spyOn(service, "mergeAllPendingForCustomer");
      const warnSpy = jest
        .spyOn((service as any).logger, "warn")
        .mockImplementation(() => undefined);

      // The customer has exactly 2 pending orders total: 1 under tenant-a, 1 with a
      // null tenantId. Grouped by (customerId, tenantId) that is TWO one-row groups —
      // neither clears the main query's `having customerId._count > 1`, so the main
      // groupBy returns nothing for this customer at all (F1: this used to mean
      // nothing merged AND nothing logged). The dedicated null-tenant-only query
      // (second groupBy call) still finds and counts the null-tenant row.
      prisma.order.groupBy
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ customerId: "cust-a", _count: { _all: 1 } }]);

      const result = await service.sweepAllPendingOrders();

      expect(tenantCtx.run).not.toHaveBeenCalled();
      expect(mergeSpy).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "sweepAllPendingOrders: customer cust-a has 1 pending order(s) without tenantId — not merged (B323)",
        ),
      );
      expect(result).toEqual({ customers: 0, merged: 0, skipped: 1 });
    });
  });

  // ─── changeStatus ─────────────────────────────────────────────────────────

  describe("changeStatus", () => {
    it("should allow operators to change order status", async () => {
      prisma.order.findUnique.mockResolvedValue(MOCK_ORDER);
      prisma.order.update.mockResolvedValue({ ...MOCK_ORDER, status: "CONFIRMED" });

      const result = await service.changeStatus(
        "ord-1",
        { status: "CONFIRMED" as any },
        operatorPayload,
      );

      expect(prisma.order.update).toHaveBeenCalledWith({
        where: { id: "ord-1" },
        data: { status: "CONFIRMED" },
      });
    });

    it("should throw ForbiddenException for non-operators", async () => {
      prisma.order.findUnique.mockResolvedValue(MOCK_ORDER);
      prisma.customer.findFirst.mockResolvedValue({ id: "cust-other" });
      await expect(
        service.changeStatus("ord-1", { status: "CONFIRMED" as any }, customerPayload),
      ).rejects.toThrow(ForbiddenException);
    });

    it("cancelling voids EVERY live invoice on the order, not just the draft", async () => {
      prisma.order.findUnique.mockResolvedValue(MOCK_ORDER);
      prisma.order.findFirst.mockResolvedValue(MOCK_ORDER); // cancelImpact's own read
      prisma.order.update.mockResolvedValue({ ...MOCK_ORDER, status: "CANCELLED" });
      // cancelImpact's read, then the in-tx read of invoices to void.
      prisma.invoice.findMany
        .mockResolvedValueOnce([
          { id: "d1", invoiceNumber: "INV-1", status: "DRAFT", total: 40, payments: [] },
          { id: "s1", invoiceNumber: "INV-2", status: "SENT", total: 60, payments: [] },
        ])
        .mockResolvedValueOnce([{ id: "d1" }, { id: "s1" }]);
      const invoices = (service as any).invoicesService;

      await service.changeStatus("ord-1", { status: "CANCELLED" as any }, operatorPayload);

      // A SENT invoice used to survive the cancel and stay collectible.
      expect(invoices.voidInvoiceInTx).toHaveBeenCalledWith(expect.anything(), "d1", "ord-1");
      expect(invoices.voidInvoiceInTx).toHaveBeenCalledWith(expect.anything(), "s1", "ord-1");
      expect(creditNotesService.releaseOrderCreditsInTx).toHaveBeenCalledWith(
        expect.anything(),
        "ord-1",
      );
    });

    it("cancelling hands applied credits back before the invoices die", async () => {
      prisma.order.findUnique.mockResolvedValue(MOCK_ORDER);
      prisma.order.findFirst.mockResolvedValue(MOCK_ORDER); // cancelImpact's own read
      prisma.order.update.mockResolvedValue({ ...MOCK_ORDER, status: "CANCELLED" });
      prisma.invoice.findMany
        .mockResolvedValueOnce([
          {
            id: "inv-c",
            invoiceNumber: "INV-9",
            status: "PAID",
            total: 50,
            // Wallet money only — must NOT block the cancel.
            payments: [{ method: "CREDIT_NOTE", amount: 50, status: "PAID" }],
          },
        ])
        .mockResolvedValueOnce([{ id: "inv-c" }]);
      creditNotesService.previewOrderCreditRelease.mockResolvedValueOnce([
        { creditNoteId: "cn-1", creditNoteNumber: "CN-1", amount: 50 },
      ]);
      const invoices = (service as any).invoicesService;

      await service.changeStatus("ord-1", { status: "CANCELLED" as any }, operatorPayload);

      expect(creditNotesService.releaseOrderCreditsInTx).toHaveBeenCalled();
      expect(invoices.releaseWalletPaymentsInTx).toHaveBeenCalledWith(expect.anything(), "inv-c");
      expect(invoices.voidInvoiceInTx).toHaveBeenCalledWith(expect.anything(), "inv-c", "ord-1");
    });

    it("refuses to cancel when real cash was taken, leaving the order untouched", async () => {
      prisma.order.findUnique.mockResolvedValue(MOCK_ORDER);
      prisma.order.findFirst.mockResolvedValue(MOCK_ORDER); // cancelImpact's own read
      prisma.invoice.findMany.mockResolvedValueOnce([
        {
          id: "inv-cash",
          invoiceNumber: "INV-7",
          status: "PARTIAL",
          total: 80,
          payments: [{ method: "CASH", amount: 80, status: "PAID" }],
        },
      ]);

      await expect(
        service.changeStatus("ord-1", { status: "CANCELLED" as any }, operatorPayload),
      ).rejects.toThrow(/refunded before it can be cancelled/i);

      // The guard runs BEFORE the write — a rejected cancel must not half-apply.
      expect(prisma.order.update).not.toHaveBeenCalled();
      expect(creditNotesService.releaseOrderCreditsInTx).not.toHaveBeenCalled();
    });

    it("marking DELIVERED reconciles the pending mirror (no duplicate invoice)", async () => {
      prisma.order.findUnique.mockResolvedValue({ ...MOCK_ORDER, status: "CONFIRMED" });
      prisma.order.update.mockResolvedValue({ ...MOCK_ORDER, status: "DELIVERED" });
      const invoices = (service as any).invoicesService;
      invoices.findOpenOrderDraft.mockResolvedValueOnce({ id: "d1" });

      await service.changeStatus("ord-1", { status: "DELIVERED" as any }, operatorPayload);

      expect(invoices.reconcileOrderDraftInvoice).toHaveBeenCalledWith("ord-1", { basis: "order" });
      expect(invoices.createInvoiceFromOrderWithTenant).not.toHaveBeenCalled();
    });

    it("marking DELIVERED stamps deliveredAt from the order's business date", async () => {
      const businessDate = new Date(isoDaysAgo(6));
      prisma.order.findUnique.mockResolvedValue({
        ...MOCK_ORDER,
        status: "CONFIRMED",
        orderDate: businessDate,
        deliveredAt: null,
      });
      prisma.order.update.mockResolvedValue({ ...MOCK_ORDER, status: "DELIVERED" });

      await service.changeStatus("ord-1", { status: "DELIVERED" as any }, operatorPayload);

      expect(prisma.order.update).toHaveBeenCalledWith({
        where: { id: "ord-1" },
        data: { status: "DELIVERED", deliveredAt: businessDate },
      });
    });

    it("marking DELIVERED without a business date stamps now (it used to stamp nothing)", async () => {
      const before = Date.now();
      prisma.order.findUnique.mockResolvedValue({
        ...MOCK_ORDER,
        status: "CONFIRMED",
        orderDate: null,
        deliveredAt: null,
      });
      prisma.order.update.mockResolvedValue({ ...MOCK_ORDER, status: "DELIVERED" });

      await service.changeStatus("ord-1", { status: "DELIVERED" as any }, operatorPayload);

      const stamped = (prisma.order.update.mock.calls[0][0] as any).data.deliveredAt as Date;
      expect(stamped).toBeInstanceOf(Date);
      expect(stamped.getTime()).toBeGreaterThanOrEqual(before);
    });

    // ─── WP3: best-effort credit-note settle on DELIVERED ──────────────────

    it("marking DELIVERED best-effort settles credit notes against the order", async () => {
      prisma.order.findUnique.mockResolvedValue({ ...MOCK_ORDER, status: "CONFIRMED" });
      prisma.order.update.mockResolvedValue({ ...MOCK_ORDER, status: "DELIVERED" });
      const invoices = (service as any).invoicesService;
      invoices.findOpenOrderDraft.mockResolvedValueOnce({ id: "d1" });

      await service.changeStatus("ord-1", { status: "DELIVERED" as any }, operatorPayload);

      expect(creditNotesService.settleOrderCreditsInTx).toHaveBeenCalledWith(
        expect.anything(),
        "ord-1",
      );
    });

    // B108 (REG-B108 / R11): the settle now retries up to 3 attempts and a
    // final failure logs at ERROR (not warn) — so the rejection has to persist
    // across every attempt for the give-up path to be reached. The oracle this
    // test exists for is unchanged: delivery still resolves, never throws.
    it("a credit-settle failure after DELIVERED is swallowed (logged at error), never thrown — send()'s auto-apply catches up", async () => {
      prisma.order.findUnique.mockResolvedValue({ ...MOCK_ORDER, status: "CONFIRMED" });
      prisma.order.update.mockResolvedValue({ ...MOCK_ORDER, status: "DELIVERED" });
      const invoices = (service as any).invoicesService;
      invoices.findOpenOrderDraft.mockResolvedValueOnce({ id: "d1" });
      creditNotesService.settleOrderCreditsInTx.mockRejectedValue(
        new Error("serialization failure"),
      );
      const errorSpy = jest
        .spyOn((service as any).logger, "error")
        .mockImplementation(() => undefined);

      await expect(
        service.changeStatus("ord-1", { status: "DELIVERED" as any }, operatorPayload),
      ).resolves.toMatchObject({ status: "DELIVERED" });

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Credit settle after delivery failed"),
      );
    });

    // ─── P6-5: transactional notification triggers ────────────────────────

    it("CONFIRMED fires ORDER_CONFIRMED with the stored order total", async () => {
      prisma.order.findUnique.mockResolvedValue(MOCK_ORDER);
      prisma.order.update.mockResolvedValue({ ...MOCK_ORDER, status: "CONFIRMED" });

      await service.changeStatus("ord-1", { status: "CONFIRMED" as any }, operatorPayload);

      expect(messagingService.notifyEvent).toHaveBeenCalledWith(
        "ORDER_CONFIRMED",
        expect.objectContaining({
          customerId: "cust-1",
          senderId: "user-op",
          vars: expect.objectContaining({
            orderNumber: "ORD-123",
            orderTotal: "$16.47",
          }),
        }),
      );
    });

    it("DELIVERED fires with the stored total formatted", async () => {
      prisma.order.findUnique.mockResolvedValue({ ...MOCK_ORDER, status: "CONFIRMED" });
      prisma.order.update.mockResolvedValue({ ...MOCK_ORDER, status: "DELIVERED" });

      await service.changeStatus("ord-1", { status: "DELIVERED" as any }, operatorPayload);

      expect(messagingService.notifyEvent).toHaveBeenCalledWith(
        "DELIVERED",
        expect.objectContaining({
          customerId: "cust-1",
          senderId: "user-op",
          vars: expect.objectContaining({
            orderNumber: "ORD-123",
            orderTotal: "$16.47",
          }),
        }),
      );
    });

    it("OUT_FOR_DELIVERY fires with driverName 'your driver' when there is no routeRunId", async () => {
      prisma.order.findUnique.mockResolvedValue({ ...MOCK_ORDER, status: "CONFIRMED" });
      prisma.order.update.mockResolvedValue({ ...MOCK_ORDER, status: "OUT_FOR_DELIVERY" });

      await service.changeStatus("ord-1", { status: "OUT_FOR_DELIVERY" as any }, operatorPayload);

      expect(messagingService.notifyEvent).toHaveBeenCalledWith(
        "OUT_FOR_DELIVERY",
        expect.objectContaining({
          customerId: "cust-1",
          senderId: "user-op",
          vars: expect.objectContaining({
            orderNumber: "ORD-123",
            driverName: "your driver",
          }),
        }),
      );
      expect(prisma.routeRun.findUnique).not.toHaveBeenCalled();
    });

    // ── Ad-hoc trips + fulfillment mode: additive carrier-name else-if ──────
    it("OUT_FOR_DELIVERY on a run-less SHIP order names the carrier and writes no run data", async () => {
      prisma.order.findUnique.mockResolvedValue({
        ...MOCK_ORDER,
        status: "CONFIRMED",
        fulfillPath: "SHIP",
        shippingCarrier: "UPS",
        routeRunId: null,
      });
      prisma.order.update.mockResolvedValue({
        ...MOCK_ORDER,
        status: "OUT_FOR_DELIVERY",
        fulfillPath: "SHIP",
      });

      await service.changeStatus("ord-1", { status: "OUT_FOR_DELIVERY" as any }, operatorPayload);

      // Additive-only: the write itself carries no run/driver fields.
      expect(prisma.order.update).toHaveBeenCalledWith({
        where: { id: "ord-1" },
        data: { status: "OUT_FOR_DELIVERY" },
      });
      expect(prisma.routeRun.findUnique).not.toHaveBeenCalled();
      expect(messagingService.notifyEvent).toHaveBeenCalledWith(
        "OUT_FOR_DELIVERY",
        expect.objectContaining({
          vars: expect.objectContaining({ driverName: "UPS" }),
        }),
      );
    });

    it("OUT_FOR_DELIVERY on a run-less SHIP order with no carrier set falls back to 'the carrier'", async () => {
      prisma.order.findUnique.mockResolvedValue({
        ...MOCK_ORDER,
        status: "CONFIRMED",
        fulfillPath: "SHIP",
        shippingCarrier: null,
        routeRunId: null,
      });
      prisma.order.update.mockResolvedValue({
        ...MOCK_ORDER,
        status: "OUT_FOR_DELIVERY",
        fulfillPath: "SHIP",
      });

      await service.changeStatus("ord-1", { status: "OUT_FOR_DELIVERY" as any }, operatorPayload);

      expect(messagingService.notifyEvent).toHaveBeenCalledWith(
        "OUT_FOR_DELIVERY",
        expect.objectContaining({
          vars: expect.objectContaining({ driverName: "the carrier" }),
        }),
      );
    });

    // ── SHIP-vs-ROUTE DELIVERED invoicing parity ────────────────────────────
    // Pins that changeStatus's DELIVERED invoicing branch never forks on
    // fulfillPath: SHIP must bill exactly what ROUTE bills (the ordered qty,
    // ignoring deliveredQty) because the only additive change in this WP is
    // the OUT_FOR_DELIVERY carrier-name else-if above — the DELIVERED branch
    // and its invoicing call are byte-unchanged.
    it("SHIP orders invoice byte-identically to ROUTE orders on DELIVERED (ordered qty billed, deliveredQty ignored)", async () => {
      const invoices = (service as any).invoicesService;
      const fixture = {
        ...MOCK_ORDER,
        status: "OUT_FOR_DELIVERY" as const,
        lineItems: [{ id: "li-1", qty: 10, deliveredQty: 4, invoicedQty: 0 }],
      };

      prisma.order.findUnique.mockResolvedValueOnce({ ...fixture, fulfillPath: "ROUTE" });
      prisma.order.update.mockResolvedValueOnce({
        ...fixture,
        status: "DELIVERED",
        fulfillPath: "ROUTE",
      });
      await service.changeStatus("ord-1", { status: "DELIVERED" as any }, operatorPayload);
      const routeCall = invoices.createInvoiceFromOrderWithTenant.mock.calls[0];

      invoices.createInvoiceFromOrderWithTenant.mockClear();
      prisma.order.findUnique.mockResolvedValueOnce({ ...fixture, fulfillPath: "SHIP" });
      prisma.order.update.mockResolvedValueOnce({
        ...fixture,
        status: "DELIVERED",
        fulfillPath: "SHIP",
      });
      await service.changeStatus("ord-1", { status: "DELIVERED" as any }, operatorPayload);
      const shipCall = invoices.createInvoiceFromOrderWithTenant.mock.calls[0];

      expect(routeCall).toBeDefined();
      expect(shipCall).toEqual(routeCall);
    });

    // ── re-pin: DELIVERED with an open draft still reconciles at basis "order" ──
    it("an open draft invoice on DELIVERED always reconciles at basis 'order', never 'delivered'", async () => {
      prisma.order.findUnique.mockResolvedValue({ ...MOCK_ORDER, status: "CONFIRMED" });
      prisma.order.update.mockResolvedValue({ ...MOCK_ORDER, status: "DELIVERED" });
      const invoices = (service as any).invoicesService;
      invoices.findOpenOrderDraft.mockResolvedValueOnce({ id: "d1" });

      await service.changeStatus("ord-1", { status: "DELIVERED" as any }, operatorPayload);

      expect(invoices.reconcileOrderDraftInvoice).toHaveBeenCalledWith("ord-1", {
        basis: "order",
      });
      expect(invoices.reconcileOrderDraftInvoice).not.toHaveBeenCalledWith(
        "ord-1",
        expect.objectContaining({ basis: "delivered" }),
      );
    });

    it("CANCELLED fires the CANCELLED messaging event (N1 — real EMAIL channel)", async () => {
      // Pre-N1 this asserted NO messaging trigger at all — CANCELLED had no
      // NotificationEvent and no firing site. N1 adds one alongside the real
      // EmailChannelProvider transport so cancelled-order buyers actually hear
      // about it over EMAIL/PORTAL/WA/SMS like every other order-status event.
      prisma.order.findUnique.mockResolvedValue(MOCK_ORDER);
      prisma.order.findFirst.mockResolvedValue(MOCK_ORDER); // cancelImpact's own read
      prisma.order.update.mockResolvedValue({ ...MOCK_ORDER, status: "CANCELLED" });

      await service.changeStatus("ord-1", { status: "CANCELLED" as any }, operatorPayload);

      expect(messagingService.notifyEvent).toHaveBeenCalledWith(
        NotificationEvent.CANCELLED,
        expect.objectContaining({ customerId: MOCK_ORDER.customerId }),
      );
    });
  });

  // ─── B283: DRAFT→PENDING never reserved stock, so a later cancel credited a
  // phantom decrement that was never taken. The fix reuses create()'s own
  // decrement helper on promotion, and the existing settleStockForEdit delta
  // helper on the symmetric demotion / on cancel. ─────────────────────────────
  describe("REG-B283 — DRAFT→PENDING reserves stock symmetrically with cancel", () => {
    const DRAFT_ORDER = { ...MOCK_ORDER, status: "DRAFT" as const };

    /** Same extraction shape as the WP1 create() decrement pin above — reads the
     * `[productId, qty]` pairs bound into the aggregated
     * `UPDATE … FROM (VALUES …)` raw-SQL decrement. */
    function readAggregatedDecrementValues(txExecuteRaw: jest.Mock): any[] {
      const isSql = (v: any) => typeof v?.sql === "string" && Array.isArray(v?.values);
      const sqlText = (v: any): string =>
        v == null
          ? ""
          : typeof v === "string"
            ? v
            : isSql(v)
              ? v.sql
              : Array.isArray(v)
                ? v.map(sqlText).join(" ")
                : "";
      const flatValues = (v: any): any[] =>
        v == null
          ? []
          : isSql(v)
            ? flatValues(v.values)
            : Array.isArray(v)
              ? v.flatMap(flatValues)
              : [v];
      const call = txExecuteRaw.mock.calls.find((c: any[]) =>
        (sqlText(c[0]) + " " + sqlText(c.slice(1))).includes("currentStock"),
      );
      if (!call) return [];
      return isSql(call[0]) ? flatValues(call[0]) : flatValues(call.slice(1));
    }

    function mockTenantTransactionWithRawSpy(): jest.Mock {
      const txExecuteRaw = jest.fn().mockResolvedValue(0);
      prisma.tenantTransaction.mockImplementation((fn: any) =>
        fn({
          ...(prisma as unknown as Record<string, any>),
          $executeRaw: txExecuteRaw,
          $queryRaw: jest.fn().mockResolvedValue([]),
        }),
      );
      return txExecuteRaw;
    }

    it("REG-B283(a): DRAFT→PENDING decrements currentStock by the line quantities via create()'s own decrement helper", async () => {
      prisma.order.findUnique.mockResolvedValue(DRAFT_ORDER);
      prisma.order.updateMany.mockResolvedValue({ count: 1 });
      prisma.order.findUniqueOrThrow.mockResolvedValue({ ...DRAFT_ORDER, status: "PENDING" });
      // Serves BOTH the license-guard read (productId/trackedCategoryId) and the
      // promotion's own stock-lines read (productId/qty) — the mock ignores `select`.
      prisma.orderItem.findMany.mockResolvedValue([
        { productId: "prod-1", qty: 10, trackedCategoryId: null },
      ]);
      prisma.product.findMany.mockResolvedValue([
        { id: "prod-1", name: "Tomatoes", currentStock: 100 },
      ]);
      const txExecuteRaw = mockTenantTransactionWithRawSpy();

      await service.changeStatus("ord-1", { status: "PENDING" as any }, operatorPayload);

      const bound = readAggregatedDecrementValues(txExecuteRaw);
      expect(bound).toEqual(expect.arrayContaining(["prod-1", 10]));
    });

    it("REG-B283(b): DRAFT→PENDING→CANCELLED leaves currentStock net unchanged", async () => {
      // Step 1: promote DRAFT → PENDING — takes 10 units.
      prisma.order.findUnique.mockResolvedValue(DRAFT_ORDER);
      prisma.order.updateMany.mockResolvedValue({ count: 1 });
      prisma.order.findUniqueOrThrow.mockResolvedValue({ ...DRAFT_ORDER, status: "PENDING" });
      prisma.orderItem.findMany.mockResolvedValue([
        {
          productId: "prod-1",
          qty: 10,
          trackedCategoryId: null,
          deliveredQty: 0,
          status: "PENDING",
        },
      ]);
      prisma.product.findMany.mockResolvedValue([
        { id: "prod-1", name: "Tomatoes", currentStock: 100 },
      ]);
      const txExecuteRaw = mockTenantTransactionWithRawSpy();

      await service.changeStatus("ord-1", { status: "PENDING" as any }, operatorPayload);

      const promoted = readAggregatedDecrementValues(txExecuteRaw);
      expect(promoted).toEqual(expect.arrayContaining(["prod-1", 10]));

      // Step 2: cancel the now-PENDING order — must credit back exactly the 10
      // units the promotion above took (settleStockForEdit's edit-delta path).
      const PENDING_ORDER = { ...MOCK_ORDER, status: "PENDING" as const };
      prisma.order.findUnique.mockResolvedValue(PENDING_ORDER);
      prisma.order.findFirst.mockResolvedValue(PENDING_ORDER); // cancelImpact's own read
      prisma.order.update.mockResolvedValueOnce({ ...PENDING_ORDER, status: "CANCELLED" });
      prisma.invoice.findMany.mockResolvedValue([]); // no invoices to void
      prisma.product.update.mockClear();

      await service.changeStatus("ord-1", { status: "CANCELLED" as any }, operatorPayload);

      // Same 10 units, credited back — net delta across the pair is zero.
      expect(prisma.product.update).toHaveBeenCalledWith({
        where: { id: "prod-1" },
        data: { currentStock: { increment: 10 } },
      });
    });

    it("REG-B283(c): DRAFT→CANCELLED touches no stock", async () => {
      prisma.order.findUnique.mockResolvedValue(DRAFT_ORDER);
      prisma.order.findFirst.mockResolvedValue(DRAFT_ORDER); // cancelImpact's own read
      prisma.order.update.mockResolvedValue({ ...DRAFT_ORDER, status: "CANCELLED" });
      prisma.invoice.findMany.mockResolvedValue([]);
      prisma.orderItem.findMany.mockResolvedValue([
        { productId: "prod-1", qty: 10, deliveredQty: 0, status: "DRAFT" },
      ]);

      await service.changeStatus("ord-1", { status: "CANCELLED" as any }, operatorPayload);

      expect(prisma.product.update).not.toHaveBeenCalled();
    });

    it("REG-B283(d): the symmetric reverse (PENDING→DRAFT) credits back exactly what the promotion took", async () => {
      const PENDING_ORDER = { ...MOCK_ORDER, status: "PENDING" as const };
      prisma.order.findUnique.mockResolvedValue(PENDING_ORDER);
      prisma.order.updateMany.mockResolvedValue({ count: 1 });
      prisma.order.findUniqueOrThrow.mockResolvedValue({ ...PENDING_ORDER, status: "DRAFT" });
      prisma.orderItem.findMany.mockResolvedValue([
        { productId: "prod-1", qty: 10, deliveredQty: 0, status: "PENDING" },
      ]);

      await service.changeStatus(
        "ord-1",
        { status: "DRAFT" as any, reason: "customer asked to hold" },
        operatorPayload,
      );

      expect(prisma.product.update).toHaveBeenCalledWith({
        where: { id: "prod-1" },
        data: { currentStock: { increment: 10 } },
      });
    });

    // Round 1 (F1/F3): the status write and the stock settle used to be two
    // separate commits — the generic `order.update` ran before either tx, so a
    // crash between them left a live PENDING/DRAFT order with no matching stock
    // movement. Both are now inside the SAME `tenantTransaction`.
    it("REG-B283(e): a boxed line (unitsPerBox>1) decrements by the persisted OrderItem.qty — the same pieces-basis value create() already stored, not a re-derived boxes*unitsPerBox+pieces", async () => {
      prisma.order.findUnique.mockResolvedValue(DRAFT_ORDER);
      prisma.order.updateMany.mockResolvedValue({ count: 1 });
      prisma.order.findUniqueOrThrow.mockResolvedValue({ ...DRAFT_ORDER, status: "PENDING" });
      // 2 boxes x 12/box + 3 pieces = 27 — the pieces basis create() itself would
      // have stored on OrderItem.qty for this boxed line (see the WP1 pin above).
      prisma.orderItem.findMany.mockResolvedValue([
        { productId: "prod-box12", qty: 27, boxes: 2, pieces: 3, trackedCategoryId: null },
      ]);
      prisma.product.findMany.mockResolvedValue([
        { id: "prod-box12", name: "Eggs", currentStock: 100, unitsPerBox: 12 },
      ]);
      const txExecuteRaw = mockTenantTransactionWithRawSpy();

      await service.changeStatus("ord-1", { status: "PENDING" as any }, operatorPayload);

      const bound = readAggregatedDecrementValues(txExecuteRaw);
      expect(bound).toEqual(expect.arrayContaining(["prod-box12", 27]));
    });

    it("REG-B283(f): when the decrement rejects inside the transaction, the order status is never persisted as PENDING (decrement runs before the status write, in the same rolled-back tx)", async () => {
      prisma.order.findUnique.mockResolvedValue(DRAFT_ORDER);
      prisma.order.updateMany.mockResolvedValue({ count: 1 });
      prisma.orderItem.findMany.mockResolvedValue([
        { productId: "prod-1", qty: 10, trackedCategoryId: null },
      ]);
      const decrementSpy = jest
        .spyOn(service as any, "decrementStockForSale")
        .mockRejectedValue(new Error("stock decrement failed"));
      // Run the real callback (unlike the raw-spy helper above) so a throw inside
      // it actually prevents the final `tx.order.findUniqueOrThrow` read that
      // follows it — the whole tx (claim included) rolls back.
      prisma.tenantTransaction.mockImplementation((fn: any) => fn(prisma));

      await expect(
        service.changeStatus("ord-1", { status: "PENDING" as any }, operatorPayload),
      ).rejects.toThrow("stock decrement failed");

      expect(decrementSpy).toHaveBeenCalled();
      expect(prisma.order.findUniqueOrThrow).not.toHaveBeenCalled();
      expect(prisma.order.update).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: "PENDING" }) }),
      );
    });

    it("REG-B283(g): a second concurrent promotion loses the compare-and-set claim and never decrements stock", async () => {
      prisma.order.findUnique.mockResolvedValue(DRAFT_ORDER);
      // Simulates a racing promotion that already flipped the row to PENDING —
      // this caller's `updateMany({ where: { id, status: DRAFT } })` matches
      // nothing.
      prisma.order.updateMany.mockResolvedValue({ count: 0 });
      prisma.orderItem.findMany.mockResolvedValue([
        { productId: "prod-1", qty: 10, trackedCategoryId: null },
      ]);
      const decrementSpy = jest.spyOn(service as any, "decrementStockForSale");
      prisma.tenantTransaction.mockImplementation((fn: any) => fn(prisma));

      await expect(
        service.changeStatus("ord-1", { status: "PENDING" as any }, operatorPayload),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(decrementSpy).not.toHaveBeenCalled();
      expect(prisma.order.findUniqueOrThrow).not.toHaveBeenCalled();
    });

    it("REG-B283(h): PENDING→DRAFT with a boxed line credits back the persisted qty, and a rejected credit-back leaves the status persisted as PENDING", async () => {
      const PENDING_ORDER = { ...MOCK_ORDER, status: "PENDING" as const };
      prisma.order.findUnique.mockResolvedValue(PENDING_ORDER);
      prisma.order.updateMany.mockResolvedValue({ count: 1 });
      prisma.order.findUniqueOrThrow.mockResolvedValue({ ...PENDING_ORDER, status: "DRAFT" });
      // Same boxed-line basis as (e): persisted qty 27 (2 boxes x 12/box + 3).
      prisma.orderItem.findMany.mockResolvedValue([
        {
          productId: "prod-box12",
          qty: 27,
          boxes: 2,
          pieces: 3,
          deliveredQty: 0,
          status: "PENDING",
        },
      ]);
      const settleSpy = jest.spyOn(service as any, "settleStockForEdit");
      prisma.tenantTransaction.mockImplementation((fn: any) => fn(prisma));

      await service.changeStatus(
        "ord-1",
        { status: "DRAFT" as any, reason: "customer asked to hold" },
        operatorPayload,
      );

      expect(settleSpy).toHaveBeenCalledWith(
        prisma,
        { id: "ord-1", status: "PENDING" },
        expect.arrayContaining([expect.objectContaining({ productId: "prod-box12", qty: 27 })]),
        [],
      );

      // Now the credit-back itself rejects — the claim already flipped the row
      // in this same (mocked) transaction, but since the callback is run for
      // real, the caller sees the rejection and the final read never happens,
      // so no DRAFT status is ever returned/persisted.
      prisma.order.updateMany.mockClear().mockResolvedValue({ count: 1 });
      prisma.order.findUniqueOrThrow.mockClear();
      settleSpy.mockRejectedValueOnce(new Error("credit-back failed"));

      await expect(
        service.changeStatus(
          "ord-1",
          { status: "DRAFT" as any, reason: "customer asked to hold" },
          operatorPayload,
        ),
      ).rejects.toThrow("credit-back failed");

      expect(prisma.order.findUniqueOrThrow).not.toHaveBeenCalled();
    });
  });

  // ─── WP3: universal one-step demotion + reopen DELIVERED ──────────────────

  describe("changeStatus — one-step-back demotions (reopen DELIVERED)", () => {
    const driverPayload = {
      sub: "user-drv",
      username: "driver1",
      role: "DRIVER" as const,
      status: "ACTIVE" as const,
      forcePasswordChange: false,
    };
    const delivered = { ...MOCK_ORDER, status: "DELIVERED" as const, deliveredAt: new Date() };

    it("PENDING → DRAFT is legal for staff with a reason", async () => {
      prisma.order.findUnique.mockResolvedValue(MOCK_ORDER); // PENDING
      prisma.order.updateMany.mockResolvedValue({ count: 1 });
      prisma.order.findUniqueOrThrow.mockResolvedValue({ ...MOCK_ORDER, status: "DRAFT" });

      await service.changeStatus(
        "ord-1",
        { status: "DRAFT" as any, reason: "keyed too early" },
        operatorPayload,
      );

      expect(prisma.order.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "ord-1", status: "PENDING" },
          data: expect.objectContaining({ status: "DRAFT" }),
        }),
      );
    });

    it("PENDING → DRAFT without a reason is refused and writes nothing", async () => {
      prisma.order.findUnique.mockResolvedValue(MOCK_ORDER);

      await expect(
        service.changeStatus("ord-1", { status: "DRAFT" as any }, operatorPayload),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.order.update).not.toHaveBeenCalled();
    });

    it("DELIVERED → CONFIRMED (Reopen Order) clears deliveredAt", async () => {
      prisma.order.findUnique.mockResolvedValue(delivered);
      prisma.order.update.mockResolvedValue({ ...delivered, status: "CONFIRMED" });

      await service.changeStatus(
        "ord-1",
        { status: "CONFIRMED" as any, reason: "goods came back on the van" },
        operatorPayload,
      );

      expect(prisma.order.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "CONFIRMED", deliveredAt: null }),
        }),
      );
    });

    it("DELIVERED → PARTIALLY_DELIVERED is legal and also clears deliveredAt", async () => {
      prisma.order.findUnique.mockResolvedValue(delivered);
      prisma.order.update.mockResolvedValue({ ...delivered, status: "PARTIALLY_DELIVERED" });

      await service.changeStatus(
        "ord-1",
        { status: "PARTIALLY_DELIVERED" as any, reason: "two cases short" },
        operatorPayload,
      );

      expect(prisma.order.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: "PARTIALLY_DELIVERED",
            deliveredAt: null,
          }),
        }),
      );
    });

    it("a DELIVERED demotion without a reason is refused", async () => {
      prisma.order.findUnique.mockResolvedValue(delivered);

      await expect(
        service.changeStatus("ord-1", { status: "CONFIRMED" as any }, operatorPayload),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.order.update).not.toHaveBeenCalled();
    });

    // The DELIVERED branch (draft reconcile / auto-invoice / credit settle) is
    // keyed on dto.status === DELIVERED — a demotion AWAY from DELIVERED must
    // fire none of it, or reopening would re-invoice the order.
    it("a DELIVERED demotion fires none of the DELIVERED branch's invoicing side effects", async () => {
      const invoices = (service as any).invoicesService;
      prisma.order.findUnique.mockResolvedValue(delivered);
      prisma.order.update.mockResolvedValue({ ...delivered, status: "CONFIRMED" });

      await service.changeStatus(
        "ord-1",
        { status: "CONFIRMED" as any, reason: "reopen" },
        operatorPayload,
      );

      expect(invoices.findOpenOrderDraft).not.toHaveBeenCalled();
      expect(invoices.reconcileOrderDraftInvoice).not.toHaveBeenCalled();
      expect(invoices.createInvoiceFromOrderWithTenant).not.toHaveBeenCalled();
    });

    it("drivers may not reopen a delivered order", async () => {
      prisma.order.findUnique.mockResolvedValue(delivered);

      await expect(
        service.changeStatus("ord-1", { status: "CONFIRMED" as any, reason: "x" }, driverPayload),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("409s when the order was delivered on a COMPLETED route-run stop", async () => {
      prisma.order.findUnique.mockResolvedValue({ ...delivered, routeRunStopId: "stop-1" });
      prisma.routeRunStop.findUnique.mockResolvedValue({ status: "COMPLETED" });

      await expect(
        service.changeStatus(
          "ord-1",
          { status: "CONFIRMED" as any, reason: "reopen" },
          operatorPayload,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.order.update).not.toHaveBeenCalled();
    });

    it("a stale, non-COMPLETED stop link does not block the reopen", async () => {
      prisma.order.findUnique.mockResolvedValue({ ...delivered, routeRunStopId: "stop-1" });
      prisma.routeRunStop.findUnique.mockResolvedValue({ status: "PENDING" });
      prisma.order.update.mockResolvedValue({ ...delivered, status: "CONFIRMED" });

      await service.changeStatus(
        "ord-1",
        { status: "CONFIRMED" as any, reason: "reopen" },
        operatorPayload,
      );

      expect(prisma.order.update).toHaveBeenCalled();
    });
  });

  // ─── WP3: delete-any (money, not status, is the gate) ─────────────────────

  describe("deleteOrder — delete-any", () => {
    const deliveredOrder = {
      ...MOCK_ORDER,
      status: "DELIVERED" as const,
      invoices: [{ id: "d1" }],
      transaction: null,
    };

    beforeEach(() => {
      // deleteOrder's own lookup is order.findUnique (full include), but the
      // cancelImpact() it delegates the payment check to uses order.findFirst
      // since the tenant-scope sweep — both must see the order.
      prisma.order.findFirst.mockResolvedValue(deliveredOrder);
    });

    it("staff may delete a DELIVERED order, cascading its unpaid invoice", async () => {
      prisma.order.findUnique.mockResolvedValue(deliveredOrder);

      await expect(service.deleteOrder("ord-1", operatorPayload)).resolves.toEqual({
        success: true,
      });

      expect(prisma.invoice.delete).toHaveBeenCalledWith({ where: { id: "d1" } });
      expect(prisma.order.delete).toHaveBeenCalledWith({ where: { id: "ord-1" } });
    });

    it("409s when a linked invoice has recorded (external) payments", async () => {
      prisma.order.findUnique.mockResolvedValue(deliveredOrder);
      prisma.invoice.findMany.mockResolvedValue([
        {
          id: "d1",
          invoiceNumber: "INV-1",
          status: "PAID",
          total: 50,
          payments: [{ method: "CASH", amount: 50, status: "PAID" }],
        },
      ]);

      await expect(service.deleteOrder("ord-1", operatorPayload)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.order.delete).not.toHaveBeenCalled();
    });

    // PR-2 (check-payments B1 hardening) REG — N4 (Opus review-v2): cancelImpact's
    // external-payment guard must use isBlockingPayment (status !== VOID), never
    // isHeldPayment (PAID ∪ PENDING) — a DRAFT external payment is money in flight
    // and master deliberately keeps it blocking a cancel/delete. Swapping to
    // isHeldPayment would silently let an unconfirmed DRAFT payment through and
    // reverse that block; this pins the DRAFT case failing exactly like the PAID
    // case above.
    it("409s when a linked invoice has only a DRAFT (unconfirmed) external payment", async () => {
      prisma.order.findUnique.mockResolvedValue(deliveredOrder);
      prisma.invoice.findMany.mockResolvedValue([
        {
          id: "d1",
          invoiceNumber: "INV-1",
          status: "SENT",
          total: 50,
          payments: [{ method: "CASH", amount: 50, status: "DRAFT" }],
        },
      ]);

      await expect(service.deleteOrder("ord-1", operatorPayload)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.order.delete).not.toHaveBeenCalled();
    });

    // #341's wallet behaviour must survive the liberalization: credit-note money
    // is handed back and the delete proceeds — only real cash blocks it.
    it("a wallet-only PAID invoice still deletes and returns the credit", async () => {
      prisma.order.findUnique.mockResolvedValue(deliveredOrder);
      prisma.invoice.findMany.mockResolvedValue([
        {
          id: "d1",
          invoiceNumber: "INV-1",
          status: "PAID",
          total: 50,
          payments: [{ method: "CREDIT_NOTE", amount: 50, status: "PAID" }],
        },
      ]);

      await service.deleteOrder("ord-1", operatorPayload);

      expect(creditNotesService.releaseOrderCreditsInTx).toHaveBeenCalled();
      expect(prisma.order.delete).toHaveBeenCalledWith({ where: { id: "ord-1" } });
    });

    it("409s when returns are recorded against the order (restrict-linked)", async () => {
      prisma.order.findUnique.mockResolvedValue(deliveredOrder);
      prisma.return.count.mockResolvedValue(1);

      await expect(service.deleteOrder("ord-1", operatorPayload)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.order.delete).not.toHaveBeenCalled();
    });

    it("REG-B214 (T8): deleteOrder refuses (409) while an invoice it deletes sourced a credit note with unspent balance", async () => {
      prisma.order.findUnique.mockResolvedValue(deliveredOrder);
      prisma.creditNote.findMany.mockResolvedValue([
        {
          id: "cn-1",
          creditNoteNumber: "CN-0001",
          invoiceId: "d1",
          amount: 50,
          amountUsed: 0,
          status: "ISSUED",
          expiresAt: null,
        },
      ]);

      await expect(service.deleteOrder("ord-1", operatorPayload)).rejects.toMatchObject({
        response: { code: "INVOICE_HAS_UNSPENT_CREDIT" },
      });
      expect(prisma.order.delete).not.toHaveBeenCalled();
      // The guard is the FIRST statement in the tx: the refusal precedes every money write,
      // so nothing has to roll back (the mocked tx has no rollback to lean on).
      expect(creditNotesService.releaseOrderCreditsInTx).not.toHaveBeenCalled();
      expect((service as any).invoicesService.releaseWalletPaymentsInTx).not.toHaveBeenCalled();
    });

    /** The tx deleteOrder runs its two guard calls in, with a spy-able `$executeRaw`. */
    const captureDeleteTx = () => {
      const seenTx: any = {
        ...prisma.forTenant(),
        $executeRaw: jest.fn().mockResolvedValue(0),
        $queryRaw: jest.fn().mockResolvedValue([]),
      };
      prisma.tenantTransaction.mockImplementationOnce(async (fn: any) => fn(seenTx));
      return seenTx;
    };

    // TOCTOU: the post-release read decides whether these invoices may be destroyed, so it runs
    // under the rows' own lock — otherwise a void/restore committing in between re-opens a credit
    // note the guard just cleared. The lock is taken LAST, after the releases already hold the
    // InvoicePayment/CreditNote rows — voidInvoice's order. Taking Invoice FIRST would let a
    // blocking lock acquired later close a 40P01 cycle.
    it("P21: the post-release guard locks the invoice rows (NOWAIT) after the releases, before re-reading their credit notes", async () => {
      prisma.order.findUnique.mockResolvedValue(deliveredOrder);
      prisma.creditNote.findMany.mockResolvedValue([]);
      const seenTx = captureDeleteTx();

      await service.deleteOrder("ord-1", operatorPayload);

      const sql = seenTx.$executeRaw.mock.calls[0][0].join("?");
      expect(sql).toContain('"Invoice"');
      expect(sql).toContain("FOR NO KEY UPDATE NOWAIT");
      const lockAt = seenTx.$executeRaw.mock.invocationCallOrder[0];
      expect(lockAt).toBeGreaterThan(
        creditNotesService.releaseOrderCreditsInTx.mock.invocationCallOrder[0],
      );
      expect(lockAt).toBeGreaterThan(
        (service as any).invoicesService.releaseWalletPaymentsInTx.mock.invocationCallOrder[0],
      );
      // …and still before the read it protects — the post-release credit re-read.
      expect(lockAt).toBeLessThan(seenTx.creditNote.findMany.mock.invocationCallOrder.at(-1));
    });

    // The lock is OPT-IN, and this is the only call site that opts in. The pre-release call (like
    // deleteInvoice and the auto-merge loser-draft call) holds no payment/credit rows yet, so
    // locking Invoice there would make it the tx's FIRST lock — the 40P01 shape. Its residual
    // read-then-delete window is accepted and filed.
    it("P23: the pre-release guard call takes no row lock — deleteOrder issues exactly one", async () => {
      prisma.order.findUnique.mockResolvedValue(deliveredOrder);
      prisma.creditNote.findMany.mockResolvedValue([]);
      const seenTx = captureDeleteTx();

      await service.deleteOrder("ord-1", operatorPayload);

      expect(seenTx.$executeRaw).toHaveBeenCalledTimes(1);
      expect(seenTx.$executeRaw.mock.invocationCallOrder[0]).toBeGreaterThan(
        seenTx.creditNote.findMany.mock.invocationCallOrder[0],
      );
    });

    it("P1: still deletes when the sourced credit note is fully spent", async () => {
      prisma.order.findUnique.mockResolvedValue(deliveredOrder);
      prisma.creditNote.findMany.mockResolvedValue([
        {
          id: "cn-1",
          creditNoteNumber: "CN-0001",
          invoiceId: "d1",
          amount: 50,
          amountUsed: 50,
          status: "APPLIED",
          expiresAt: null,
        },
      ]);

      await expect(service.deleteOrder("ord-1", operatorPayload)).resolves.toEqual({
        success: true,
      });
    });

    it("P2: still deletes when the sourced credit note is VOID", async () => {
      prisma.order.findUnique.mockResolvedValue(deliveredOrder);
      prisma.creditNote.findMany.mockResolvedValue([
        {
          id: "cn-1",
          creditNoteNumber: "CN-0001",
          invoiceId: "d1",
          amount: 50,
          amountUsed: 0,
          status: "VOID",
          expiresAt: null,
        },
      ]);

      await expect(service.deleteOrder("ord-1", operatorPayload)).resolves.toEqual({
        success: true,
      });
    });

    it("P3: still deletes when the sourced credit note's unspent balance has expired", async () => {
      prisma.order.findUnique.mockResolvedValue(deliveredOrder);
      prisma.creditNote.findMany.mockResolvedValue([
        {
          id: "cn-1",
          creditNoteNumber: "CN-0001",
          invoiceId: "d1",
          amount: 50,
          amountUsed: 0,
          status: "ISSUED",
          expiresAt: new Date(Date.now() - 86_400_000),
        },
      ]);

      await expect(service.deleteOrder("ord-1", operatorPayload)).resolves.toEqual({
        success: true,
      });
    });

    // B214: the guard also runs AFTER releaseOrderCreditsInTx/releaseWalletPaymentsInTx, because
    // those revive (un-spend/un-expire/un-VOID) a note this order's invoices sourced. First read
    // = spent (fast path passes), second read = revived (the delete must refuse).
    it("P5: refuses when the wallet release re-opens a sourced credit note the first read saw spent", async () => {
      prisma.order.findUnique.mockResolvedValue(deliveredOrder);
      prisma.creditNote.findMany
        .mockResolvedValueOnce([
          {
            id: "cn-1",
            creditNoteNumber: "CN-0001",
            invoiceId: "d1",
            amount: 50,
            amountUsed: 50,
            status: "APPLIED",
            expiresAt: null,
          },
        ])
        .mockResolvedValueOnce([
          {
            id: "cn-1",
            creditNoteNumber: "CN-0001",
            invoiceId: "d1",
            amount: 50,
            amountUsed: 0,
            status: "ISSUED",
            expiresAt: null,
          },
        ]);

      await expect(service.deleteOrder("ord-1", operatorPayload)).rejects.toMatchObject({
        response: { code: "INVOICE_HAS_UNSPENT_CREDIT" },
      });
      expect(creditNotesService.releaseOrderCreditsInTx).toHaveBeenCalledTimes(1);
      expect(prisma.invoice.delete).not.toHaveBeenCalled();
      expect(prisma.order.delete).not.toHaveBeenCalled();
    });

    // The two refusals have different causes, so they read differently: the pre-release one names
    // a balance the operator could have seen; the post-release one names what the delete WOULD do.
    it("P22: the post-release refusal says the delete would hand the credit back; the pre-release one doesn't", async () => {
      const sourcedNote = (amountUsed: number, status: string) => [
        {
          id: "cn-1",
          creditNoteNumber: "CN-0001",
          invoiceId: "d1",
          amount: 50,
          amountUsed,
          status,
          expiresAt: null,
        },
      ];
      prisma.order.findUnique.mockResolvedValue(deliveredOrder);
      prisma.creditNote.findMany
        .mockResolvedValueOnce(sourcedNote(50, "APPLIED")) // first read: spent → passes
        .mockResolvedValueOnce(sourcedNote(0, "ISSUED")); // revived by the release

      const afterRelease: any = await service.deleteOrder("ord-1", operatorPayload).catch((e) => e);

      expect(afterRelease.getResponse().message).toContain("would hand credit CN-0001");
      expect(afterRelease.getResponse().message).not.toContain("still unspent");

      prisma.creditNote.findMany.mockReset();
      prisma.creditNote.findMany.mockResolvedValue(sourcedNote(0, "ISSUED"));

      const preRelease: any = await service.deleteOrder("ord-1", operatorPayload).catch((e) => e);

      expect(preRelease.getResponse().message).toContain("still unspent");
      expect(preRelease.getResponse().message).not.toContain("would hand credit");
    });

    it("non-staff callers keep the old DRAFT/PENDING/CANCELLED allowlist", async () => {
      prisma.order.findUnique.mockResolvedValue(deliveredOrder);

      await expect(service.deleteOrder("ord-1", customerPayload as any)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.order.delete).not.toHaveBeenCalled();
    });
  });

  // ─── updateFulfillPath (ad-hoc trips + fulfillment mode) ──────────────────

  describe("updateFulfillPath", () => {
    it("rejects the change once the order is OUT_FOR_DELIVERY", async () => {
      prisma.order.findFirst.mockResolvedValue({
        ...MOCK_ORDER,
        status: "OUT_FOR_DELIVERY",
      });

      await expect(
        service.updateFulfillPath("ord-1", { fulfillPath: "SHIP" } as any, operatorPayload),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.order.update).not.toHaveBeenCalled();
    });

    it("rejects the change once the order is DELIVERED", async () => {
      prisma.order.findFirst.mockResolvedValue({ ...MOCK_ORDER, status: "DELIVERED" });

      await expect(
        service.updateFulfillPath("ord-1", { fulfillPath: "SHIP" } as any, operatorPayload),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.order.update).not.toHaveBeenCalled();
    });

    it("rejects the change once the order is CANCELLED", async () => {
      prisma.order.findFirst.mockResolvedValue({ ...MOCK_ORDER, status: "CANCELLED" });

      await expect(
        service.updateFulfillPath("ord-1", { fulfillPath: "SHIP" } as any, operatorPayload),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.order.update).not.toHaveBeenCalled();
    });

    it("succeeds on a CONFIRMED (open) order", async () => {
      prisma.order.findFirst.mockResolvedValue({ ...MOCK_ORDER, status: "CONFIRMED" });
      prisma.order.update.mockResolvedValue({
        ...MOCK_ORDER,
        status: "CONFIRMED",
        fulfillPath: "SHIP",
      });

      const result = await service.updateFulfillPath(
        "ord-1",
        { fulfillPath: "SHIP" } as any,
        operatorPayload,
      );

      expect(prisma.order.update).toHaveBeenCalledWith({
        where: { id: "ord-1" },
        data: { fulfillPath: "SHIP" },
      });
      expect(result.fulfillPath).toBe("SHIP");
    });

    it("rejects the switch to SHIP while the order is on an active run", async () => {
      // The dispatch sweep attaches orders while they're still CONFIRMED, so
      // status alone would let a dispatched order flip to SHIP mid-route.
      prisma.order.findFirst.mockResolvedValue({
        ...MOCK_ORDER,
        status: "CONFIRMED",
        routeRunStopId: "run-stop-1",
        routeRunStop: { routeRun: { status: "IN_PROGRESS", driver: { contactName: "Dana" } } },
      });

      await expect(
        service.updateFulfillPath("ord-1", { fulfillPath: "SHIP" } as any, operatorPayload),
      ).rejects.toThrow(/active delivery run with Dana/);
      expect(prisma.order.update).not.toHaveBeenCalled();
    });

    it("allows the switch to SHIP when the run attachment is stale (finished run)", async () => {
      // `routeRunStopId` is never cleared on completion — a stale link must not
      // lock the order out of fulfillment changes forever.
      prisma.order.findFirst.mockResolvedValue({
        ...MOCK_ORDER,
        status: "CONFIRMED",
        routeRunStopId: "run-stop-1",
        routeRunStop: { routeRun: { status: "COMPLETED", driver: null } },
      });
      prisma.order.update.mockResolvedValue({ ...MOCK_ORDER, fulfillPath: "SHIP" });

      await service.updateFulfillPath("ord-1", { fulfillPath: "SHIP" } as any, operatorPayload);

      expect(prisma.order.update).toHaveBeenCalledWith({
        where: { id: "ord-1" },
        data: { fulfillPath: "SHIP" },
      });
    });

    it("still allows switching back to ROUTE on an active run", async () => {
      prisma.order.findFirst.mockResolvedValue({
        ...MOCK_ORDER,
        status: "CONFIRMED",
        fulfillPath: "SHIP",
        routeRunStopId: "run-stop-1",
        routeRunStop: { routeRun: { status: "SCHEDULED", driver: { contactName: "Dana" } } },
      });
      prisma.order.update.mockResolvedValue({ ...MOCK_ORDER, fulfillPath: "ROUTE" });

      await service.updateFulfillPath("ord-1", { fulfillPath: "ROUTE" } as any, operatorPayload);

      expect(prisma.order.update).toHaveBeenCalledWith({
        where: { id: "ord-1" },
        data: { fulfillPath: "ROUTE" },
      });
    });

    it("throws NotFoundException for a non-existent order", async () => {
      prisma.order.findFirst.mockResolvedValue(null);

      await expect(
        service.updateFulfillPath("nonexistent", { fulfillPath: "SHIP" } as any, operatorPayload),
      ).rejects.toThrow(NotFoundException);
    });

    it("reads the order tenant-scoped so a cross-tenant id 404s", async () => {
      // forTenant()'s findUnique can only post-filter on a returned `tenantId`,
      // which an exclusive `select` omitting it silently defeats — a foreign
      // order's status and driver name would then leak through the 400 messages.
      // findFirst gets `tenantId` injected into the where, so the row is simply
      // never returned. Pin the method AND the where.
      await expect(
        service.updateFulfillPath(
          "other-tenant-order",
          { fulfillPath: "SHIP" } as any,
          operatorPayload,
        ),
      ).rejects.toThrow(NotFoundException);

      expect(prisma.order.findUnique).not.toHaveBeenCalled();
      expect(prisma.order.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "other-tenant-order" } }),
      );
      expect(prisma.order.update).not.toHaveBeenCalled();
    });
  });

  // ─── toggleUrgent ─────────────────────────────────────────────────────────

  describe("toggleUrgent", () => {
    it("should toggle the urgent flag", async () => {
      prisma.order.findUnique.mockResolvedValue(MOCK_ORDER); // urgent: false
      prisma.order.update.mockResolvedValue({ ...MOCK_ORDER, urgent: true });

      await service.toggleUrgent("ord-1", operatorPayload);

      expect(prisma.order.update).toHaveBeenCalledWith({
        where: { id: "ord-1" },
        data: { urgent: true },
      });
    });

    it("should throw NotFoundException for non-existent order", async () => {
      prisma.order.findUnique.mockResolvedValue(null);
      await expect(service.toggleUrgent("nonexistent", operatorPayload)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ─── updateOrderItems — per-line price override (DRAFT / PENDING / CONFIRMED) ─

  describe("updateOrderItems — per-line price override", () => {
    const draftOrder = {
      ...MOCK_ORDER,
      status: "DRAFT" as const,
      orderNumber: "ORD-DRAFT",
      lineItems: [
        {
          id: "li-1",
          orderId: "ord-1",
          productId: "prod-1",
          qty: 3,
          unitPrice: 4.99,
          subtotal: 14.97,
          status: "PENDING",
          boxes: null,
          pieces: null,
          priceType: "STANDARD",
          originalPrice: null,
        },
      ],
    };

    it("flags a lowered unit price as a MANUAL override and records audit fields", async () => {
      prisma.order.findUnique.mockResolvedValue(draftOrder);
      prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 12, status: "PENDING" }]);

      await service.updateOrderItems(
        "ord-1",
        {
          items: [{ id: "li-1", action: "UPDATE", qty: 3, unitPrice: 4, overrideReason: "promo" }],
        },
        operatorPayload,
      );

      // Override is stored as net unitPrice + originalPrice (strikethrough) — never a
      // re-derived discount field (commit #101 convention). Subtotal goes through
      // computeLineSubtotal → 4 × 3 = 12, money-rounded.
      expect(prisma.orderItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "li-1" },
          data: expect.objectContaining({
            unitPrice: 4,
            subtotal: 12,
            priceType: "MANUAL",
            originalPrice: 4.99,
            overrideReason: "promo",
            overriddenBy: "user-op",
          }),
        }),
      );
      // Order totals recomputed from the discounted line subtotal.
      expect(prisma.order.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ subtotal: 12 }) }),
      );
    });

    it("flags a RAISED unit price as a MANUAL upsell anchored to the catalog price", async () => {
      prisma.order.findUnique.mockResolvedValue(draftOrder);
      // The anchor reads the live catalog price for originalPrice.
      prisma.product.findUnique.mockResolvedValue({ pricePerUnit: 4.99 });
      prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 24, status: "PENDING" }]);

      await service.updateOrderItems(
        "ord-1",
        {
          items: [{ id: "li-1", action: "UPDATE", qty: 3, unitPrice: 8, overrideReason: "market" }],
        },
        operatorPayload,
      );

      // Upsell: net unitPrice ABOVE catalog, originalPrice = catalog base (< unitPrice),
      // priceType MANUAL. Subtotal via computeLineSubtotal → 8 × 3 = 24 (no double-count).
      expect(prisma.orderItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "li-1" },
          data: expect.objectContaining({
            unitPrice: 8,
            subtotal: 24,
            priceType: "MANUAL",
            originalPrice: 4.99,
            overriddenBy: "user-op",
          }),
        }),
      );
    });

    it("re-editing an upsell down but still above catalog stays an upsell (anchors originalPrice to catalog, not the prior net)", async () => {
      // Line already carries a prior upsell net of 8; catalog is 5.
      const upsoldOrder = {
        ...draftOrder,
        lineItems: [
          { ...draftOrder.lineItems[0], unitPrice: 8, originalPrice: 5, priceType: "MANUAL" },
        ],
      };
      prisma.order.findUnique.mockResolvedValue(upsoldOrder);
      prisma.product.findFirst.mockResolvedValue({ pricePerUnit: 5 }); // catalog anchor read
      prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 18, status: "PENDING" }]);

      await service.updateOrderItems(
        "ord-1",
        { items: [{ id: "li-1", action: "UPDATE", qty: 3, unitPrice: 6 }] },
        operatorPayload,
      );

      // originalPrice must be the CATALOG (5), never the prior net (8) — otherwise the
      // line would flip to a fake discount (5 < 6, but 8 > 6) and leak a bogus "was" price.
      expect(prisma.orderItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            unitPrice: 6,
            priceType: "MANUAL",
            originalPrice: 5,
          }),
        }),
      );
    });

    it("does not flag an override when the price is unchanged", async () => {
      prisma.order.findUnique.mockResolvedValue(draftOrder);
      prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 14.97, status: "PENDING" }]);

      await service.updateOrderItems(
        "ord-1",
        { items: [{ id: "li-1", action: "UPDATE", qty: 3, unitPrice: 4.99 }] },
        operatorPayload,
      );

      const updateArg = prisma.orderItem.update.mock.calls[0][0] as any;
      expect(updateArg.data).not.toHaveProperty("priceType");
      expect(updateArg.data).not.toHaveProperty("originalPrice");
      expect(updateArg.data.unitPrice).toBe(4.99);
    });

    it("REG-MSCAN-M1-server: a reason-only UPDATE persists the new reason and leaves unitPrice/priceType untouched", async () => {
      // F2 server half: overrideReason used to live inside the isManualOverride
      // branch, so a reason-only edit (price unchanged, isManualOverride false)
      // silently dropped the new reason. Mirrors the client-side fix in
      // order-item-diff.ts (F3 mobile).
      prisma.order.findUnique.mockResolvedValue(draftOrder);
      prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 14.97, status: "PENDING" }]);

      await service.updateOrderItems(
        "ord-1",
        {
          items: [
            { id: "li-1", action: "UPDATE", qty: 3, unitPrice: 4.99, overrideReason: "damaged" },
          ],
        },
        operatorPayload,
      );

      const updateArg = prisma.orderItem.update.mock.calls[0][0] as any;
      expect(updateArg.data.overrideReason).toBe("damaged");
      expect(updateArg.data.unitPrice).toBe(4.99);
      expect(updateArg.data).not.toHaveProperty("priceType");
      expect(updateArg.data).not.toHaveProperty("originalPrice");
      // F4 (independent review, PR-2): overriddenBy must move WITH overrideReason — a
      // reason-only edit that writes no attribution leaves an audit/dispute pointing at
      // whoever last touched the (untouched, here) isManualOverride branch instead of the
      // operator who actually made THIS edit.
      expect(updateArg.data.overriddenBy).toBe("user-op");
    });

    it("REG-MSCAN-M1-server-noqty: a QTY-LESS reason-only UPDATE (no qty/boxes/pieces at all) still persists the reason + attribution, and touches NOTHING else (N4)", async () => {
      // F3 (independent review round 1, PR-2): the branch gate used to be
      // `item.qty !== undefined || item.boxes != null || item.pieces != null` — a payload
      // carrying ONLY overrideReason (mobile's "flag damaged, don't touch qty" edit) matched
      // NONE of those and never reached the reason-write below at all, so
      // prisma.orderItem.update was never even called. This is the exact payload shape the
      // qty-inclusive REG-MSCAN-M1-server case above does not exercise.
      //
      // N4 (independent review round 2, PR-2): once reachable, this payload shape must take a
      // fully separate, MINIMAL write — not fall through into the qty/box normalization logic
      // and re-derive qty/unitPrice from the line's stored values. See the box-split case below
      // for why "falls back to the stored value" is not actually safe.
      prisma.order.findUnique.mockResolvedValue(draftOrder);
      prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 14.97, status: "PENDING" }]);

      await service.updateOrderItems(
        "ord-1",
        { items: [{ id: "li-1", action: "UPDATE", overrideReason: "damaged" }] },
        operatorPayload,
      );

      const updateArg = prisma.orderItem.update.mock.calls[0][0] as any;
      expect(updateArg.where).toEqual({ id: "li-1" });
      expect(updateArg.data.overrideReason).toBe("damaged");
      expect(updateArg.data.overriddenBy).toBe("user-op");
      // Nothing qty/box/price-related is even COMPUTED for this payload shape, let alone written.
      expect(updateArg.data).not.toHaveProperty("qty");
      expect(updateArg.data).not.toHaveProperty("boxes");
      expect(updateArg.data).not.toHaveProperty("pieces");
      expect(updateArg.data).not.toHaveProperty("unitsPerBox");
      expect(updateArg.data).not.toHaveProperty("unitPrice");
      expect(updateArg.data).not.toHaveProperty("subtotal");
      expect(updateArg.data).not.toHaveProperty("priceType");
      expect(updateArg.data).not.toHaveProperty("originalPrice");
      expect(updateArg.data).not.toHaveProperty("promoFreeUnits");
      expect(updateArg.data).not.toHaveProperty("name");
      // And no product lookup either — the whole point is this payload shape never needs one.
      expect(prisma.product.findFirst).not.toHaveBeenCalled();
    });

    it("N4 (independent review round 2, PR-2): a REASON-ONLY edit of a box-split line with NO unitsPerBox snapshot never re-derives qty/boxes/pieces from a live product lookup", async () => {
      // The line's OWN unitsPerBox snapshot is missing — under the pre-N4 code this fell back to
      // a LIVE product lookup + normalizeBoxesPieces re-derivation for EVERY edit reaching this
      // branch, including a reason-only one. If the live product's box size has since changed
      // (a real possibility — box size is a catalog setting, not sale-time-frozen), that
      // re-derivation can silently produce different boxes/pieces/subtotal than what is stored.
      // A reason-only edit must never reach that logic at all, so a live product handed back a
      // DELIBERATELY different box size here would prove nothing changed if it fired.
      const boxSplitOrder = {
        ...draftOrder,
        lineItems: [
          {
            id: "li-1",
            orderId: "ord-1",
            productId: "prod-1",
            qty: 24,
            boxes: 2,
            pieces: null,
            unitPrice: 10,
            subtotal: 240,
            status: "PENDING",
            priceType: "STANDARD",
            originalPrice: null,
            // unitsPerBox deliberately OMITTED — no cached snapshot, the exact gap that used to
            // trigger a live lookup.
          },
        ],
      };
      prisma.order.findUnique.mockResolvedValue(boxSplitOrder);
      prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 240, status: "PENDING" }]);
      prisma.product.findFirst.mockResolvedValue({
        unitsPerBox: 6,
        pricePerUnit: 10,
        category: null,
      });

      await service.updateOrderItems(
        "ord-1",
        { items: [{ id: "li-1", action: "UPDATE", overrideReason: "damaged" }] },
        operatorPayload,
      );

      expect(prisma.product.findFirst).not.toHaveBeenCalled();
      const updateArg = prisma.orderItem.update.mock.calls[0][0] as any;
      expect(updateArg.data).not.toHaveProperty("qty");
      expect(updateArg.data).not.toHaveProperty("boxes");
      expect(updateArg.data).not.toHaveProperty("pieces");
      expect(updateArg.data).not.toHaveProperty("unitsPerBox");
      expect(updateArg.data).not.toHaveProperty("unitPrice");
      expect(updateArg.data).not.toHaveProperty("subtotal");
      expect(updateArg.data.overrideReason).toBe("damaged");
      expect(updateArg.data.overriddenBy).toBe("user-op");
    });

    it("round 3 finding 1 (independent review, PR-2): a reason/notes-only edit that ALSO renames an unlisted line must still write the new name — the N4 fast path must not drop it", async () => {
      // N4's fast path (added round 2) writes only overrideReason/overriddenBy/notes — it never
      // carried `item.name` through, so an unlisted line's rename silently vanished whenever the
      // SAME payload also included a reason or notes (which is exactly what routes a rename
      // through this branch at all: the outer gate has no `item.name` clause of its own).
      const unlistedOrder = {
        ...draftOrder,
        lineItems: [
          {
            id: "li-1",
            orderId: "ord-1",
            productId: null,
            name: "Old Name",
            qty: 3,
            unitPrice: 4.99,
            subtotal: 14.97,
            status: "PENDING",
            boxes: null,
            pieces: null,
            priceType: "STANDARD",
            originalPrice: null,
          },
        ],
      };
      prisma.order.findUnique.mockResolvedValue(unlistedOrder);
      prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 14.97, status: "PENDING" }]);

      await service.updateOrderItems(
        "ord-1",
        {
          items: [
            {
              id: "li-1",
              action: "UPDATE",
              name: "New Name",
              notes: "renamed at customer's request",
            },
          ],
        },
        operatorPayload,
      );

      const updateArg = prisma.orderItem.update.mock.calls[0][0] as any;
      expect(updateArg.data.name).toBe("New Name");
      expect(updateArg.data.notes).toBe("renamed at customer's request");
      expect(updateArg.data).not.toHaveProperty("qty");
      expect(updateArg.data).not.toHaveProperty("unitPrice");
    });

    it("applies a price override on a PENDING order (not just DRAFT)", async () => {
      // The web + mobile UIs now expose price/discount editing on PENDING and
      // CONFIRMED orders, not only DRAFT. The service must honor the override on
      // those statuses exactly as it does on DRAFT.
      const pendingOrder = {
        ...draftOrder,
        status: "PENDING" as const,
        orderNumber: "ORD-PENDING",
      };
      prisma.order.findUnique.mockResolvedValue(pendingOrder);
      prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 9, status: "PENDING" }]);

      await service.updateOrderItems(
        "ord-1",
        {
          items: [
            { id: "li-1", action: "UPDATE", qty: 3, unitPrice: 3, overrideReason: "loyalty" },
          ],
        },
        operatorPayload,
      );

      // Net unitPrice + originalPrice (strikethrough); subtotal via computeLineSubtotal → 3 × 3 = 9.
      expect(prisma.orderItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "li-1" },
          data: expect.objectContaining({
            unitPrice: 3,
            subtotal: 9,
            priceType: "MANUAL",
            originalPrice: 4.99,
            overrideReason: "loyalty",
            overriddenBy: "user-op",
          }),
        }),
      );
      expect(prisma.order.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ subtotal: 9 }) }),
      );
    });
  });

  // ─── updateOrderItems — shipping fee ─────────────────────────────────────

  describe("updateOrderItems — shipping fee", () => {
    const draftOrder = {
      ...MOCK_ORDER,
      status: "DRAFT" as const,
      orderNumber: "ORD-DRAFT",
      lineItems: [
        {
          id: "li-1",
          orderId: "ord-1",
          productId: "prod-1",
          qty: 3,
          unitPrice: 4.99,
          subtotal: 14.97,
          status: "PENDING",
          boxes: null,
          pieces: null,
          priceType: "STANDARD",
          originalPrice: null,
        },
      ],
    };

    it("edit preserves the stored fee: no dto.shippingFee keeps it in the total, and the update payload omits the key (the fee-wipe regression)", async () => {
      prisma.order.findUnique.mockResolvedValue({ ...draftOrder, shippingFee: 7 });
      prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 12, status: "PENDING" }]);

      await service.updateOrderItems(
        "ord-1",
        { items: [{ id: "li-1", action: "UPDATE", qty: 3, unitPrice: 4 }] },
        operatorPayload,
      );

      // 12 subtotal + 0 tax + 7 stored fee = 19.
      expect(prisma.order.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ total: 19 }) }),
      );
      const updateArg = prisma.order.update.mock.calls[0][0] as any;
      expect(updateArg.data).not.toHaveProperty("shippingFee");
    });

    it("OPERATOR (staff) can set the fee via dto.shippingFee — it lands on the update payload", async () => {
      prisma.order.findUnique.mockResolvedValue({ ...draftOrder, shippingFee: 0 });
      prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 12, status: "PENDING" }]);

      await service.updateOrderItems(
        "ord-1",
        {
          items: [{ id: "li-1", action: "UPDATE", qty: 3, unitPrice: 4 }],
          shippingFee: 3,
        } as any,
        operatorPayload,
      );

      // 12 + 0 tax + 3 staff-set fee = 15.
      expect(prisma.order.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ total: 15, shippingFee: 3 }) }),
      );
    });

    it("CUSTOMER dto.shippingFee is ignored — the stored fee is used and no shippingFee key is written", async () => {
      prisma.order.findUnique.mockResolvedValue({
        ...MOCK_ORDER,
        status: "PENDING",
        shippingFee: 7,
        lineItems: [],
      });
      prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
      prisma.product.findMany.mockResolvedValue([
        { id: "prod-plain", pricePerUnit: 3.5, unitsPerBox: null },
      ]);
      prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 17.5, status: "PENDING" }]);

      await service.updateOrderItems(
        "ord-1",
        { items: [{ productId: "prod-plain", qty: 5 }], shippingFee: 3 } as any,
        customerPayload,
      );

      // 17.5 + 0 tax + 7 stored fee (the buyer's dto.shippingFee: 3 is ignored) = 24.5.
      expect(prisma.order.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ total: 24.5 }) }),
      );
      const updateArg = prisma.order.update.mock.calls[0][0] as any;
      expect(updateArg.data).not.toHaveProperty("shippingFee");
    });
  });

  // ─── updateOrderItems — appliedCreditNotes (WP3) ─────────────────────────

  describe("updateOrderItems — appliedCreditNotes (WP3 — order-scoped credit-note application)", () => {
    it("OPERATOR (staff) selection syncs + settles against the order", async () => {
      prisma.order.findUnique.mockResolvedValue({
        ...MOCK_ORDER,
        status: "DRAFT" as const,
        lineItems: [
          {
            id: "li-1",
            orderId: "ord-1",
            productId: "prod-1",
            qty: 3,
            unitPrice: 4.99,
            subtotal: 14.97,
            status: "PENDING",
            boxes: null,
            pieces: null,
            priceType: "STANDARD",
            originalPrice: null,
          },
        ],
      });
      prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 14.97, status: "PENDING" }]);

      const selections = [{ creditNoteId: "cn-1", amount: 10 }];
      await service.updateOrderItems(
        "ord-1",
        {
          items: [{ id: "li-1", action: "UPDATE", qty: 3 }],
          appliedCreditNotes: selections,
        } as any,
        operatorPayload,
      );

      expect(creditNotesService.syncOrderCreditSelections).toHaveBeenCalledWith(
        expect.anything(),
        "ord-1",
        "cust-1",
        selections,
      );
      expect(creditNotesService.settleOrderCreditsInTx).toHaveBeenCalledWith(
        expect.anything(),
        "ord-1",
      );
    });

    it("non-staff (CUSTOMER) selection is ignored — sync is skipped, settle still runs", async () => {
      prisma.order.findUnique.mockResolvedValue({
        ...MOCK_ORDER,
        status: "PENDING",
        lineItems: [],
      });
      prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
      prisma.product.findMany.mockResolvedValue([
        { id: "prod-plain", pricePerUnit: 3.5, unitsPerBox: null },
      ]);
      prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 17.5, status: "PENDING" }]);

      await service.updateOrderItems(
        "ord-1",
        {
          items: [{ productId: "prod-plain", qty: 5 }],
          appliedCreditNotes: [{ creditNoteId: "cn-1" }],
        } as any,
        customerPayload,
      );

      // Drivers/customers can't manage credits — their selection is treated as
      // untouched (undefined), same gate as the shipping fee above.
      expect(creditNotesService.syncOrderCreditSelections).not.toHaveBeenCalled();
      // Settle still runs — a harmless idempotent re-settle even for a non-staff edit.
      expect(creditNotesService.settleOrderCreditsInTx).toHaveBeenCalledWith(
        expect.anything(),
        "ord-1",
      );
    });
  });

  // ─── updateOrderItems — incremental add vs replace-all ──────────────────────

  describe("updateOrderItems — incremental vs replace-all", () => {
    const orderWithItems = {
      ...MOCK_ORDER,
      status: "DRAFT" as const,
      lineItems: [
        {
          id: "li-A",
          orderId: "ord-1",
          productId: "prod-A",
          qty: 2,
          unitPrice: 5,
          subtotal: 10,
          status: "PENDING",
          boxes: null,
          pieces: null,
        },
      ],
    };

    it("replaceAll:false — adding an id-less item appends without deleting existing lines", async () => {
      prisma.order.findUnique.mockResolvedValue(orderWithItems);
      const prodB = { id: "prod-B", pricePerUnit: 7, unitsPerBox: null };
      prisma.product.findUnique.mockResolvedValue(prodB);
      prisma.product.findMany.mockResolvedValue([prodB]);
      prisma.orderItem.findMany.mockResolvedValue([
        { subtotal: 10, status: "PENDING" },
        { subtotal: 7, status: "PENDING" },
      ]);

      await service.updateOrderItems(
        "ord-1",
        { items: [{ productId: "prod-B", qty: 1 }], replaceAll: false },
        operatorPayload,
      );

      // The untouched existing line must survive — no wholesale delete.
      expect(prisma.orderItem.deleteMany).not.toHaveBeenCalled();
      expect(prisma.orderItem.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ productId: "prod-B", unitPrice: 7 }),
        }),
      );
    });

    // ─── B142: archived products reject NEW lines, not edits ─────────────────
    // cause-ruling.md §2/§3, D3: `addProductIds` (the NEW-line hook this describe
    // block already exercises above) is the one edge that separates a brand-new
    // line from a qty/price edit of one that already exists — reject only there.

    it("REG-B142-A a NEW line for an archived product is rejected (400)", async () => {
      prisma.order.findUnique.mockResolvedValue(orderWithItems);
      const archivedProduct = {
        id: "prod-archived",
        pricePerUnit: 9,
        unitsPerBox: null,
        isActive: false,
      };
      prisma.product.findUnique.mockResolvedValue(archivedProduct);
      prisma.product.findMany.mockResolvedValue([archivedProduct]);

      await expect(
        service.updateOrderItems(
          "ord-1",
          { items: [{ productId: "prod-archived", qty: 1 }], replaceAll: false },
          operatorPayload,
        ),
      ).rejects.toThrow(/archived/i);

      // No partial write — the rejected add must not have created anything.
      expect(prisma.orderItem.create).not.toHaveBeenCalled();
    });

    it("REG-B142-B qty edit of an existing archived line succeeds", async () => {
      // The line already exists on the order (li-A); only its qty is changing —
      // no new productId is being introduced, so `addProductIds` never includes
      // it and the archived flag on the underlying product must not block this.
      prisma.order.findUnique.mockResolvedValue(orderWithItems);
      prisma.product.findUnique.mockResolvedValue({
        id: "prod-A",
        pricePerUnit: 5,
        unitsPerBox: null,
        isActive: false,
      });
      prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 20, status: "PENDING" }]);

      await service.updateOrderItems(
        "ord-1",
        { items: [{ id: "li-A", qty: 4 }], replaceAll: false },
        operatorPayload,
      );

      expect(prisma.orderItem.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "li-A" } }),
      );
    });

    it("edit that adds a regulated line snapshots its category + flips hasRegulated", async () => {
      prisma.order.findUnique.mockResolvedValue(orderWithItems);
      const prodTob = {
        id: "prod-tob",
        pricePerUnit: 7,
        unitsPerBox: null,
        trackedCategoryId: "cat-tob",
        trackedSubcategoryId: "sub-cig", // RF-3: reporting breakdown snapshot
      };
      prisma.product.findUnique.mockResolvedValue(prodTob);
      prisma.product.findMany.mockResolvedValue([prodTob]);
      // Post-edit active items include the newly-added regulated line.
      prisma.orderItem.findMany.mockResolvedValue([
        { subtotal: 10, status: "PENDING", trackedCategoryId: null },
        { subtotal: 7, status: "PENDING", trackedCategoryId: "cat-tob" },
      ]);

      await service.updateOrderItems(
        "ord-1",
        { items: [{ productId: "prod-tob", qty: 1 }], replaceAll: false },
        operatorPayload,
      );

      // RF-3: the OrderItem row snapshots the subcategory alongside the category.
      expect(prisma.orderItem.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            productId: "prod-tob",
            trackedCategoryId: "cat-tob",
            trackedSubcategoryId: "sub-cig",
          }),
        }),
      );
      expect(prisma.order.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ hasRegulated: true }) }),
      );
    });

    it("customer replace path snapshots a regulated line's category", async () => {
      prisma.order.findUnique.mockResolvedValue({ ...orderWithItems, customerId: "cust-1" });
      prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
      prisma.product.findMany.mockResolvedValue([
        { id: "prod-tob", pricePerUnit: 7, unitsPerBox: null, trackedCategoryId: "cat-tob" },
      ]);
      prisma.orderItem.findMany.mockResolvedValue([
        { subtotal: 7, status: "PENDING", trackedCategoryId: "cat-tob" },
      ]);

      await service.updateOrderItems("ord-1", { items: [{ productId: "prod-tob", qty: 1 }] }, {
        ...customerPayload,
        sub: "user-cust",
      } as any);

      expect(prisma.orderItem.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ productId: "prod-tob", trackedCategoryId: "cat-tob" }),
        }),
      );
    });

    it("substituting to a regulated product re-snapshots the new category", async () => {
      prisma.order.findUnique.mockResolvedValue(orderWithItems);
      prisma.product.findUniqueOrThrow.mockResolvedValue({
        id: "prod-tob",
        pricePerUnit: 8,
        unitsPerBox: null,
        trackedCategoryId: "cat-tob",
      });
      prisma.orderItem.findMany.mockResolvedValue([
        { subtotal: 16, status: "PENDING", trackedCategoryId: "cat-tob" },
      ]);

      await service.updateOrderItems(
        "ord-1",
        { items: [{ id: "li-A", substituteProductId: "prod-tob", qty: 2 }], replaceAll: false },
        operatorPayload,
      );

      expect(prisma.orderItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            productId: "prod-tob",
            trackedCategoryId: "cat-tob",
          }),
        }),
      );
      expect(prisma.order.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ hasRegulated: true }) }),
      );
    });

    // ─── B3: staff override on substitution ────────────────────────────────
    // The substitute branch used to hardcode unitPrice = product.pricePerUnit
    // and never read item.unitPrice, silently discarding an operator's price
    // override (and the customer's tier) on every substitution. Fixed to honor
    // it for staff only, using the same net-unitPrice / originalPrice /
    // DISCOUNTED-vs-MANUAL convention as create()'s operator-override ladder.

    it("operator override below the substitute's list price bills boxes × override and stores DISCOUNTED", async () => {
      prisma.order.findUnique.mockResolvedValue(orderWithItems);
      prisma.product.findUniqueOrThrow.mockResolvedValue({
        id: "prod-tob",
        pricePerUnit: 30,
        unitsPerBox: 12,
      });
      prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 40, status: "PENDING" }]);

      await service.updateOrderItems(
        "ord-1",
        {
          items: [
            {
              id: "li-A",
              substituteProductId: "prod-tob",
              boxes: 2,
              pieces: 0,
              unitPrice: 20,
              overrideReason: "matched last invoice price",
            },
          ],
          replaceAll: false,
        },
        operatorPayload,
      );

      expect(prisma.orderItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "li-A" },
          data: expect.objectContaining({
            productId: "prod-tob",
            unitPrice: 20,
            qty: 24,
            boxes: 2,
            pieces: 0,
            // computeLineSubtotal: 20 * (2 boxes + 0/12) = 40 — NOT 20 * 24 = 480.
            subtotal: 40,
            priceType: "DISCOUNTED",
            originalPrice: 30,
            overrideReason: "matched last invoice price",
            overriddenBy: "user-op",
          }),
        }),
      );
    });

    it("operator override above the substitute's list price stores MANUAL (upsell)", async () => {
      prisma.order.findUnique.mockResolvedValue(orderWithItems);
      prisma.product.findUniqueOrThrow.mockResolvedValue({
        id: "prod-tob",
        pricePerUnit: 30,
        unitsPerBox: 12,
      });
      prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 35, status: "PENDING" }]);

      await service.updateOrderItems(
        "ord-1",
        {
          items: [
            { id: "li-A", substituteProductId: "prod-tob", boxes: 1, pieces: 0, unitPrice: 35 },
          ],
          replaceAll: false,
        },
        operatorPayload,
      );

      expect(prisma.orderItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            unitPrice: 35,
            qty: 12,
            subtotal: 35,
            priceType: "MANUAL",
            originalPrice: 30,
          }),
        }),
      );
    });

    it("an override equal to the substitute's list price is not treated as an override", async () => {
      prisma.order.findUnique.mockResolvedValue(orderWithItems);
      prisma.product.findUniqueOrThrow.mockResolvedValue({
        id: "prod-tob",
        pricePerUnit: 8,
        unitsPerBox: null,
      });
      prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 24, status: "PENDING" }]);

      await service.updateOrderItems(
        "ord-1",
        {
          items: [{ id: "li-A", substituteProductId: "prod-tob", qty: 3, unitPrice: 8 }],
          replaceAll: false,
        },
        operatorPayload,
      );

      expect(prisma.orderItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            unitPrice: 8,
            priceType: "STANDARD",
            originalPrice: null,
            overrideReason: null,
            overriddenBy: null,
          }),
        }),
      );
    });

    it("substitution without unitPrice keeps billing the substitute's list price (regression pin)", async () => {
      prisma.order.findUnique.mockResolvedValue(orderWithItems);
      prisma.product.findUniqueOrThrow.mockResolvedValue({
        id: "prod-tob",
        pricePerUnit: 8,
        unitsPerBox: null,
      });
      prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 24, status: "PENDING" }]);

      await service.updateOrderItems(
        "ord-1",
        { items: [{ id: "li-A", substituteProductId: "prod-tob", qty: 3 }], replaceAll: false },
        operatorPayload,
      );

      expect(prisma.orderItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "li-A" },
          data: expect.objectContaining({
            productId: "prod-tob",
            unitPrice: 8,
            subtotal: 24,
            priceType: "STANDARD",
            originalPrice: null,
            overrideReason: null,
            overriddenBy: null,
          }),
        }),
      );
    });

    // ─── B466: SPECIAL-tier lock on substitution ───────────────────────────
    // The substitute branch above never checked tier at all — a bare unitPrice
    // was compared only against the substitute's LIST price, so typing this
    // customer's correct SPECIAL price on a substitution was silently stored
    // as DISCOUNTED (B466). Same guard shape as B465's ADD/UPDATE branches,
    // reusing isSpecialTier() — but the baseline is the substitute's own tier
    // price, not list.

    it("(b466-1) revert-probe: a substitute price equal to the SPECIAL tier price needs no reason and stores SPECIAL, not DISCOUNTED", async () => {
      // Pre-fix, this branch compared only to list (10): unitPrice 8 !== 10 was
      // treated as a genuine override, storing priceType DISCOUNTED/originalPrice
      // 10 for a price that is in fact this customer's own correct contract
      // price. Fails red on the pre-fix tree (priceType comes back "DISCOUNTED").
      prisma.order.findUnique.mockResolvedValue(orderWithItems);
      prisma.customer.findFirst.mockResolvedValue({ pricingTier: 3 }); // operatorTierCtx read
      prisma.customerPrice.findMany.mockResolvedValue([]);
      prisma.product.findUniqueOrThrow.mockResolvedValue({
        id: "prod-tob",
        name: "Tiered Sub",
        pricePerUnit: 10,
        priceTier3: 8,
        unitsPerBox: null,
        trackedCategoryId: null,
        trackedSubcategoryId: null,
      });
      prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 16, status: "PENDING" }]);

      await service.updateOrderItems(
        "ord-1",
        {
          items: [{ id: "li-A", substituteProductId: "prod-tob", qty: 2, unitPrice: 8 }],
          replaceAll: false,
        },
        operatorPayload,
      );

      expect(prisma.orderItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            productId: "prod-tob",
            unitPrice: 8,
            subtotal: 16,
            priceType: "SPECIAL",
            originalPrice: 10,
            overrideReason: null,
            overriddenBy: null,
          }),
        }),
      );
    });

    it("(b466-2) revert-probe: a substitute price differing from the SPECIAL tier price with no reason is REFUSED (400), product-named", async () => {
      // Pre-fix, this branch had no tier awareness or reason gate at all — a
      // bare 5 against list 10 silently stored priceType DISCOUNTED with no
      // record anyone even tried to reprice a special line. Fails red pre-fix
      // (the call resolves 200 instead of rejecting).
      prisma.order.findUnique.mockResolvedValue(orderWithItems);
      prisma.customer.findFirst.mockResolvedValue({ pricingTier: 3 });
      prisma.customerPrice.findMany.mockResolvedValue([]);
      prisma.product.findUniqueOrThrow.mockResolvedValue({
        id: "prod-tob",
        name: "Tiered Sub",
        pricePerUnit: 10,
        priceTier3: 8,
        unitsPerBox: null,
        trackedCategoryId: null,
        trackedSubcategoryId: null,
      });

      await expect(
        service.updateOrderItems(
          "ord-1",
          {
            items: [{ id: "li-A", substituteProductId: "prod-tob", qty: 2, unitPrice: 5 }],
            replaceAll: false,
          },
          operatorPayload,
        ),
      ).rejects.toThrow(/Tiered Sub/);

      expect(prisma.orderItem.update).not.toHaveBeenCalled();
    });

    it("(b466-3) a documented override (price + reason) on a SPECIAL substitute is honored — stores DISCOUNTED with the reason recorded", async () => {
      prisma.order.findUnique.mockResolvedValue(orderWithItems);
      prisma.customer.findFirst.mockResolvedValue({ pricingTier: 3 });
      prisma.customerPrice.findMany.mockResolvedValue([]);
      prisma.product.findUniqueOrThrow.mockResolvedValue({
        id: "prod-tob",
        name: "Tiered Sub",
        pricePerUnit: 10,
        priceTier3: 8,
        unitsPerBox: null,
        trackedCategoryId: null,
        trackedSubcategoryId: null,
      });
      prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 10, status: "PENDING" }]);

      await service.updateOrderItems(
        "ord-1",
        {
          items: [
            {
              id: "li-A",
              substituteProductId: "prod-tob",
              qty: 2,
              unitPrice: 5,
              overrideReason: "matched approval",
            },
          ],
          replaceAll: false,
        },
        operatorPayload,
      );

      expect(prisma.orderItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            unitPrice: 5,
            subtotal: 10,
            priceType: "DISCOUNTED",
            originalPrice: 10,
            overrideReason: "matched approval",
            overriddenBy: "user-op",
          }),
        }),
      );
    });

    it("(b466-3b) Opus MERGE-verdict fix: a documented override rounds to cents (8.004 -> 8.00)", async () => {
      // Non-special (tier 1, no customer/CustomerPrice mock) so the override is
      // unambiguously honored — 8.004 is well outside the 0.005 unchanged-from-
      // tier tolerance here (baseline = list = 10), isolating the roundMoney fix.
      prisma.order.findUnique.mockResolvedValue(orderWithItems);
      prisma.product.findUniqueOrThrow.mockResolvedValue({
        id: "prod-tob",
        name: "Tiered Sub",
        pricePerUnit: 10,
        unitsPerBox: null,
      });
      prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 8, status: "PENDING" }]);

      await service.updateOrderItems(
        "ord-1",
        {
          items: [
            {
              id: "li-A",
              substituteProductId: "prod-tob",
              qty: 1,
              unitPrice: 8.004,
              overrideReason: "matched approval",
            },
          ],
          replaceAll: false,
        },
        operatorPayload,
      );

      expect(prisma.orderItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            unitPrice: 8,
            priceType: "DISCOUNTED",
            originalPrice: 10,
          }),
        }),
      );
    });

    it("(b466-4) revert-probe: a substitute to a SPECIAL-tier product with no unitPrice at all bills the tier price, SPECIAL", async () => {
      // Pre-fix `let unitPrice = listPrice` unconditionally — a substitution
      // with no price at all always billed list (10/STANDARD/null) regardless
      // of tier. Fails red pre-fix (unitPrice/priceType/originalPrice all wrong).
      prisma.order.findUnique.mockResolvedValue(orderWithItems);
      prisma.customer.findFirst.mockResolvedValue({ pricingTier: 3 });
      prisma.customerPrice.findMany.mockResolvedValue([]);
      prisma.product.findUniqueOrThrow.mockResolvedValue({
        id: "prod-tob",
        name: "Tiered Sub",
        pricePerUnit: 10,
        priceTier3: 8,
        unitsPerBox: null,
        trackedCategoryId: null,
        trackedSubcategoryId: null,
      });
      prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 16, status: "PENDING" }]);

      await service.updateOrderItems(
        "ord-1",
        { items: [{ id: "li-A", substituteProductId: "prod-tob", qty: 2 }], replaceAll: false },
        operatorPayload,
      );

      expect(prisma.orderItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            unitPrice: 8,
            subtotal: 16,
            priceType: "SPECIAL",
            originalPrice: 10,
            overrideReason: null,
            overriddenBy: null,
          }),
        }),
      );
    });

    it("(b466-5) revert-probe: a per-product CustomerPrice row on the SUBSTITUTE product wins over the customer's default tier", async () => {
      // Pre-fix, operatorProductIds never collected substituteProductId at all
      // (li-A's OWN pre-substitution product is "prod-A", not "prod-tob"), so
      // operatorCpMap.get("prod-tob") was always undefined and this fell back
      // to the customer's DEFAULT tier (1/STANDARD here) — no reason demanded,
      // no throw. Fails red pre-fix (resolves 200 instead of rejecting).
      prisma.order.findUnique.mockResolvedValue(orderWithItems);
      prisma.customer.findFirst.mockResolvedValue({ pricingTier: 1 }); // customer DEFAULT is STANDARD
      prisma.customerPrice.findMany.mockResolvedValue([{ productId: "prod-tob", pricingTier: 3 }]);
      prisma.product.findUniqueOrThrow.mockResolvedValue({
        id: "prod-tob",
        name: "Tiered Sub",
        pricePerUnit: 10,
        priceTier3: 8,
        unitsPerBox: null,
        trackedCategoryId: null,
        trackedSubcategoryId: null,
      });

      await expect(
        service.updateOrderItems(
          "ord-1",
          {
            items: [{ id: "li-A", substituteProductId: "prod-tob", qty: 2, unitPrice: 10 }],
            replaceAll: false,
          },
          operatorPayload,
        ),
      ).rejects.toThrow(/Tiered Sub/);

      expect(prisma.orderItem.update).not.toHaveBeenCalled();
      expect(prisma.customerPrice.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            productId: expect.objectContaining({ in: expect.arrayContaining(["prod-tob"]) }),
          }),
        }),
      );
    });

    it("a driver's substitution attempt bills at the substitute's list price — override never reaches this line", async () => {
      // A DRIVER never reaches the staff-only substituteProductId branch above —
      // role routes to the always-replace buyer/driver path (top of this
      // transaction), which already re-prices server-side regardless of any
      // client-sent unitPrice. This pins that a driver can't gain price control
      // via a substitution-shaped edit either — B13, non-staff never set prices.
      prisma.order.findUnique.mockResolvedValue(orderWithItems);
      prisma.product.findMany.mockResolvedValue([
        { id: "prod-tob", pricePerUnit: 8, unitsPerBox: null },
      ]);
      prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 24, status: "PENDING" }]);

      const driverPayload = { ...operatorPayload, sub: "user-drv", role: "DRIVER" as const };

      await service.updateOrderItems(
        "ord-1",
        { items: [{ productId: "prod-tob", qty: 3, unitPrice: 5 }] },
        driverPayload,
      );

      expect(prisma.orderItem.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            productId: "prod-tob",
            unitPrice: 8,
            priceType: "STANDARD",
          }),
        }),
      );
    });

    // ─── B2: the incoming split is denominated in the REPLACED product's box ───
    // Clients now send boxes/pieces on substitution, but that split is sized to
    // the line's OLD case. The branch must re-resolve it against the substitute.

    it("a boxed line substituted onto a loose product bills the piece qty, not a zeroed split", async () => {
      prisma.order.findUnique.mockResolvedValue(orderWithItems);
      prisma.product.findUniqueOrThrow.mockResolvedValue({
        id: "prod-loose",
        pricePerUnit: 2,
        unitsPerBox: null,
      });
      prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 96, status: "PENDING" }]);

      await service.updateOrderItems(
        "ord-1",
        {
          items: [
            // 2 cases of a 24-pack = 48 pieces, swapped onto a single-unit product.
            { id: "li-A", substituteProductId: "prod-loose", qty: 48, boxes: 2, pieces: 0 },
          ],
          replaceAll: false,
        },
        operatorPayload,
      );

      expect(prisma.orderItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "li-A" },
          data: expect.objectContaining({
            productId: "prod-loose",
            // 2 * (unitsPerBox ?? 0) would have been qty 0 / subtotal 0 — a free line.
            qty: 48,
            boxes: null,
            pieces: null,
            unitsPerBox: null,
            subtotal: 96,
          }),
        }),
      );
    });

    it("a split sized to another case is normalized against the substitute's unitsPerBox", async () => {
      prisma.order.findUnique.mockResolvedValue(orderWithItems);
      prisma.product.findUniqueOrThrow.mockResolvedValue({
        id: "prod-4pack",
        pricePerUnit: 10,
        unitsPerBox: 4,
      });
      prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 25, status: "PENDING" }]);

      await service.updateOrderItems(
        "ord-1",
        {
          items: [{ id: "li-A", substituteProductId: "prod-4pack", boxes: 1, pieces: 6 }],
          replaceAll: false,
        },
        operatorPayload,
      );

      expect(prisma.orderItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            // 1*4 + 6 = 10 pieces → 2 boxes + 2 pieces, never pieces >= unitsPerBox.
            qty: 10,
            boxes: 2,
            pieces: 2,
            unitsPerBox: 4,
            subtotal: 25,
          }),
        }),
      );
    });

    it("a substitution resolving to qty 0 is skipped, not written as a free line", async () => {
      prisma.order.findUnique.mockResolvedValue(orderWithItems);
      prisma.product.findUniqueOrThrow.mockResolvedValue({
        id: "prod-tob",
        pricePerUnit: 30,
        unitsPerBox: 12,
      });
      prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 10, status: "PENDING" }]);

      await service.updateOrderItems(
        "ord-1",
        {
          items: [{ id: "li-A", substituteProductId: "prod-tob", boxes: 0, pieces: 0 }],
          replaceAll: false,
        },
        operatorPayload,
      );

      expect(prisma.orderItem.update).not.toHaveBeenCalled();
    });

    // F30/R10 (B198): the legacy shape-inference heuristic ("every item lacks an
    // id" ⇒ replace all) is GONE — it wiped an order on any id-less "just add
    // these" PATCH that omitted the flag, which is the real mobile per-scan
    // shape. An omitted flag now means the SAFE branch. (The dedicated
    // regression lives in orders.scan-hardening.spec.ts as T-B198; this keeps
    // the contract pinned in the suite that owns replace-vs-incremental.)
    it("replaceAll OMITTED — an all-id-less payload appends, it does not replace all", async () => {
      prisma.order.findUnique.mockResolvedValue(orderWithItems);
      const prodB = { id: "prod-B", pricePerUnit: 7, unitsPerBox: null };
      prisma.product.findUnique.mockResolvedValue(prodB);
      prisma.product.findMany.mockResolvedValue([prodB]);
      prisma.orderItem.findMany.mockResolvedValue([
        { subtotal: 10, status: "PENDING" },
        { subtotal: 7, status: "PENDING" },
      ]);

      await service.updateOrderItems(
        "ord-1",
        { items: [{ productId: "prod-B", qty: 1 }] },
        operatorPayload,
      );

      expect(prisma.orderItem.deleteMany).not.toHaveBeenCalled();
      expect(prisma.orderItem.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ productId: "prod-B", unitPrice: 7 }),
        }),
      );
    });

    it("appends a new unlisted line (no productId) as a MANUAL item, without deleting", async () => {
      prisma.order.findUnique.mockResolvedValue(orderWithItems);
      prisma.orderItem.findMany.mockResolvedValue([
        { subtotal: 10, status: "PENDING" },
        { subtotal: 15, status: "PENDING" },
      ]);

      await service.updateOrderItems(
        "ord-1",
        { items: [{ name: "Custom crate", qty: 3, unitPrice: 5 }], replaceAll: false },
        operatorPayload,
      );

      expect(prisma.orderItem.deleteMany).not.toHaveBeenCalled();
      expect(prisma.orderItem.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            productId: null,
            name: "Custom crate",
            unitPrice: 5,
            subtotal: 15,
            priceType: "MANUAL",
          }),
        }),
      );
    });

    it("action DELETE hard-removes a clean (un-invoiced, undelivered) line", async () => {
      prisma.order.findUnique.mockResolvedValue(orderWithItems);
      prisma.deliveryMutation.count.mockResolvedValue(0);
      prisma.orderItem.findMany.mockResolvedValue([]);

      await service.updateOrderItems(
        "ord-1",
        { items: [{ id: "li-A", action: "DELETE" }], replaceAll: false },
        operatorPayload,
      );

      expect(prisma.orderItem.delete).toHaveBeenCalledWith({ where: { id: "li-A" } });
    });

    it("action DELETE falls back to strike-off when the line was already invoiced", async () => {
      const billed = {
        ...orderWithItems,
        lineItems: [{ ...orderWithItems.lineItems[0], invoicedQty: 2 }],
      };
      prisma.order.findUnique.mockResolvedValue(billed);
      prisma.deliveryMutation.count.mockResolvedValue(0);
      prisma.orderItem.findMany.mockResolvedValue([]);

      await service.updateOrderItems(
        "ord-1",
        { items: [{ id: "li-A", action: "DELETE" }], replaceAll: false },
        operatorPayload,
      );

      expect(prisma.orderItem.delete).not.toHaveBeenCalled();
      expect(prisma.orderItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "li-A" },
          data: expect.objectContaining({ status: "CANCELLED" }),
        }),
      );
    });
  });

  // ─── updateOrderItems — operator/admin tier pricing (WP1) ───────────────────
  // The operator/admin branch used to price every new/replaced line at flat
  // `product.pricePerUnit`, ignoring the customer's tier entirely (create() and
  // the buyer-edit branch of this same function already resolved it). Both
  // sub-branches — replace-all and the individual-item "new line" case — now
  // load Customer.pricingTier + CustomerPrice once per call and resolve an
  // un-priced (or list-price-equal) line through resolveBuyerLinePrice, the
  // same helper create() uses. A genuinely different explicit price is still a
  // MANUAL override — tier resolution never overrides operator intent.

  describe("updateOrderItems — operator/admin tier pricing (WP1)", () => {
    const TIERED_PRODUCT = {
      id: "prod-1",
      name: "Tiered Widget",
      pricePerUnit: 10,
      priceTier3: 8,
      unitsPerBox: null,
      category: null,
      trackedCategoryId: null,
    };

    it("(a) operator adds a line for a tier-3 customer with no explicit price — tier-3 price, SPECIAL", async () => {
      prisma.order.findUnique.mockResolvedValue({
        ...MOCK_ORDER,
        status: "DRAFT" as const,
        lineItems: [],
      });
      prisma.customer.findFirst.mockResolvedValue({ pricingTier: 3 }); // operatorTierCtx read
      prisma.customerPrice.findMany.mockResolvedValue([]);
      prisma.product.findUnique.mockResolvedValue(TIERED_PRODUCT);
      prisma.product.findMany.mockResolvedValue([TIERED_PRODUCT]);
      prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 16, status: "PENDING" }]);

      await service.updateOrderItems(
        "ord-1",
        { items: [{ productId: "prod-1", qty: 2 }], replaceAll: false },
        operatorPayload,
      );

      expect(prisma.orderItem.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            productId: "prod-1",
            unitPrice: 8,
            originalPrice: 10,
            priceType: "SPECIAL",
            subtotal: 16,
          }),
        }),
      );
    });

    it("(b) operator supplies an explicit different price on a new line — that price, MANUAL (not tier-resolved)", async () => {
      prisma.order.findUnique.mockResolvedValue({
        ...MOCK_ORDER,
        status: "DRAFT" as const,
        lineItems: [],
      });
      prisma.customer.findUnique.mockResolvedValue({ pricingTier: 3 });
      prisma.customerPrice.findMany.mockResolvedValue([]);
      prisma.product.findUnique.mockResolvedValue(TIERED_PRODUCT);
      prisma.product.findMany.mockResolvedValue([TIERED_PRODUCT]);
      prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 12, status: "PENDING" }]);

      await service.updateOrderItems(
        "ord-1",
        {
          items: [{ productId: "prod-1", qty: 2, unitPrice: 6, overrideReason: "loyalty" }],
          replaceAll: false,
        },
        operatorPayload,
      );

      expect(prisma.orderItem.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            productId: "prod-1",
            unitPrice: 6,
            originalPrice: 10,
            priceType: "MANUAL",
            overrideReason: "loyalty",
            overriddenBy: "user-op",
            subtotal: 12,
          }),
        }),
      );
    });

    it("(c) an msrp-only CustomerPrice row ({pricingTier: null}) still prices a new line at the customer's default tier", async () => {
      // MSRP made CustomerPrice.pricingTier nullable: a row may carry ONLY an
      // MSRP override. That row must be pricing-inert — the customer's default
      // tier keeps winning here too, mirroring create()'s same fallback.
      prisma.order.findUnique.mockResolvedValue({
        ...MOCK_ORDER,
        status: "DRAFT" as const,
        lineItems: [],
      });
      prisma.customer.findFirst.mockResolvedValue({ pricingTier: 3 }); // operatorTierCtx read; default tier 3 → tier price 8
      prisma.customerPrice.findMany.mockResolvedValue([
        { productId: "prod-1", pricingTier: null, msrp: 5 },
      ]);
      prisma.product.findUnique.mockResolvedValue(TIERED_PRODUCT);
      prisma.product.findMany.mockResolvedValue([TIERED_PRODUCT]);
      prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 16, status: "PENDING" }]);

      await service.updateOrderItems(
        "ord-1",
        { items: [{ productId: "prod-1", qty: 2 }], replaceAll: false },
        operatorPayload,
      );

      expect(prisma.orderItem.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            productId: "prod-1",
            unitPrice: 8,
            originalPrice: 10,
            priceType: "SPECIAL",
            subtotal: 16,
          }),
        }),
      );
    });

    it("(d) buyer-edit branch still resolves a new line through the customer's tier (regression pin, unchanged by WP1)", async () => {
      prisma.order.findUnique.mockResolvedValue({
        ...MOCK_ORDER,
        status: "DRAFT" as const,
        customerId: "cust-1",
        lineItems: [],
      });
      // customer.findFirst now serves BOTH the buyer ownership check (where.userId)
      // and the buyerTierCtx pricingTier read (where.id).
      prisma.customer.findFirst.mockImplementation(({ where }: any) =>
        Promise.resolve(where?.id ? { pricingTier: 3 } : { id: "cust-1" }),
      );
      prisma.customerPrice.findMany.mockResolvedValue([]);
      prisma.product.findMany.mockResolvedValue([TIERED_PRODUCT]);
      prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 16, status: "PENDING" }]);

      await service.updateOrderItems("ord-1", { items: [{ productId: "prod-1", qty: 2 }] }, {
        ...customerPayload,
        sub: "user-cust",
      } as any);

      expect(prisma.orderItem.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            productId: "prod-1",
            unitPrice: 8,
            originalPrice: 10,
            priceType: "SPECIAL",
            subtotal: 16,
          }),
        }),
      );
    });

    it("(e) B465 fix-round-2: a bare price on a SPECIAL-tier ADD with no reason is REFUSED (400), never silently dropped", async () => {
      // Round-1 (bcdeedda) silently fell through to the tier price here —
      // Opus BLOCK: that 200's caller has no idea their price change never
      // took effect. Reverses the old WP1 "sell at list for one order"
      // allowance for a SPECIAL-tier line (mobile hunt R2/R9, closed on the
      // owner's ruling 2026-09-16) by refusing outright instead.
      prisma.order.findUnique.mockResolvedValue({
        ...MOCK_ORDER,
        status: "DRAFT" as const,
        lineItems: [],
      });
      prisma.customer.findFirst.mockResolvedValue({ pricingTier: 3 }); // operatorTierCtx read
      prisma.customerPrice.findMany.mockResolvedValue([]);
      prisma.product.findMany.mockResolvedValue([TIERED_PRODUCT]);

      await expect(
        service.updateOrderItems(
          "ord-1",
          { items: [{ productId: "prod-1", qty: 2, unitPrice: 10 }], replaceAll: false },
          operatorPayload,
        ),
        // Item 4 (LOW): the 400 names the product, not a generic "a line".
      ).rejects.toThrow(/Tiered Widget/);

      expect(prisma.orderItem.create).not.toHaveBeenCalled();
    });

    it("(e2) B465: a SPECIAL-tier ADD with NO price at all still resolves the tier price silently (unaffected — no reprice attempt to refuse)", async () => {
      prisma.order.findUnique.mockResolvedValue({
        ...MOCK_ORDER,
        status: "DRAFT" as const,
        lineItems: [],
      });
      prisma.customer.findFirst.mockResolvedValue({ pricingTier: 3 });
      prisma.customerPrice.findMany.mockResolvedValue([]);
      prisma.product.findMany.mockResolvedValue([TIERED_PRODUCT]);
      prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 16, status: "PENDING" }]);

      await service.updateOrderItems(
        "ord-1",
        { items: [{ productId: "prod-1", qty: 2 }], replaceAll: false },
        operatorPayload,
      );

      expect(prisma.orderItem.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            productId: "prod-1",
            unitPrice: 8,
            originalPrice: 10,
            priceType: "SPECIAL",
            subtotal: 16,
          }),
        }),
      );
    });

    it("(f) B465: a documented override (price + reason) on a SPECIAL-tier ADD still works", async () => {
      prisma.order.findUnique.mockResolvedValue({
        ...MOCK_ORDER,
        status: "DRAFT" as const,
        lineItems: [],
      });
      prisma.customer.findFirst.mockResolvedValue({ pricingTier: 3 });
      prisma.customerPrice.findMany.mockResolvedValue([]);
      prisma.product.findMany.mockResolvedValue([TIERED_PRODUCT]);
      prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 12, status: "PENDING" }]);

      await service.updateOrderItems(
        "ord-1",
        {
          items: [
            { productId: "prod-1", qty: 2, unitPrice: 6, overrideReason: "manager approved" },
          ],
          replaceAll: false,
        },
        operatorPayload,
      );

      expect(prisma.orderItem.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            productId: "prod-1",
            unitPrice: 6,
            originalPrice: 10,
            priceType: "MANUAL",
            overrideReason: "manager approved",
            overriddenBy: "user-op",
            subtotal: 12,
          }),
        }),
      );
    });

    it("(g) B465 fix-round-2: a plain edit of an EXISTING SPECIAL line with no reason is REFUSED (400), never silently downgraded or dropped", async () => {
      // The UPDATE-path twin of (e) — R9's "edit path" finding. A line already
      // priced at this tier-3 customer's SPECIAL rate ($8, catalog $10) gets a
      // plain qty/price touch that happens to type the catalog price back in,
      // with no reason anywhere (payload or stored). Round-1 (bcdeedda) left
      // the line's price untouched and returned 200 — Opus BLOCK: refuse
      // instead so the caller learns their price change never took effect.
      prisma.order.findUnique.mockResolvedValue({
        ...MOCK_ORDER,
        status: "DRAFT" as const,
        lineItems: [
          {
            id: "li-1",
            orderId: "ord-1",
            productId: "prod-1",
            qty: 3,
            unitPrice: 8,
            subtotal: 24,
            status: "PENDING",
            boxes: null,
            pieces: null,
            priceType: "SPECIAL",
            originalPrice: 10,
          },
        ],
      });
      prisma.customer.findFirst.mockResolvedValue({ pricingTier: 3 });
      prisma.customerPrice.findMany.mockResolvedValue([]);
      // Item 4 (LOW): the 400 names the product — fetched fresh in the throw
      // path since this branch has no product row in scope otherwise.
      prisma.product.findFirst.mockResolvedValue({ name: "Tiered Widget" });

      await expect(
        service.updateOrderItems(
          "ord-1",
          { items: [{ id: "li-1", action: "UPDATE", qty: 3, unitPrice: 10 }], replaceAll: false },
          operatorPayload,
        ),
      ).rejects.toThrow(/Tiered Widget/);

      expect(prisma.orderItem.update).not.toHaveBeenCalled();
    });

    it("(g2) B465: a price change on a SPECIAL line falls back to the LINE's stored reason when the payload omits one (client re-saving under its existing reason)", async () => {
      prisma.order.findUnique.mockResolvedValue({
        ...MOCK_ORDER,
        status: "DRAFT" as const,
        lineItems: [
          {
            id: "li-1",
            orderId: "ord-1",
            productId: "prod-1",
            qty: 3,
            unitPrice: 8,
            subtotal: 24,
            status: "PENDING",
            boxes: null,
            pieces: null,
            priceType: "SPECIAL",
            originalPrice: 10,
            overrideReason: "manager approved", // already on record from a prior edit
          },
        ],
      });
      prisma.customer.findFirst.mockResolvedValue({ pricingTier: 3 });
      prisma.customerPrice.findMany.mockResolvedValue([]);
      prisma.product.findFirst.mockResolvedValue({ pricePerUnit: 10 }); // catalog anchor read
      prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 36, status: "PENDING" }]);

      await service.updateOrderItems(
        "ord-1",
        // No overrideReason in THIS payload — the line already has one on file.
        { items: [{ id: "li-1", action: "UPDATE", qty: 3, unitPrice: 12 }], replaceAll: false },
        operatorPayload,
      );

      expect(prisma.orderItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "li-1" },
          data: expect.objectContaining({ unitPrice: 12, subtotal: 36, priceType: "MANUAL" }),
        }),
      );
    });

    it("(item1) B465 fix-round-2: an id-only UPDATE resolves tier via the LINE's OWN product, not just the customer's default tier — a per-product SPECIAL row still needs a reason", async () => {
      // Web/mobile send {id, action:'UPDATE', qty, unitPrice} with NO productId
      // of their own for an existing-line edit. Round-1 (bcdeedda)'s
      // operatorProductIds only covered productIds present in the PAYLOAD, so
      // this line's per-product CustomerPrice override was never fetched and
      // the tier silently fell back to the customer's DEFAULT tier (1,
      // STANDARD here) — missing that THIS product is SPECIAL for them.
      prisma.order.findUnique.mockResolvedValue({
        ...MOCK_ORDER,
        status: "DRAFT" as const,
        lineItems: [
          {
            id: "li-1",
            orderId: "ord-1",
            productId: "prod-1",
            qty: 3,
            unitPrice: 8,
            subtotal: 24,
            status: "PENDING",
            boxes: null,
            pieces: null,
            priceType: "SPECIAL",
            originalPrice: 10,
          },
        ],
      });
      prisma.customer.findFirst.mockResolvedValue({ pricingTier: 1 }); // customer's DEFAULT tier is STANDARD
      prisma.customerPrice.findMany.mockResolvedValue([
        { productId: "prod-1", pricingTier: 3 }, // but THIS product is SPECIAL for them
      ]);

      await expect(
        service.updateOrderItems(
          "ord-1",
          { items: [{ id: "li-1", action: "UPDATE", qty: 3, unitPrice: 10 }], replaceAll: false },
          operatorPayload,
        ),
      ).rejects.toThrow(BadRequestException);

      expect(prisma.orderItem.update).not.toHaveBeenCalled();
    });

    it("(item1b) B465 fix-round-2: a per-product STANDARD CustomerPrice row wins over the customer's SPECIAL default tier — a plain price edit is allowed with no reason", async () => {
      prisma.order.findUnique.mockResolvedValue({
        ...MOCK_ORDER,
        status: "DRAFT" as const,
        lineItems: [
          {
            id: "li-1",
            orderId: "ord-1",
            productId: "prod-1",
            qty: 3,
            unitPrice: 10,
            subtotal: 30,
            status: "PENDING",
            boxes: null,
            pieces: null,
            priceType: "STANDARD",
            originalPrice: null,
          },
        ],
      });
      prisma.customer.findFirst.mockResolvedValue({ pricingTier: 3 }); // customer's DEFAULT tier is SPECIAL
      prisma.customerPrice.findMany.mockResolvedValue([
        { productId: "prod-1", pricingTier: 1 }, // but THIS product is explicitly STANDARD for them
      ]);
      prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 33, status: "PENDING" }]);

      await service.updateOrderItems(
        "ord-1",
        { items: [{ id: "li-1", action: "UPDATE", qty: 3, unitPrice: 11 }], replaceAll: false },
        operatorPayload,
      );

      expect(prisma.orderItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "li-1" },
          data: expect.objectContaining({ unitPrice: 11, subtotal: 33 }),
        }),
      );
    });

    it("(item3) B465 fix-round-2 (Opus BLOCK, MED): the replace-all branch applies the SAME reason-required guard for a SPECIAL-tier line", async () => {
      prisma.order.findUnique.mockResolvedValue({
        ...MOCK_ORDER,
        status: "DRAFT" as const,
        lineItems: [],
      });
      prisma.customer.findFirst.mockResolvedValue({ pricingTier: 3 });
      prisma.customerPrice.findMany.mockResolvedValue([]);
      prisma.product.findMany.mockResolvedValue([TIERED_PRODUCT]);

      await expect(
        service.updateOrderItems(
          "ord-1",
          { items: [{ productId: "prod-1", qty: 2, unitPrice: 10 }], replaceAll: true },
          operatorPayload,
        ),
      ).rejects.toThrow(BadRequestException);

      expect(prisma.orderItem.create).not.toHaveBeenCalled();
    });

    it("(item3b) B465: the replace-all branch honors a documented override (price + reason) on a SPECIAL-tier line", async () => {
      prisma.order.findUnique.mockResolvedValue({
        ...MOCK_ORDER,
        status: "DRAFT" as const,
        lineItems: [],
      });
      prisma.customer.findFirst.mockResolvedValue({ pricingTier: 3 });
      prisma.customerPrice.findMany.mockResolvedValue([]);
      prisma.product.findMany.mockResolvedValue([TIERED_PRODUCT]);
      prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 12, status: "PENDING" }]);

      await service.updateOrderItems(
        "ord-1",
        {
          items: [
            { productId: "prod-1", qty: 2, unitPrice: 6, overrideReason: "manager approved" },
          ],
          replaceAll: true,
        },
        operatorPayload,
      );

      expect(prisma.orderItem.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            productId: "prod-1",
            unitPrice: 6,
            priceType: "MANUAL",
            overrideReason: "manager approved",
            subtotal: 12,
          }),
        }),
      );
    });

    it("(item3c) B465 fix round 3 (Opus BLOCK item 2, revert-probe): replace-all echoing an existing SPECIAL line's OWN stored price needs no reason", async () => {
      // Round-2's replace-all guard checked only whether a price was present,
      // never whether it matched what this product's ONE unambiguous pre-edit
      // line already had — an echoed (unchanged) price tripped the same 400
      // as a genuine reprice.
      prisma.order.findUnique.mockResolvedValue({
        ...MOCK_ORDER,
        status: "DRAFT" as const,
        lineItems: [
          {
            id: "li-1",
            orderId: "ord-1",
            productId: "prod-1",
            qty: 2,
            unitPrice: 8,
            subtotal: 16,
            status: "PENDING",
            boxes: null,
            pieces: null,
            priceType: "SPECIAL",
            originalPrice: 10,
          },
        ],
      });
      prisma.customer.findFirst.mockResolvedValue({ pricingTier: 3 });
      prisma.customerPrice.findMany.mockResolvedValue([]);
      prisma.product.findMany.mockResolvedValue([TIERED_PRODUCT]);
      prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 24, status: "PENDING" }]);

      await service.updateOrderItems(
        "ord-1",
        // qty 2 -> 3, price echoed at its own stored value (8) — not a reprice.
        { items: [{ productId: "prod-1", qty: 3, unitPrice: 8 }], replaceAll: true },
        operatorPayload,
      );

      expect(prisma.orderItem.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            productId: "prod-1",
            qty: 3,
            unitPrice: 8,
            subtotal: 24,
          }),
        }),
      );
    });

    it("(item3d) B465 fix round 3 (Opus BLOCK item 2, merge test): auto-merge into an order with an existing reason-less MANUAL line on a SPECIAL-tier product gives 200, price unchanged", async () => {
      // The staff auto-merge (orders.controller.ts's create-time consolidation
      // via foldMergeItems) can fold in a line whose MANUAL override predates
      // this fix and was saved with no reason at all — merging it back in at
      // the SAME price must never retroactively demand one. This customer's
      // default tier IS SPECIAL (3) for this product (tier price $8), but the
      // line itself carries an even-lower MANUAL override ($6, no reason) —
      // exactly the "reason-less MANUAL line" the review named.
      prisma.order.findUnique.mockResolvedValue({
        ...MOCK_ORDER,
        status: "DRAFT" as const,
        lineItems: [
          {
            id: "li-1",
            orderId: "ord-1",
            productId: "prod-1",
            qty: 2,
            unitPrice: 6,
            subtotal: 12,
            status: "PENDING",
            boxes: null,
            pieces: null,
            priceType: "MANUAL",
            originalPrice: 10,
            overrideReason: null,
          },
        ],
      });
      prisma.customer.findFirst.mockResolvedValue({ pricingTier: 3 });
      prisma.customerPrice.findMany.mockResolvedValue([]);
      prisma.product.findMany.mockResolvedValue([TIERED_PRODUCT]);
      prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 12, status: "PENDING" }]);

      // foldMergeItems' own output shape for a surviving MANUAL line: unitPrice
      // carried through, no overrideReason (never fabricated for a reason-less
      // stored line — see merge-items.spec.ts REG-B465-MERGE-1/2).
      await service.updateOrderItems(
        "ord-1",
        { items: [{ productId: "prod-1", qty: 2, unitPrice: 6 }], replaceAll: true },
        operatorPayload,
      );

      expect(prisma.orderItem.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            productId: "prod-1",
            qty: 2,
            unitPrice: 6,
            subtotal: 12,
          }),
        }),
      );
    });

    it("(r4-1) B465 fix round 4 (Opus BLOCK item 1, HIGH, revert-probe): the staff create-merge's own auto-merge (isCreateMerge) lets a NEW line for a SPECIAL customer through with no reason, storing the sent price", async () => {
      // Separate create (POST /orders with no existing PENDING order to merge
      // into) has no reason requirement in this PR (the B465 follow-up covers
      // it). The auto-merge branch of that SAME create endpoint folds a fresh
      // scan into an EXISTING order via replaceAll:true — a line brand-new to
      // that order (no existing counterpart at all) must be treated identically
      // to separate create, not like an operator's own edit of an existing
      // order. orders.controller.ts's create-merge call site is the ONLY
      // caller that ever sets opts.isCreateMerge; a plain replaceAll:true from
      // the edit screen never does, per test (item3)/(item3b) above.
      prisma.order.findUnique.mockResolvedValue({
        ...MOCK_ORDER,
        status: "DRAFT" as const,
        lineItems: [],
      });
      prisma.customer.findFirst.mockResolvedValue({ pricingTier: 3 });
      prisma.customerPrice.findMany.mockResolvedValue([]);
      prisma.product.findMany.mockResolvedValue([TIERED_PRODUCT]);
      prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 12, status: "PENDING" }]);

      await service.updateOrderItems(
        "ord-1",
        // A discounted price with NO reason -- would 400 on a plain edit-screen
        // replaceAll (see (item3)), but this is the create path's own merge.
        { items: [{ productId: "prod-1", qty: 2, unitPrice: 6 }], replaceAll: true },
        operatorPayload,
        { isCreateMerge: true },
      );

      expect(prisma.orderItem.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            productId: "prod-1",
            qty: 2,
            unitPrice: 6,
            subtotal: 12,
          }),
        }),
      );
    });

    it("(r4-2) B465 fix round 4 (Opus BLOCK item 1): isCreateMerge does NOT exempt an EXISTING line's genuine reprice — only a line brand-new to the order", async () => {
      // The flag must be scoped to replaceAllExisting == null, never a
      // blanket bypass for the whole create-merge call — an existing SPECIAL
      // line being folded back in at a DIFFERENT price still needs a reason.
      prisma.order.findUnique.mockResolvedValue({
        ...MOCK_ORDER,
        status: "DRAFT" as const,
        lineItems: [
          {
            id: "li-1",
            orderId: "ord-1",
            productId: "prod-1",
            qty: 2,
            unitPrice: 8,
            subtotal: 16,
            status: "PENDING",
            boxes: null,
            pieces: null,
            priceType: "SPECIAL",
            originalPrice: 10,
          },
        ],
      });
      prisma.customer.findFirst.mockResolvedValue({ pricingTier: 3 });
      prisma.customerPrice.findMany.mockResolvedValue([]);
      prisma.product.findMany.mockResolvedValue([TIERED_PRODUCT]);

      await expect(
        service.updateOrderItems(
          "ord-1",
          { items: [{ productId: "prod-1", qty: 2, unitPrice: 10 }], replaceAll: true },
          operatorPayload,
          { isCreateMerge: true },
        ),
      ).rejects.toThrow(BadRequestException);

      expect(prisma.orderItem.create).not.toHaveBeenCalled();
    });

    it("(r4-3) B465 fix round 4 (Opus BLOCK item 3, LOW): overrideReason: null on a genuine reprice falls back to the stored reason instead of throwing a 500", async () => {
      prisma.order.findUnique.mockResolvedValue({
        ...MOCK_ORDER,
        status: "DRAFT" as const,
        lineItems: [
          {
            id: "li-1",
            orderId: "ord-1",
            productId: "prod-1",
            qty: 3,
            unitPrice: 8,
            subtotal: 24,
            status: "PENDING",
            boxes: null,
            pieces: null,
            priceType: "SPECIAL",
            originalPrice: 10,
            overrideReason: "manager approved",
          },
        ],
      });
      prisma.customer.findFirst.mockResolvedValue({ pricingTier: 3 });
      prisma.customerPrice.findMany.mockResolvedValue([]);
      prisma.product.findFirst.mockResolvedValue({ pricePerUnit: 10 });
      prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 36, status: "PENDING" }]);

      await expect(
        service.updateOrderItems(
          "ord-1",
          {
            items: [
              {
                id: "li-1",
                action: "UPDATE",
                qty: 3,
                unitPrice: 12,
                overrideReason: null as unknown as string,
              },
            ],
            replaceAll: false,
          },
          operatorPayload,
        ),
      ).resolves.not.toThrow();

      expect(prisma.orderItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "li-1" },
          data: expect.objectContaining({ unitPrice: 12, overrideReason: "manager approved" }),
        }),
      );
    });

    it("(r4-4) B465 fix round 4 (Opus BLOCK item 4, LOW): a half-cent float difference from the stored price is never treated as a MANUAL override", async () => {
      prisma.order.findUnique.mockResolvedValue({
        ...MOCK_ORDER,
        status: "DRAFT" as const,
        lineItems: [
          {
            id: "li-1",
            orderId: "ord-1",
            productId: "prod-1",
            qty: 3,
            unitPrice: 8,
            subtotal: 24,
            status: "PENDING",
            boxes: null,
            pieces: null,
            priceType: "SPECIAL",
            originalPrice: 10,
          },
        ],
      });
      prisma.customer.findFirst.mockResolvedValue({ pricingTier: 3 });
      prisma.customerPrice.findMany.mockResolvedValue([]);
      prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 24, status: "PENDING" }]);

      await service.updateOrderItems(
        "ord-1",
        // 8.001 is within the 0.005 tolerance of the stored 8 -- a float
        // rounding artifact, not a reprice decision.
        { items: [{ id: "li-1", action: "UPDATE", qty: 3, unitPrice: 8.001 }], replaceAll: false },
        operatorPayload,
      );

      const call = (prisma.orderItem.update as jest.Mock).mock.calls[0][0];
      expect(call.data.priceType).toBeUndefined();
      expect(call.data.originalPrice).toBeUndefined();
      expect(call.data.overriddenBy).toBeUndefined();
    });

    it("(r5-1) B465 fix round 5 (Opus BLOCK item 2, LOW, revert-probe): a within-tolerance price echo persists the EXISTING clean value, never the incoming near-miss float", async () => {
      // Round-4's fix made 8.001 correctly NOT a manual override, but the
      // actual persisted unitPrice was still the raw incoming 8.001 (gated on
      // `overridePrice !== null`, not `isManualOverride`) -- a no-op save
      // could drift the stored price by a fraction of a cent every time.
      prisma.order.findUnique.mockResolvedValue({
        ...MOCK_ORDER,
        status: "DRAFT" as const,
        lineItems: [
          {
            id: "li-1",
            orderId: "ord-1",
            productId: "prod-1",
            qty: 3,
            unitPrice: 8,
            subtotal: 24,
            status: "PENDING",
            boxes: null,
            pieces: null,
            priceType: "SPECIAL",
            originalPrice: 10,
          },
        ],
      });
      prisma.customer.findFirst.mockResolvedValue({ pricingTier: 3 });
      prisma.customerPrice.findMany.mockResolvedValue([]);
      prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 24, status: "PENDING" }]);

      await service.updateOrderItems(
        "ord-1",
        // 8.004 is within the 0.005 tolerance of the stored 8.
        { items: [{ id: "li-1", action: "UPDATE", qty: 3, unitPrice: 8.004 }], replaceAll: false },
        operatorPayload,
      );

      expect(prisma.orderItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "li-1" },
          data: expect.objectContaining({ unitPrice: 8, subtotal: 24 }),
        }),
      );
    });

    it("(r3-1) B465 fix round 3 (Opus BLOCK item 2, revert-probe): a qty-only edit on a SPECIAL line — price echoed back UNCHANGED, no reason — gives 200, never a 400", async () => {
      // Round-2 (cd704524) checked ONLY whether a price was present, never
      // whether it was actually MOVING — a payload that redundantly echoes
      // the line's own stored price alongside a qty change tripped the same
      // refusal as a genuine reprice attempt.
      prisma.order.findUnique.mockResolvedValue({
        ...MOCK_ORDER,
        status: "DRAFT" as const,
        lineItems: [
          {
            id: "li-1",
            orderId: "ord-1",
            productId: "prod-1",
            qty: 3,
            unitPrice: 8,
            subtotal: 24,
            status: "PENDING",
            boxes: null,
            pieces: null,
            priceType: "SPECIAL",
            originalPrice: 10,
          },
        ],
      });
      prisma.customer.findFirst.mockResolvedValue({ pricingTier: 3 });
      prisma.customerPrice.findMany.mockResolvedValue([]);
      prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 40, status: "PENDING" }]);

      await service.updateOrderItems(
        "ord-1",
        // qty bumped 3 -> 5; unitPrice echoed back at its OWN stored value (8).
        { items: [{ id: "li-1", action: "UPDATE", qty: 5, unitPrice: 8 }], replaceAll: false },
        operatorPayload,
      );

      expect(prisma.orderItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "li-1" },
          data: expect.objectContaining({ qty: 5, unitPrice: 8, subtotal: 40 }),
        }),
      );
    });

    it("(r3-2) B465 fix round 3 (Opus BLOCK item 2, revert-probe): editing one line never demands a reason from an untouched SPECIAL sibling", async () => {
      // The web-client half of this bug: an order carrying an untouched
      // SPECIAL line (no unitPrice in ITS OWN payload entry at all — the real
      // client behavior for anything it never touched) alongside a genuinely
      // edited line must save cleanly. li-1 is SPECIAL/untouched (id+qty only,
      // matching its own stored qty — a true no-op); li-2 is a plain line
      // whose qty actually changes.
      prisma.order.findUnique.mockResolvedValue({
        ...MOCK_ORDER,
        status: "DRAFT" as const,
        lineItems: [
          {
            id: "li-1",
            orderId: "ord-1",
            productId: "prod-1",
            qty: 3,
            unitPrice: 8,
            subtotal: 24,
            status: "PENDING",
            boxes: null,
            pieces: null,
            priceType: "SPECIAL",
            originalPrice: 10,
          },
          {
            id: "li-2",
            orderId: "ord-1",
            productId: "prod-2",
            qty: 2,
            unitPrice: 5,
            subtotal: 10,
            status: "PENDING",
            boxes: null,
            pieces: null,
            priceType: "STANDARD",
            originalPrice: null,
          },
        ],
      });
      prisma.customer.findFirst.mockResolvedValue({ pricingTier: 3 });
      prisma.customerPrice.findMany.mockResolvedValue([]);
      prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 33, status: "PENDING" }]);

      await service.updateOrderItems(
        "ord-1",
        {
          items: [
            // li-1: genuinely untouched — no unitPrice field at all.
            { id: "li-1", action: "UPDATE", qty: 3 },
            // li-2: the actual edit this save is for.
            { id: "li-2", action: "UPDATE", qty: 4 },
          ],
          replaceAll: false,
        },
        operatorPayload,
      );

      expect(prisma.orderItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "li-1" },
          data: expect.objectContaining({ qty: 3 }),
        }),
      );
      expect(prisma.orderItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "li-2" },
          data: expect.objectContaining({ qty: 4 }),
        }),
      );
    });

    it("(r3-3) B465 fix round 3 (Opus BLOCK item 3, LOW): a blank incoming reason on a genuine reprice falls back to the stored reason, never clears it", async () => {
      // A defensive client (or a future one) sends overrideReason: "" alongside
      // a genuine price change for a line that ALREADY has a documented
      // reason on file — the write must not wipe it out.
      prisma.order.findUnique.mockResolvedValue({
        ...MOCK_ORDER,
        status: "DRAFT" as const,
        lineItems: [
          {
            id: "li-1",
            orderId: "ord-1",
            productId: "prod-1",
            qty: 3,
            unitPrice: 8,
            subtotal: 24,
            status: "PENDING",
            boxes: null,
            pieces: null,
            priceType: "SPECIAL",
            originalPrice: 10,
            overrideReason: "manager approved",
          },
        ],
      });
      prisma.customer.findFirst.mockResolvedValue({ pricingTier: 3 });
      prisma.customerPrice.findMany.mockResolvedValue([]);
      prisma.product.findFirst.mockResolvedValue({ pricePerUnit: 10 }); // catalog anchor read
      prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 36, status: "PENDING" }]);

      await service.updateOrderItems(
        "ord-1",
        {
          items: [{ id: "li-1", action: "UPDATE", qty: 3, unitPrice: 12, overrideReason: "" }],
          replaceAll: false,
        },
        operatorPayload,
      );

      expect(prisma.orderItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "li-1" },
          data: expect.objectContaining({ unitPrice: 12, overrideReason: "manager approved" }),
        }),
      );
    });

    it("(h) B465: a documented override (price + reason) on an EXISTING SPECIAL line still works", async () => {
      prisma.order.findUnique.mockResolvedValue({
        ...MOCK_ORDER,
        status: "DRAFT" as const,
        lineItems: [
          {
            id: "li-1",
            orderId: "ord-1",
            productId: "prod-1",
            qty: 3,
            unitPrice: 8,
            subtotal: 24,
            status: "PENDING",
            boxes: null,
            pieces: null,
            priceType: "SPECIAL",
            originalPrice: 10,
          },
        ],
      });
      prisma.customer.findFirst.mockResolvedValue({ pricingTier: 3 });
      prisma.customerPrice.findMany.mockResolvedValue([]);
      prisma.product.findFirst.mockResolvedValue({ pricePerUnit: 10 }); // catalog anchor read
      prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 36, status: "PENDING" }]);

      await service.updateOrderItems(
        "ord-1",
        {
          items: [
            {
              id: "li-1",
              action: "UPDATE",
              qty: 3,
              unitPrice: 12,
              overrideReason: "manager approved",
            },
          ],
          replaceAll: false,
        },
        operatorPayload,
      );

      expect(prisma.orderItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "li-1" },
          data: expect.objectContaining({
            unitPrice: 12,
            subtotal: 36,
            priceType: "MANUAL",
            originalPrice: 10,
            overriddenBy: "user-op",
            overrideReason: "manager approved",
          }),
        }),
      );
    });

    it("(i) B465: existing CANCELLED gate (unchanged) — items can't be edited on a CANCELLED order at all, refused before any mutation. This passes with or without B465 — the server's status gate already matches web's editWindow (computeEditWindow: editable = status !== CANCELLED), so no gate change was needed for B465; this pins that the pre-existing behavior is untouched.", async () => {
      prisma.order.findUnique.mockResolvedValue({
        ...MOCK_ORDER,
        status: "CANCELLED" as const,
        lineItems: [],
      });

      await expect(
        service.updateOrderItems(
          "ord-1",
          { items: [{ productId: "prod-1", qty: 2 }], replaceAll: false },
          operatorPayload,
        ),
      ).rejects.toThrow(BadRequestException);

      expect(prisma.orderItem.create).not.toHaveBeenCalled();
      expect(prisma.orderItem.update).not.toHaveBeenCalled();
    });
  });

  // ── WP1 (phase 2): the SAME boxes:0/pieces:0 trap that zeroed create()'s qty
  // existed in three updateOrderItems branches (replace-all, merge/add, and an
  // existing-line qty edit) — each read `item.boxes != null || item.pieces !=
  // null` and treated an explicit zero as a real split. Fixed with the same
  // positive check as create(). ────────────────────────────────────────────
  describe("updateOrderItems — boxes:0/pieces:0 no longer zeroes/drops a line (WP1 phase 2)", () => {
    it("replace-all: boxes:0/pieces:0 on a plain-qty line keeps the real qty (not zeroed)", async () => {
      prisma.order.findUnique.mockResolvedValue({
        ...MOCK_ORDER,
        status: "DRAFT" as const,
        lineItems: [],
      });
      prisma.customer.findUnique.mockResolvedValue({ pricingTier: 1 });
      prisma.product.findMany.mockResolvedValue([MOCK_PRODUCT]); // pricePerUnit 4.99, no unitsPerBox
      prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 9.98, status: "PENDING" }]);

      await service.updateOrderItems(
        "ord-1",
        { items: [{ productId: "prod-1", qty: 2, boxes: 0, pieces: 0 }], replaceAll: true },
        operatorPayload,
      );

      expect(prisma.orderItem.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            productId: "prod-1",
            qty: 2,
            boxes: null,
            pieces: null,
            subtotal: 9.98,
          }),
        }),
      );
    });

    it("merge/add: boxes:0/pieces:0 on a NEW plain-qty line keeps the real qty (old code derived qty 0 and silently dropped the line)", async () => {
      prisma.order.findUnique.mockResolvedValue({
        ...MOCK_ORDER,
        status: "DRAFT" as const,
        lineItems: [],
      });
      prisma.customer.findUnique.mockResolvedValue({ pricingTier: 1 });
      prisma.customerPrice.findMany.mockResolvedValue([]);
      prisma.product.findUnique.mockResolvedValue(MOCK_PRODUCT);
      prisma.product.findMany.mockResolvedValue([MOCK_PRODUCT]);
      prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 9.98, status: "PENDING" }]);

      await service.updateOrderItems(
        "ord-1",
        { items: [{ productId: "prod-1", qty: 2, boxes: 0, pieces: 0 }], replaceAll: false },
        operatorPayload,
      );

      expect(prisma.orderItem.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            productId: "prod-1",
            qty: 2,
            boxes: null,
            pieces: null,
            subtotal: 9.98,
          }),
        }),
      );
    });

    it("existing-line edit: boxes:0/pieces:0 sent alongside a real qty is not silently discarded (old code derived qty 0 and skipped the update)", async () => {
      prisma.order.findUnique.mockResolvedValue({
        ...MOCK_ORDER,
        status: "DRAFT" as const,
        lineItems: [
          {
            id: "li-1",
            orderId: "ord-1",
            productId: "prod-1",
            qty: 3,
            unitPrice: 4.99,
            subtotal: 14.97,
            status: "PENDING",
            boxes: null,
            pieces: null,
          },
        ],
      });
      prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 24.95, status: "PENDING" }]);

      await service.updateOrderItems(
        "ord-1",
        { items: [{ id: "li-1", action: "UPDATE" as const, qty: 5, boxes: 0, pieces: 0 }] },
        operatorPayload,
      );

      expect(prisma.orderItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "li-1" },
          data: expect.objectContaining({ qty: 5, boxes: null, pieces: null, subtotal: 24.95 }),
        }),
      );
    });
  });

  // ─── updateOrderItems — driver diff routing (A4) ────────────────────────────
  // The mobile item editor is shared between the operator and driver screens and
  // sends an incremental diff ({id, action} entries, replaceAll:false). The
  // CUSTOMER/DRIVER branch is a full replace (deleteMany + re-create from
  // productId-carrying entries), so a driver diff routed through it deleted
  // every untouched line on the order. These pin the fix: driver diffs merge
  // like operator edits (with price fields stripped — B13), buyer diffs 400.

  describe("updateOrderItems — driver diff routing (A4: driver edits must not wipe orders)", () => {
    const driverPayload = { ...operatorPayload, sub: "user-drv", role: "DRIVER" as const };
    const twoLineOrder = {
      ...MOCK_ORDER,
      status: "OUT_FOR_DELIVERY" as const,
      routeRun: { status: "DISPATCHED", startedAt: new Date() },
      lineItems: [
        {
          id: "li-A",
          orderId: "ord-1",
          productId: "prod-A",
          qty: 2,
          unitPrice: 5,
          subtotal: 10,
          status: "PENDING",
          boxes: null,
          pieces: null,
        },
        {
          id: "li-B",
          orderId: "ord-1",
          productId: "prod-B",
          qty: 1,
          unitPrice: 7,
          subtotal: 7,
          status: "PENDING",
          boxes: null,
          pieces: null,
        },
      ],
    };

    it("a driver diff UPDATE merges — the untouched line survives, no wholesale delete", async () => {
      prisma.order.findUnique.mockResolvedValue(twoLineOrder);
      prisma.orderItem.findMany.mockResolvedValue([
        { subtotal: 25, status: "PENDING" },
        { subtotal: 7, status: "PENDING" },
      ]);

      await service.updateOrderItems(
        "ord-1",
        { items: [{ id: "li-A", action: "UPDATE", qty: 5 }], replaceAll: false },
        driverPayload,
      );

      // The old routing deleteMany'd ALL lines and re-created none (a diff
      // entry carries no productId) — the whole order vanished on save.
      expect(prisma.orderItem.deleteMany).not.toHaveBeenCalled();
      expect(prisma.orderItem.update).toHaveBeenCalledTimes(1);
      expect(prisma.orderItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "li-A" },
          data: expect.objectContaining({ qty: 5, unitPrice: 5, subtotal: 25 }),
        }),
      );
    });

    it("a driver diff UPDATE cannot smuggle a price — the line's stored (operator-set) price survives", async () => {
      // li-A carries an operator override ($4.50 vs $5 list). A driver qty edit
      // must keep it — the old replace path re-priced every line back to list.
      prisma.order.findUnique.mockResolvedValue({
        ...twoLineOrder,
        lineItems: [
          { ...twoLineOrder.lineItems[0], unitPrice: 4.5, priceType: "MANUAL" },
          twoLineOrder.lineItems[1],
        ],
      });
      prisma.orderItem.findMany.mockResolvedValue([
        { subtotal: 13.5, status: "PENDING" },
        { subtotal: 7, status: "PENDING" },
      ]);

      await service.updateOrderItems(
        "ord-1",
        {
          items: [
            { id: "li-A", action: "UPDATE", qty: 3, unitPrice: 0.01, overrideReason: "driver" },
          ],
          replaceAll: false,
        },
        driverPayload,
      );

      const call = prisma.orderItem.update.mock.calls.at(-1)?.[0];
      expect(call.where).toEqual({ id: "li-A" });
      expect(call.data.unitPrice).toBe(4.5); // stored price, not 0.01
      expect(call.data.subtotal).toBe(13.5);
      expect(call.data.priceType).toBeUndefined(); // no new override recorded
      expect(call.data.overriddenBy).toBeUndefined();
    });

    it("a driver diff fresh add prices from the catalog, ignoring the client price", async () => {
      prisma.order.findUnique.mockResolvedValue(twoLineOrder);
      const prodC = { id: "prod-C", pricePerUnit: 9, unitsPerBox: null };
      prisma.product.findUnique.mockResolvedValue(prodC);
      prisma.product.findMany.mockResolvedValue([prodC]);
      prisma.orderItem.findMany.mockResolvedValue([
        { subtotal: 10, status: "PENDING" },
        { subtotal: 7, status: "PENDING" },
        { subtotal: 18, status: "PENDING" },
      ]);

      await service.updateOrderItems(
        "ord-1",
        { items: [{ productId: "prod-C", qty: 2, unitPrice: 0.5 }], replaceAll: false },
        driverPayload,
      );

      expect(prisma.orderItem.deleteMany).not.toHaveBeenCalled();
      expect(prisma.orderItem.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            productId: "prod-C",
            unitPrice: 9,
            priceType: "STANDARD",
          }),
        }),
      );
    });

    it("a driver diff fresh add bills LIST even for a tiered customer — tier resolution is staff-only", async () => {
      // WP1 gave the operator/admin branch a tier ladder, and a DRIVER diff is
      // routed through that same branch (A4). Driver edits keep the legacy list
      // pricing, so the customer's tier 3 ($6) must not touch this line.
      prisma.order.findUnique.mockResolvedValue(twoLineOrder);
      prisma.customer.findUnique.mockResolvedValue({ pricingTier: 3 });
      prisma.customerPrice.findMany.mockResolvedValue([
        { productId: "prod-C", pricingTier: 3, msrp: null },
      ]);
      const prodCTiered = { id: "prod-C", pricePerUnit: 9, priceTier3: 6, unitsPerBox: null };
      prisma.product.findUnique.mockResolvedValue(prodCTiered);
      prisma.product.findMany.mockResolvedValue([prodCTiered]);
      prisma.orderItem.findMany.mockResolvedValue([
        { subtotal: 10, status: "PENDING" },
        { subtotal: 7, status: "PENDING" },
        { subtotal: 18, status: "PENDING" },
      ]);

      await service.updateOrderItems(
        "ord-1",
        { items: [{ productId: "prod-C", qty: 2 }], replaceAll: false },
        driverPayload,
      );

      expect(prisma.orderItem.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            productId: "prod-C",
            unitPrice: 9,
            originalPrice: null,
            priceType: "STANDARD",
            subtotal: 18,
          }),
        }),
      );
    });

    it("a driver diff DELETE removes only the targeted line", async () => {
      prisma.order.findUnique.mockResolvedValue(twoLineOrder);
      prisma.deliveryMutation.count.mockResolvedValue(0);
      prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 7, status: "PENDING" }]);

      await service.updateOrderItems(
        "ord-1",
        { items: [{ id: "li-A", action: "DELETE" }], replaceAll: false },
        driverPayload,
      );

      expect(prisma.orderItem.deleteMany).not.toHaveBeenCalled();
      expect(prisma.orderItem.delete).toHaveBeenCalledWith({ where: { id: "li-A" } });
    });

    it("a driver diff substitution bills the substitute's list price (B13 — no price control)", async () => {
      prisma.order.findUnique.mockResolvedValue(twoLineOrder);
      prisma.product.findUniqueOrThrow.mockResolvedValue({
        id: "prod-sub",
        pricePerUnit: 8,
        unitsPerBox: null,
      });
      prisma.orderItem.findMany.mockResolvedValue([
        { subtotal: 24, status: "PENDING" },
        { subtotal: 7, status: "PENDING" },
      ]);

      await service.updateOrderItems(
        "ord-1",
        {
          items: [{ id: "li-A", substituteProductId: "prod-sub", qty: 3, unitPrice: 1 }],
          replaceAll: false,
        },
        driverPayload,
      );

      expect(prisma.orderItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "li-A" },
          data: expect.objectContaining({
            productId: "prod-sub",
            unitPrice: 8,
            priceType: "STANDARD",
            originalPrice: null,
          }),
        }),
      );
    });

    it("a driver legacy full id-less list (old clients) still replaces", async () => {
      prisma.order.findUnique.mockResolvedValue(twoLineOrder);
      prisma.product.findMany.mockResolvedValue([
        { id: "prod-A", pricePerUnit: 5, unitsPerBox: null },
      ]);
      prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 20, status: "PENDING" }]);

      await service.updateOrderItems(
        "ord-1",
        { items: [{ productId: "prod-A", qty: 4 }] },
        driverPayload,
      );

      expect(prisma.orderItem.deleteMany).toHaveBeenCalledWith({ where: { orderId: "ord-1" } });
    });

    it("a buyer (CUSTOMER) diff-shaped payload is rejected with 400 before any mutation", async () => {
      prisma.order.findUnique.mockResolvedValue({ ...twoLineOrder, status: "PENDING" });

      await expect(
        service.updateOrderItems(
          "ord-1",
          { items: [{ id: "li-A", action: "UPDATE", qty: 3 }], replaceAll: false },
          customerPayload,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.orderItem.deleteMany).not.toHaveBeenCalled();
      expect(prisma.orderItem.update).not.toHaveBeenCalled();
      expect(prisma.orderItem.create).not.toHaveBeenCalled();
    });
  });

  // ─── updateShipment (carrier tracking on the order + its invoices) ──────────

  // ─── updateOrderItems — boxed line proration (edit over-charge fix) ─────────
  // A boxed product prices by the BOX (unitPrice = box price, qty = piece count),
  // so an edited boxed line must prorate as unitPrice*(boxes + pieces/unitsPerBox).
  // Regression guard against dropping boxes/pieces → unitPrice*qty over-charge.

  describe("updateOrderItems — boxed line proration", () => {
    it("customer edit of a PIECE-denominated boxed line re-prorates (not unitPrice*qty)", async () => {
      // The existing line was stored box-aware (boxes/pieces set) → qty is pieces.
      prisma.order.findUnique.mockResolvedValue({
        ...MOCK_ORDER,
        status: "PENDING",
        lineItems: [
          {
            id: "li-box",
            orderId: "ord-1",
            productId: "prod-box",
            qty: 12,
            unitPrice: 28.35,
            subtotal: 28.35,
            status: "PENDING",
            boxes: 1,
            pieces: 0,
          },
        ],
      });
      prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
      prisma.product.findMany.mockResolvedValue([
        { id: "prod-box", pricePerUnit: 28.35, unitsPerBox: 12 },
      ]);
      prisma.orderItem.findMany.mockResolvedValue([]);

      // Buyer sets qty = 27 pieces (= 2 boxes + 3) of a 12-per-box product.
      await service.updateOrderItems(
        "ord-1",
        { items: [{ productId: "prod-box", qty: 27 }] },
        customerPayload,
      );

      const created = prisma.orderItem.create.mock.calls[0][0].data;
      // 28.35 * (2 + 3/12) = 63.7875 → 63.79 — NOT 28.35 * 27 = 765.45.
      expect(created.subtotal).toBeCloseTo(63.79, 2);
      expect(created.subtotal).not.toBeCloseTo(765.45, 2);
      expect(created.qty).toBe(27);
      expect(created.boxes).toBe(2);
      expect(created.pieces).toBe(3);
    });

    it("customer edit of a SELLING-UNIT boxed line (boxes null) does NOT re-prorate", async () => {
      // Regression guard: a box-UNAWARE line (e.g. from the mobile cart) stores
      // qty as a box count with boxes=null. Re-splitting it as pieces would
      // UNDER-charge (e.g. a $120 / 2-box line → $20). It must stay unitPrice*qty.
      prisma.order.findUnique.mockResolvedValue({
        ...MOCK_ORDER,
        status: "PENDING",
        lineItems: [
          {
            id: "li-boxunaware",
            orderId: "ord-1",
            productId: "prod-box",
            qty: 2,
            unitPrice: 60,
            subtotal: 120,
            status: "PENDING",
            boxes: null,
            pieces: null,
          },
        ],
      });
      prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
      prisma.product.findMany.mockResolvedValue([
        { id: "prod-box", pricePerUnit: 60, unitsPerBox: 6 },
      ]);
      prisma.orderItem.findMany.mockResolvedValue([]);

      await service.updateOrderItems(
        "ord-1",
        { items: [{ productId: "prod-box", qty: 2 }] },
        customerPayload,
      );

      const created = prisma.orderItem.create.mock.calls[0][0].data;
      // 2 boxes * $60 = $120 — must NOT become $60*(2/6) = $20.
      expect(created.subtotal).toBeCloseTo(120, 2);
      expect(created.subtotal).not.toBeCloseTo(20, 2);
      expect(created.qty).toBe(2);
      expect(created.boxes).toBeNull();
      expect(created.pieces).toBeNull();
    });

    it("customer edit of a non-boxed product still charges unitPrice*qty", async () => {
      prisma.order.findUnique.mockResolvedValue({
        ...MOCK_ORDER,
        status: "PENDING",
        lineItems: [],
      });
      prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
      prisma.product.findMany.mockResolvedValue([
        { id: "prod-plain", pricePerUnit: 3.5, unitsPerBox: null },
      ]);
      prisma.orderItem.findMany.mockResolvedValue([]);

      await service.updateOrderItems(
        "ord-1",
        { items: [{ productId: "prod-plain", qty: 5 }] },
        customerPayload,
      );

      const created = prisma.orderItem.create.mock.calls[0][0].data;
      expect(created.subtotal).toBeCloseTo(17.5, 2); // 3.5 * 5
      expect(created.boxes).toBeNull();
      expect(created.pieces).toBeNull();
    });

    it("customer ADD of a NEW boxed line (not yet on the order) splits + prorates by the box", async () => {
      // Buyer create/merge path (buyer.controller.createOrder) folds a shelf/cart
      // Add into an active order and re-runs updateOrderItems as CUSTOMER. A boxed
      // product NOT already on the order has no line in `pieceDenominated`, yet its
      // incoming qty is PIECES (24 = 2 boxes of 12). It must split to boxes=2 and
      // price 2 × $30 = $60 — NOT store 24 boxes at $30 = $720 (unitsPerBox× over).
      prisma.order.findUnique.mockResolvedValue({
        ...MOCK_ORDER,
        status: "PENDING",
        lineItems: [],
      });
      prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
      prisma.product.findMany.mockResolvedValue([
        { id: "prod-box-new", pricePerUnit: 30, unitsPerBox: 12 },
      ]);
      prisma.orderItem.findMany.mockResolvedValue([]);

      await service.updateOrderItems(
        "ord-1",
        { items: [{ productId: "prod-box-new", qty: 24 }] },
        customerPayload,
      );

      const created = prisma.orderItem.create.mock.calls[0][0].data;
      expect(created.qty).toBe(24);
      expect(created.boxes).toBe(2);
      expect(created.pieces).toBe(0);
      expect(created.subtotal).toBeCloseTo(60, 2); // 2 boxes × $30
      expect(created.subtotal).not.toBeCloseTo(720, 2);
    });

    it("operator UPDATE prorates a boxed line when the client sends boxes/pieces", async () => {
      prisma.order.findUnique.mockResolvedValue({
        ...MOCK_ORDER,
        status: "DRAFT",
        lineItems: [
          {
            id: "li-1",
            orderId: "ord-1",
            productId: "prod-box",
            qty: 12,
            unitPrice: 28.35,
            subtotal: 28.35,
            status: "PENDING",
            boxes: 1,
            pieces: 0,
          },
        ],
      });
      prisma.product.findFirst.mockResolvedValue({ id: "prod-box", unitsPerBox: 12 }); // box-size resolve
      prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 63.79, status: "PENDING" }]);

      await service.updateOrderItems(
        "ord-1",
        {
          items: [{ id: "li-1", action: "UPDATE", qty: 27, boxes: 2, pieces: 3 }],
          replaceAll: false,
        },
        operatorPayload,
      );

      const updated = prisma.orderItem.update.mock.calls[0][0].data;
      expect(updated.subtotal).toBeCloseTo(63.79, 2);
      expect(updated.subtotal).not.toBeCloseTo(765.45, 2);
      expect(updated.qty).toBe(27);
      expect(updated.boxes).toBe(2);
      expect(updated.pieces).toBe(3);
    });

    it("operator replaceAll prorates a boxed line from boxes/pieces", async () => {
      prisma.order.findUnique.mockResolvedValue({
        ...MOCK_ORDER,
        status: "DRAFT",
        lineItems: [],
      });
      prisma.product.findMany.mockResolvedValue([
        { id: "prod-box", pricePerUnit: 28.35, unitsPerBox: 12 },
      ]);
      prisma.orderItem.findMany.mockResolvedValue([]);

      await service.updateOrderItems(
        "ord-1",
        {
          items: [{ productId: "prod-box", qty: 27, boxes: 2, pieces: 3 }],
          replaceAll: true,
        },
        operatorPayload,
      );

      const created = prisma.orderItem.create.mock.calls[0][0].data;
      expect(created.subtotal).toBeCloseTo(63.79, 2);
      expect(created.subtotal).not.toBeCloseTo(765.45, 2);
      expect(created.qty).toBe(27);
      expect(created.boxes).toBe(2);
      expect(created.pieces).toBe(3);
    });

    it("qty-ONLY edit of a box-split line re-derives the split and prorates the box price (reverse-divergence fix)", async () => {
      // Existing box-split line: 1 box of 12 @ $28.35/box, snapshot upb=12.
      // Editing qty to 24 pieces (2 boxes) must prorate to $56.70 and refresh the
      // split to boxes=2/pieces=0 — NOT bill 24 × $28.35 and leave boxes=1 stale.
      prisma.order.findUnique.mockResolvedValue({
        ...MOCK_ORDER,
        status: "DRAFT",
        lineItems: [
          {
            id: "li-1",
            orderId: "ord-1",
            productId: "prod-box",
            qty: 12,
            unitPrice: 28.35,
            subtotal: 28.35,
            status: "PENDING",
            boxes: 1,
            pieces: 0,
            unitsPerBox: 12,
          },
        ],
      });
      prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 56.7, status: "PENDING" }]);

      await service.updateOrderItems(
        "ord-1",
        { items: [{ id: "li-1", action: "UPDATE", qty: 24 }], replaceAll: false },
        operatorPayload,
      );

      const updated = prisma.orderItem.update.mock.calls[0][0].data;
      expect(updated.subtotal).toBeCloseTo(56.7, 2);
      expect(updated.subtotal).not.toBeCloseTo(680.4, 2); // 24 × 28.35 (the old bug)
      expect(updated.qty).toBe(24);
      expect(updated.boxes).toBe(2);
      expect(updated.pieces).toBe(0);
    });
  });

  // ─── Order merge/consolidate — boxed line proration ─────────────────────────
  // Merging PENDING orders must re-prorate boxed lines by the combined PIECE
  // count, never a naive summed-qty * unitPrice (which over-charged by
  // unitsPerBox). Contributions normalize to pieces, re-split, price via
  // computeLineSubtotal; merged lines come out piece-denominated.

  describe("mergeAllPendingForCustomer — boxed proration", () => {
    const boxLine = (id: string, extra: Record<string, unknown> = {}) => ({
      id,
      orderId: "o?",
      productId: "prod-box",
      qty: 6,
      unitPrice: 60,
      subtotal: 60,
      status: "PENDING",
      priceType: "STANDARD",
      originalPrice: null,
      name: null,
      overrideReason: null,
      overriddenBy: null,
      boxes: 1,
      pieces: 0,
      ...extra,
    });

    it("re-prorates a piece-denominated boxed winner line (2 boxes = $120, not $720)", async () => {
      prisma.order.findMany.mockResolvedValue([
        { id: "w1", customerId: "cust-1", status: "PENDING", lineItems: [boxLine("wl1")] },
        { id: "l1", customerId: "cust-1", status: "PENDING", lineItems: [boxLine("ll1")] },
      ]);
      prisma.product.findMany.mockResolvedValue([{ id: "prod-box", unitsPerBox: 6 }]);

      await service.mergeAllPendingForCustomer("cust-1");

      const upd = prisma.orderItem.update.mock.calls[0][0].data;
      // 6 pieces + 6 pieces = 12 → 2 boxes → $60 * 2 = $120. NOT 12 * $60 = $720.
      expect(upd.subtotal).toBeCloseTo(120, 2);
      expect(upd.subtotal).not.toBeCloseTo(720, 2);
      expect(upd.qty).toBe(12);
      expect(upd.boxes).toBe(2);
      expect(upd.pieces).toBe(0);
    });

    it("preserves a loser regulated line's tracked-category snapshot + flips hasRegulated", async () => {
      const line = (id: string, extra: Record<string, unknown>) => ({
        id,
        productId: "p?",
        qty: 1,
        unitPrice: 5,
        subtotal: 5,
        status: "PENDING",
        priceType: "STANDARD",
        originalPrice: null,
        name: null,
        overrideReason: null,
        overriddenBy: null,
        boxes: null,
        pieces: null,
        trackedCategoryId: null,
        ...extra,
      });
      prisma.order.findMany.mockResolvedValue([
        {
          id: "w1",
          customerId: "cust-1",
          status: "PENDING",
          lineItems: [line("wl1", { productId: "prod-std" })],
        },
        {
          id: "l1",
          customerId: "cust-1",
          status: "PENDING",
          // A regulated line, only on the loser → becomes a NEW winner item.
          lineItems: [line("ll1", { productId: "prod-tob", trackedCategoryId: "cat-tob" })],
        },
      ]);
      prisma.product.findMany.mockResolvedValue([
        { id: "prod-std", unitsPerBox: null },
        { id: "prod-tob", unitsPerBox: null },
      ]);
      // activeItems (post-merge totals + hasRegulated recompute) include the reg line.
      prisma.orderItem.findMany.mockResolvedValue([
        { subtotal: 5, trackedCategoryId: null },
        { subtotal: 5, trackedCategoryId: "cat-tob" },
      ]);

      await service.mergeAllPendingForCustomer("cust-1");

      const created = prisma.orderItem.create.mock.calls[0][0].data;
      expect(created.productId).toBe("prod-tob");
      expect(created.trackedCategoryId).toBe("cat-tob"); // snapshot survived the merge
      const upd = prisma.order.update.mock.calls.at(-1)![0].data;
      expect(upd.hasRegulated).toBe(true);
    });

    it("heals a selling-unit (boxes null) boxed merge to piece-denominated $120", async () => {
      // Two mobile-created box-count lines (qty = boxes, boxes/pieces null).
      const su = (id: string) => boxLine(id, { qty: 1, boxes: null, pieces: null });
      prisma.order.findMany.mockResolvedValue([
        { id: "w1", customerId: "cust-1", status: "PENDING", lineItems: [su("wl1")] },
        { id: "l1", customerId: "cust-1", status: "PENDING", lineItems: [su("ll1")] },
      ]);
      prisma.product.findMany.mockResolvedValue([{ id: "prod-box", unitsPerBox: 6 }]);

      await service.mergeAllPendingForCustomer("cust-1");

      const upd = prisma.orderItem.update.mock.calls[0][0].data;
      // 1 box * 6 + 1 box * 6 = 12 pieces → 2 boxes → $120; now piece-denominated.
      expect(upd.subtotal).toBeCloseTo(120, 2);
      expect(upd.qty).toBe(12);
      expect(upd.boxes).toBe(2);
      expect(upd.pieces).toBe(0);
    });

    it("merges MIXED denominations (box-split winner + selling-unit loser) correctly", async () => {
      // Winner: box-split 1 box + 2 loose (qty 8 pieces). Loser: selling-unit 1 box (qty 1).
      prisma.order.findMany.mockResolvedValue([
        {
          id: "w1",
          customerId: "cust-1",
          status: "PENDING",
          lineItems: [boxLine("wl1", { qty: 8, boxes: 1, pieces: 2 })],
        },
        {
          id: "l1",
          customerId: "cust-1",
          status: "PENDING",
          lineItems: [boxLine("ll1", { qty: 1, boxes: null, pieces: null })],
        },
      ]);
      prisma.product.findMany.mockResolvedValue([{ id: "prod-box", unitsPerBox: 6 }]);

      await service.mergeAllPendingForCustomer("cust-1");

      const upd = prisma.orderItem.update.mock.calls[0][0].data;
      // 8 pieces + (1 box * 6) = 14 pieces → 2 boxes + 2 loose → 60*(2 + 2/6) = $140.
      expect(upd.subtotal).toBeCloseTo(140, 2);
      expect(upd.qty).toBe(14);
      expect(upd.boxes).toBe(2);
      expect(upd.pieces).toBe(2);
    });

    it("sums MULTIPLE losers for one product (contributions array, not overwrite)", async () => {
      prisma.order.findMany.mockResolvedValue([
        { id: "w1", customerId: "cust-1", status: "PENDING", lineItems: [boxLine("wl1")] },
        { id: "l1", customerId: "cust-1", status: "PENDING", lineItems: [boxLine("ll1")] },
        { id: "l2", customerId: "cust-1", status: "PENDING", lineItems: [boxLine("ll2")] },
      ]);
      prisma.product.findMany.mockResolvedValue([{ id: "prod-box", unitsPerBox: 6 }]);

      await service.mergeAllPendingForCustomer("cust-1");

      const upd = prisma.orderItem.update.mock.calls[0][0].data;
      // 6 + 6 + 6 = 18 pieces → 3 boxes → $180 (all three contributions counted).
      expect(upd.subtotal).toBeCloseTo(180, 2);
      expect(upd.qty).toBe(18);
      expect(upd.boxes).toBe(3);
    });

    it("recomputes the order header total from the prorated line subtotals", async () => {
      prisma.order.findMany.mockResolvedValue([
        { id: "w1", customerId: "cust-1", status: "PENDING", lineItems: [boxLine("wl1")] },
        { id: "l1", customerId: "cust-1", status: "PENDING", lineItems: [boxLine("ll1")] },
      ]);
      prisma.product.findMany.mockResolvedValue([{ id: "prod-box", unitsPerBox: 6 }]);
      // The in-tx recompute reads the (now merged) active line — return the $120 line.
      prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 120, status: "PENDING" }]);

      await service.mergeAllPendingForCustomer("cust-1");

      const orderUpd = prisma.order.update.mock.calls.find((c) => c[0]?.data?.subtotal != null);
      expect(orderUpd).toBeDefined();
      // taxRate mock = 0 (systemConfig.get → null), so subtotal 120, tax 0, total 120 — NOT $720-based.
      expect(orderUpd![0].data.subtotal).toBeCloseTo(120, 2);
      expect(orderUpd![0].data.total).toBeCloseTo(120, 2);
    });

    it("creates a boxed winner line from a loser-only product, prorated", async () => {
      prisma.order.findMany.mockResolvedValue([
        { id: "w1", customerId: "cust-1", status: "PENDING", lineItems: [] },
        { id: "l1", customerId: "cust-1", status: "PENDING", lineItems: [boxLine("ll1")] },
      ]);
      prisma.product.findMany.mockResolvedValue([{ id: "prod-box", unitsPerBox: 6 }]);

      await service.mergeAllPendingForCustomer("cust-1");

      const created = prisma.orderItem.create.mock.calls[0][0].data;
      expect(created.productId).toBe("prod-box");
      expect(created.subtotal).toBeCloseTo(60, 2); // 1 box
      expect(created.qty).toBe(6);
      expect(created.boxes).toBe(1);
      expect(created.pieces).toBe(0);
    });

    it("leaves a non-boxed line as summed qty * unitPrice", async () => {
      const plain = (id: string) => ({
        id,
        productId: "prod-plain",
        qty: 2,
        unitPrice: 5,
        subtotal: 10,
        status: "PENDING",
        priceType: "STANDARD",
        originalPrice: null,
        name: null,
        overrideReason: null,
        overriddenBy: null,
        boxes: null,
        pieces: null,
      });
      prisma.order.findMany.mockResolvedValue([
        { id: "w1", customerId: "cust-1", status: "PENDING", lineItems: [plain("wl1")] },
        {
          id: "l1",
          customerId: "cust-1",
          status: "PENDING",
          lineItems: [{ ...plain("ll1"), qty: 3, subtotal: 15 }],
        },
      ]);
      prisma.product.findMany.mockResolvedValue([{ id: "prod-plain", unitsPerBox: null }]);

      await service.mergeAllPendingForCustomer("cust-1");

      const upd = prisma.orderItem.update.mock.calls[0][0].data;
      expect(upd.subtotal).toBeCloseTo(25, 2); // (2 + 3) * $5
      expect(upd.qty).toBe(5);
      expect(upd.boxes).toBeNull();
    });
  });

  describe("forceConsolidateCustomer — boxed proration", () => {
    it("re-prorates a piece-denominated boxed winner line (2 boxes = $120, not $720)", async () => {
      const boxLine = (id: string) => ({
        id,
        productId: "prod-box",
        qty: 6,
        unitPrice: 60,
        subtotal: 60,
        status: "PENDING",
        priceType: "STANDARD",
        originalPrice: null,
        name: null,
        overrideReason: null,
        overriddenBy: null,
        boxes: 1,
        pieces: 0,
      });
      prisma.order.findMany.mockResolvedValue([
        {
          id: "w1",
          customerId: "cust-1",
          status: "PENDING",
          routeRunId: null,
          lineItems: [boxLine("wl1")],
        },
        {
          id: "l1",
          customerId: "cust-1",
          status: "PENDING",
          routeRunId: null,
          lineItems: [boxLine("ll1")],
        },
      ]);
      prisma.product.findMany.mockResolvedValue([{ id: "prod-box", unitsPerBox: 6 }]);

      await service.forceConsolidateCustomer("cust-1");

      const upd = prisma.orderItem.update.mock.calls[0][0].data;
      expect(upd.subtotal).toBeCloseTo(120, 2);
      expect(upd.subtotal).not.toBeCloseTo(720, 2);
      expect(upd.qty).toBe(12);
      expect(upd.boxes).toBe(2);
    });

    // B214: the consolidation hard-deletes the loser's open DRAFT mirror, and a DRAFT invoice is
    // an allowed credit-note source (CREDIT_SOURCE_EXCLUDED = VOID/WRITTEN_OFF only), so the FK
    // ON DELETE SET NULL would orphan an open note. Third door, same shared guard.
    it("P6: refuses the consolidation while the loser's DRAFT mirror sourced an unspent credit note", async () => {
      const line = (id: string) => ({
        id,
        productId: "prod-1",
        qty: 2,
        unitPrice: 10,
        subtotal: 20,
        status: "PENDING",
        priceType: "STANDARD",
        originalPrice: null,
        name: null,
        overrideReason: null,
        overriddenBy: null,
        boxes: null,
        pieces: null,
      });
      prisma.order.findMany.mockResolvedValue([
        {
          id: "w1",
          customerId: "cust-1",
          status: "PENDING",
          routeRunId: null,
          lineItems: [line("wl1")],
        },
        {
          id: "l1",
          customerId: "cust-1",
          status: "PENDING",
          routeRunId: null,
          lineItems: [line("ll1")],
        },
      ]);
      prisma.product.findMany.mockResolvedValue([{ id: "prod-1", unitsPerBox: null }]);
      invoicesService.findOpenOrderDraft.mockResolvedValue({ id: "inv-loser" });
      prisma.creditNote.findMany.mockResolvedValue([
        {
          id: "cn-1",
          creditNoteNumber: "CN-0001",
          invoiceId: "inv-loser",
          amount: 50,
          amountUsed: 0,
          status: "ISSUED",
          expiresAt: null,
        },
      ]);

      await expect(service.forceConsolidateCustomer("cust-1")).rejects.toMatchObject({
        response: { code: "INVOICE_HAS_UNSPENT_CREDIT" },
      });
      expect(prisma.invoice.delete).not.toHaveBeenCalled();
      expect(prisma.order.delete).not.toHaveBeenCalled();
    });
  });

  describe("updateShipment", () => {
    it("sets carrier + tracking on the order and mirrors them to non-void invoices", async () => {
      prisma.order.findFirst.mockResolvedValue({ id: "ord-1", shippedAt: null });
      prisma.order.update.mockResolvedValue({ id: "ord-1" });

      await service.updateShipment(
        "ord-1",
        { shippingCarrier: "UPS", shippingTrackingNumber: "1Z999AA10123456784" },
        operatorPayload,
      );

      expect(prisma.order.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "ord-1" },
          data: expect.objectContaining({
            shippingCarrier: "UPS",
            shippingTrackingNumber: "1Z999AA10123456784",
            shippedAt: expect.any(Date),
          }),
        }),
      );
      expect(prisma.invoice.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { orderId: "ord-1", status: { not: "VOID" } },
          data: expect.objectContaining({
            shippingCarrier: "UPS",
            shippingTrackingNumber: "1Z999AA10123456784",
          }),
        }),
      );
    });

    it("clears carrier, tracking and shippedAt when the tracking number is blank", async () => {
      prisma.order.findFirst.mockResolvedValue({ id: "ord-1", shippedAt: new Date() });
      prisma.order.update.mockResolvedValue({ id: "ord-1" });

      await service.updateShipment(
        "ord-1",
        { shippingCarrier: "", shippingTrackingNumber: "" },
        operatorPayload,
      );

      expect(prisma.order.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            shippingCarrier: null,
            shippingTrackingNumber: null,
            shippedAt: null,
          }),
        }),
      );
    });
  });

  // ─── P5-08: edit window (G7) + OrderRevision versioning ─────────────────────
  describe("updateOrderItems — edit window + revisions (P5-08)", () => {
    const confirmedOrder = (routeRun: { status: string; startedAt: Date | null } | null) => ({
      ...MOCK_ORDER,
      status: "CONFIRMED" as const,
      routeRun,
      lineItems: [
        {
          id: "li-1",
          orderId: "ord-1",
          productId: "prod-1",
          qty: 2,
          unitPrice: 5,
          subtotal: 10,
          status: "PENDING",
          boxes: null,
          pieces: null,
          priceType: "STANDARD",
          originalPrice: null,
        },
      ],
    });

    it("allows a direct edit even after the order's run has dispatched (R1), no PENDING revert", async () => {
      prisma.order.findUnique.mockResolvedValue(
        confirmedOrder({ status: "IN_PROGRESS", startedAt: new Date() }),
      );
      prisma.orderItem.findMany.mockResolvedValue([
        { id: "li-1", productId: "prod-1", qty: 3, unitPrice: 5, subtotal: 15, status: "PENDING" },
      ]);
      prisma.orderRevision.aggregate.mockResolvedValue({ _max: { revisionNumber: 1 } });

      await service.updateOrderItems(
        "ord-1",
        { items: [{ id: "li-1", action: "UPDATE", qty: 3, unitPrice: 5 }] },
        operatorPayload,
      );

      // R1: dispatch no longer closes the edit window — the edit proceeds and a
      // revision is recorded (previously this threw EDIT_WINDOW_CLOSED). A dispatched
      // CONFIRMED order is NOT reverted to PENDING (that would rewind the lifecycle).
      expect(prisma.orderRevision.create).toHaveBeenCalled();
      expect(mockGateway.emitOrderStatusChanged).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ status: "PENDING" }),
      );
    });

    it("allows the edit while the run is still SCHEDULED and appends a revision", async () => {
      prisma.order.findUnique.mockResolvedValue(
        confirmedOrder({ status: "SCHEDULED", startedAt: null }),
      );
      prisma.orderItem.findMany.mockResolvedValue([
        { id: "li-1", productId: "prod-1", qty: 3, unitPrice: 5, subtotal: 15, status: "PENDING" },
      ]);
      prisma.orderRevision.aggregate.mockResolvedValue({ _max: { revisionNumber: 1 } });

      await service.updateOrderItems(
        "ord-1",
        { items: [{ id: "li-1", action: "UPDATE", qty: 3, unitPrice: 5 }] },
        operatorPayload,
      );

      expect(prisma.orderRevision.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            orderId: "ord-1",
            revisionNumber: 2, // max(1) + 1
            source: "EDIT",
            editedByRole: "OPERATOR",
            snapshot: expect.objectContaining({ subtotal: 15, lineItems: expect.any(Array) }),
          }),
        }),
      );
    });

    it("numbers the first revision 1 when none exist yet", async () => {
      prisma.order.findUnique.mockResolvedValue(confirmedOrder(null));
      prisma.orderItem.findMany.mockResolvedValue([
        { id: "li-1", productId: "prod-1", qty: 2, unitPrice: 5, subtotal: 10, status: "PENDING" },
      ]);
      prisma.orderRevision.aggregate.mockResolvedValue({ _max: { revisionNumber: null } });

      await service.updateOrderItems(
        "ord-1",
        { items: [{ id: "li-1", action: "UPDATE", qty: 2, unitPrice: 5 }] },
        operatorPayload,
      );

      expect(prisma.orderRevision.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ revisionNumber: 1 }) }),
      );
    });

    it("findOne reports the edit window open for an order with no run", async () => {
      prisma.order.findUnique.mockResolvedValue({ ...MOCK_ORDER, routeRun: null, revisions: [] });
      const result: any = await service.findOne("ord-1", operatorPayload);
      expect(result.editWindow).toEqual({
        editable: true,
        editableUntil: null,
        closedReason: null,
      });
    });

    it("findOne keeps the edit window OPEN even once the run has dispatched (R1)", async () => {
      prisma.order.findUnique.mockResolvedValue({
        ...MOCK_ORDER,
        routeRun: { status: "IN_PROGRESS", startedAt: new Date() },
        revisions: [],
      });
      const result: any = await service.findOne("ord-1", operatorPayload);
      expect(result.editWindow).toMatchObject({ editable: true, closedReason: null });
    });

    it("findOne keeps the edit window OPEN for a DELIVERED order (R1)", async () => {
      prisma.order.findUnique.mockResolvedValue({
        ...MOCK_ORDER,
        status: "DELIVERED",
        routeRun: { status: "COMPLETED", startedAt: new Date() },
        revisions: [],
      });
      const result: any = await service.findOne("ord-1", operatorPayload);
      expect(result.editWindow).toMatchObject({ editable: true, closedReason: null });
    });

    it("findOne reports the edit window CLOSED (STATUS) only for a CANCELLED order (R1)", async () => {
      prisma.order.findUnique.mockResolvedValue({
        ...MOCK_ORDER,
        status: "CANCELLED",
        routeRun: null,
        revisions: [],
      });
      const result: any = await service.findOne("ord-1", operatorPayload);
      expect(result.editWindow).toMatchObject({ editable: false, closedReason: "STATUS" });
    });

    it("reverts a NON-dispatched CONFIRMED order to PENDING on edit (re-confirm the pick list)", async () => {
      prisma.order.findUnique.mockResolvedValue(
        confirmedOrder({ status: "SCHEDULED", startedAt: null }),
      );
      prisma.orderItem.findMany.mockResolvedValue([
        { id: "li-1", productId: "prod-1", qty: 3, unitPrice: 5, subtotal: 15, status: "PENDING" },
      ]);
      prisma.orderRevision.aggregate.mockResolvedValue({ _max: { revisionNumber: null } });

      await service.updateOrderItems(
        "ord-1",
        { items: [{ id: "li-1", action: "UPDATE", qty: 3, unitPrice: 5 }] },
        operatorPayload,
      );
      expect(mockGateway.emitOrderStatusChanged).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ status: "PENDING" }),
      );
    });

    it("edits a DELIVERED order in place: resyncs invoices, no revert, no throw-on-payment (R1)", async () => {
      prisma.order.findUnique.mockResolvedValue({
        ...confirmedOrder({ status: "COMPLETED", startedAt: new Date() }),
        status: "DELIVERED",
      });
      prisma.orderItem.findMany.mockResolvedValue([
        { id: "li-1", productId: "prod-1", qty: 3, unitPrice: 5, subtotal: 15, status: "PENDING" },
      ]);
      prisma.orderRevision.aggregate.mockResolvedValue({ _max: { revisionNumber: null } });

      await service.updateOrderItems(
        "ord-1",
        { items: [{ id: "li-1", action: "UPDATE", qty: 3, unitPrice: 5 }] },
        operatorPayload,
      );

      // Post-delivery: the in-place invoice+ledger resync runs (NOT the open-draft
      // reconcile), and the throw-on-payment pre-mutation revert is skipped.
      expect(invoicesService.resyncOrderInvoicesForEdit).toHaveBeenCalledWith("ord-1");
      expect(invoicesService.reconcileOrderDraftInvoice).not.toHaveBeenCalled();
      expect(invoicesService.revertLinkedInvoicesForOrderEdit).not.toHaveBeenCalled();
      // Delivered orders are edited in place — never reverted to PENDING.
      expect(mockGateway.emitOrderStatusChanged).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ status: "PENDING" }),
      );
    });

    it("SKIPS the in-place resync when the DELIVERED order is PARTIALLY invoiced (no over-bill)", async () => {
      prisma.order.findUnique.mockResolvedValue({
        ...confirmedOrder({ status: "COMPLETED", startedAt: new Date() }),
        status: "DELIVERED",
        lineItems: [
          {
            id: "li-1",
            orderId: "ord-1",
            productId: "prod-1",
            qty: 10,
            invoicedQty: 6, // a partial invoice billed 6 of 10 — remainder un-invoiced
            unitPrice: 5,
            subtotal: 50,
            status: "PENDING",
            boxes: null,
            pieces: null,
            priceType: "STANDARD",
            originalPrice: null,
          },
        ],
      });
      prisma.orderItem.findMany.mockResolvedValue([
        { id: "li-1", productId: "prod-1", qty: 10, unitPrice: 5, subtotal: 50, status: "PENDING" },
      ]);
      prisma.orderRevision.aggregate.mockResolvedValue({ _max: { revisionNumber: null } });

      await service.updateOrderItems(
        "ord-1",
        { items: [{ id: "li-1", action: "UPDATE", qty: 10, unitPrice: 6 }] },
        operatorPayload,
      );

      // Rebuilding a partially-billed finalized invoice at the full order qty would
      // inflate an already-issued document → the resync is skipped entirely (the edit
      // still applies to the order; the operator reconciles the partial invoices).
      expect(invoicesService.resyncOrderInvoicesForEdit).not.toHaveBeenCalled();
      expect(invoicesService.reconcileOrderDraftInvoice).not.toHaveBeenCalled();
      expect(prisma.orderRevision.create).toHaveBeenCalled();
    });

    it("WP3: the partial-billing skip still settles credit notes — they're payment-level, not line-level", async () => {
      prisma.order.findUnique.mockResolvedValue({
        ...confirmedOrder({ status: "COMPLETED", startedAt: new Date() }),
        status: "DELIVERED",
        lineItems: [
          {
            id: "li-1",
            orderId: "ord-1",
            productId: "prod-1",
            qty: 10,
            invoicedQty: 6, // a partial invoice billed 6 of 10 — remainder un-invoiced
            unitPrice: 5,
            subtotal: 50,
            status: "PENDING",
            boxes: null,
            pieces: null,
            priceType: "STANDARD",
            originalPrice: null,
          },
        ],
      });
      prisma.orderItem.findMany.mockResolvedValue([
        { id: "li-1", productId: "prod-1", qty: 10, unitPrice: 5, subtotal: 50, status: "PENDING" },
      ]);
      prisma.orderRevision.aggregate.mockResolvedValue({ _max: { revisionNumber: null } });

      await service.updateOrderItems(
        "ord-1",
        {
          items: [{ id: "li-1", action: "UPDATE", qty: 10, unitPrice: 6 }],
          appliedCreditNotes: [{ creditNoteId: "cn-1" }],
        } as any,
        operatorPayload,
      );

      // The line-resync is skipped (partial billing), but the credit sync + settle
      // still runs — credits apply to invoice payments, not order lines.
      expect(invoicesService.resyncOrderInvoicesForEdit).not.toHaveBeenCalled();
      expect(creditNotesService.syncOrderCreditSelections).toHaveBeenCalledWith(
        expect.anything(),
        "ord-1",
        "cust-1",
        [{ creditNoteId: "cn-1" }],
      );
      expect(creditNotesService.settleOrderCreditsInTx).toHaveBeenCalledWith(
        expect.anything(),
        "ord-1",
      );
    });

    it("SKIPS the resync for a CROSS-LINE partial (line A fully invoiced, line B untouched)", async () => {
      // createPartialFromOrder can bill a SUBSET of LINES at full qty (A) while omitting
      // others (B): every line is then either fully-invoiced or zero-invoiced, so a
      // per-line 'invoicedQty<qty' check would miss it — the gate must be cross-line.
      prisma.order.findUnique.mockResolvedValue({
        ...confirmedOrder({ status: "COMPLETED", startedAt: new Date() }),
        status: "DELIVERED",
        lineItems: [
          {
            id: "li-a",
            orderId: "ord-1",
            productId: "prod-1",
            qty: 10,
            invoicedQty: 10,
            unitPrice: 5,
            subtotal: 50,
            status: "PENDING",
            boxes: null,
            pieces: null,
            priceType: "STANDARD",
            originalPrice: null,
          },
          {
            id: "li-b",
            orderId: "ord-1",
            productId: "prod-2",
            qty: 5,
            invoicedQty: 0,
            unitPrice: 20,
            subtotal: 100,
            status: "PENDING",
            boxes: null,
            pieces: null,
            priceType: "STANDARD",
            originalPrice: null,
          },
        ],
      });
      prisma.orderItem.findMany.mockResolvedValue([
        { id: "li-a", productId: "prod-1", qty: 10, unitPrice: 5, subtotal: 50, status: "PENDING" },
      ]);
      prisma.orderRevision.aggregate.mockResolvedValue({ _max: { revisionNumber: null } });

      await service.updateOrderItems(
        "ord-1",
        { items: [{ id: "li-a", action: "UPDATE", qty: 10, unitPrice: 6 }] },
        operatorPayload,
      );

      // Some line invoiced but not ALL fully invoiced → partial → resync skipped.
      expect(invoicesService.resyncOrderInvoicesForEdit).not.toHaveBeenCalled();
      expect(invoicesService.reconcileOrderDraftInvoice).not.toHaveBeenCalled();
    });
  });

  // ─── P5-08b: credit-limit + stock inline guards on edit ────────────────────

  describe("updateOrderItems — credit-limit guard (P5-08b)", () => {
    // PENDING order (guards skip DRAFT), no run (edit window open), one line
    // qty 2 @ $5. The merge edit below moves it to qty 3 → recompute stub says
    // subtotal 15; tax rate is 0 in tests → projected total = 15.
    const editableOrder = () => ({
      ...MOCK_ORDER,
      status: "PENDING" as const,
      routeRun: null,
      lineItems: [
        {
          id: "li-1",
          orderId: "ord-1",
          productId: "prod-1",
          qty: 2,
          unitPrice: 5,
          subtotal: 10,
          status: "PENDING",
          boxes: null,
          pieces: null,
        },
      ],
    });
    const editDto = { items: [{ id: "li-1", action: "UPDATE" as const, qty: 3, unitPrice: 5 }] };
    const postEditItems = [
      { id: "li-1", productId: "prod-1", qty: 3, unitPrice: 5, subtotal: 15, status: "PENDING" },
    ];

    beforeEach(() => {
      prisma.order.findUnique.mockResolvedValue(editableOrder());
      prisma.orderItem.findMany.mockResolvedValue(postEditItems);
      prisma.orderRevision.aggregate.mockResolvedValue({ _max: { revisionNumber: null } });
    });

    it("creditLimit null → no limit: passes without querying exposure", async () => {
      prisma.customer.findUnique.mockResolvedValue({ creditLimit: null });

      await service.updateOrderItems("ord-1", editDto, operatorPayload);

      expect(prisma.invoice.findMany).not.toHaveBeenCalled();
      expect(prisma.order.update).toHaveBeenCalled();
    });

    it("under the limit passes (exposure = open invoice balance + projected total)", async () => {
      prisma.customer.findUnique.mockResolvedValue({ creditLimit: 100 });
      prisma.invoice.findMany.mockResolvedValue([
        { total: 50, orderId: null, payments: [{ amount: 20 }] }, // balance 30
      ]);
      prisma.order.findMany.mockResolvedValue([]);

      await service.updateOrderItems("ord-1", editDto, operatorPayload);

      // 30 + 15 = 45 ≤ 100
      expect(prisma.order.update).toHaveBeenCalled();
      expect(prisma.orderRevision.create).toHaveBeenCalled();
    });

    it("over the limit blocks ALL roles and persists nothing (409 CREDIT_LIMIT_EXCEEDED)", async () => {
      prisma.customer.findFirst.mockResolvedValue({ creditLimit: 100 });
      prisma.invoice.findMany.mockResolvedValue([
        { total: 200, orderId: null, payments: [{ amount: 80 }] }, // balance 120
      ]);
      prisma.order.findMany.mockResolvedValue([]);

      await expect(
        service.updateOrderItems("ord-1", editDto, operatorPayload),
      ).rejects.toMatchObject({
        response: { code: "CREDIT_LIMIT_EXCEEDED", limit: 100, exposure: 135 }, // 120 + 15
      });

      // Guard throws inside the transaction, before the header write; the
      // post-transaction reconcile + revision never run.
      expect(prisma.order.update).not.toHaveBeenCalled();
      expect(prisma.orderRevision.create).not.toHaveBeenCalled();
      expect(invoicesService.reconcileOrderDraftInvoice).not.toHaveBeenCalled();
    });

    it("credit-limit guard receives the fee-inclusive projected total (order carries a stored shippingFee)", async () => {
      prisma.order.findUnique.mockResolvedValue({ ...editableOrder(), shippingFee: 5 });
      prisma.customer.findFirst.mockResolvedValue({ creditLimit: 100 });
      prisma.invoice.findMany.mockResolvedValue([
        { total: 200, orderId: null, payments: [{ amount: 80 }] }, // balance 120
      ]);
      prisma.order.findMany.mockResolvedValue([]);

      // Projected total = 15 (edited subtotal) + 5 (stored fee) = 20; exposure = 120 + 20 = 140.
      await expect(
        service.updateOrderItems("ord-1", editDto, operatorPayload),
      ).rejects.toMatchObject({
        response: { code: "CREDIT_LIMIT_EXCEEDED", limit: 100, exposure: 140 },
      });
    });

    it("excludes the edited order from exposure (its mirror invoice AND its order row)", async () => {
      prisma.customer.findUnique.mockResolvedValue({ creditLimit: 100 });
      // Both rows belong to the order being edited — must not count; the
      // projected total (15) represents it instead.
      prisma.invoice.findMany.mockResolvedValue([{ total: 500, orderId: "ord-1", payments: [] }]);
      prisma.order.findMany.mockResolvedValue([{ id: "ord-1", total: 500 }]);

      await service.updateOrderItems("ord-1", editDto, operatorPayload); // 15 ≤ 100

      expect(prisma.order.update).toHaveBeenCalled();
    });

    it("nets partial payments off an open invoice (partially-paid handling)", async () => {
      prisma.customer.findUnique.mockResolvedValue({ creditLimit: 100 });
      prisma.invoice.findMany.mockResolvedValue([
        { total: 90, orderId: null, payments: [{ amount: 60 }, { amount: 10 }] }, // balance 20
      ]);
      prisma.order.findMany.mockResolvedValue([]);

      await service.updateOrderItems("ord-1", editDto, operatorPayload); // 20 + 15 = 35

      expect(prisma.order.update).toHaveBeenCalled();
    });

    it("ignores VOID (bounced) payments when netting exposure — a bounce cannot slip under the limit", async () => {
      prisma.customer.findFirst.mockResolvedValue({ creditLimit: 100 });
      prisma.invoice.findMany.mockResolvedValue([
        {
          total: 120,
          orderId: null,
          // A $120 check bounced → VOID (must NOT reduce exposure); a real $20 remains.
          payments: [
            { amount: 120, status: "VOID" },
            { amount: 20, status: "PAID" },
          ],
        },
      ]);
      prisma.order.findMany.mockResolvedValue([]);

      // Real balance = 120 − 20 = 100 (VOID ignored) + projected 15 = 115 > 100 → block.
      // If the VOID counted as paid, balance would be −20 and the edit would wrongly pass.
      await expect(
        service.updateOrderItems("ord-1", editDto, operatorPayload),
      ).rejects.toMatchObject({
        response: { code: "CREDIT_LIMIT_EXCEEDED", limit: 100, exposure: 115 },
      });
      expect(prisma.order.update).not.toHaveBeenCalled();
    });

    it("exposure exactly at the limit passes; one cent over blocks", async () => {
      prisma.customer.findFirst.mockResolvedValue({ creditLimit: 100 });
      prisma.order.findMany.mockResolvedValue([]);

      prisma.invoice.findMany.mockResolvedValue([
        { total: 85, orderId: null, payments: [] }, // 85 + 15 = 100 → not over
      ]);
      await service.updateOrderItems("ord-1", editDto, operatorPayload);
      expect(prisma.order.update).toHaveBeenCalled();

      jest.clearAllMocks();
      prisma.order.findUnique.mockResolvedValue(editableOrder());
      prisma.orderItem.findMany.mockResolvedValue(postEditItems);
      prisma.orderRevision.aggregate.mockResolvedValue({ _max: { revisionNumber: null } });
      prisma.customer.findFirst.mockResolvedValue({ creditLimit: 100 });
      prisma.order.findMany.mockResolvedValue([]);
      prisma.invoice.findMany.mockResolvedValue([
        { total: 85.01, orderId: null, payments: [] }, // 100.01 → over
      ]);
      await expect(
        service.updateOrderItems("ord-1", editDto, operatorPayload),
      ).rejects.toMatchObject({ response: { code: "CREDIT_LIMIT_EXCEEDED", exposure: 100.01 } });
    });

    it("does NOT double-count an open order that already has an open mirror invoice", async () => {
      // ord-2 appears as BOTH an open invoice (40) and an open order (40):
      // exposure must be 40 + 30 + 15 = 85, not 125.
      prisma.customer.findUnique.mockResolvedValue({ creditLimit: 90 });
      prisma.invoice.findMany.mockResolvedValue([{ total: 40, orderId: "ord-2", payments: [] }]);
      prisma.order.findMany.mockResolvedValue([
        { id: "ord-2", total: 40 },
        { id: "ord-3", total: 30 },
      ]);

      await service.updateOrderItems("ord-1", editDto, operatorPayload); // 85 ≤ 90
      expect(prisma.order.update).toHaveBeenCalled();
    });

    it("blocks a CUSTOMER edit over the limit (buyer replace path)", async () => {
      // customer.findFirst now serves the ownership check (where.userId), the
      // buyerTierCtx pricingTier read, and the guard's creditLimit read (both where.id).
      prisma.customer.findFirst.mockImplementation(({ where }: any) =>
        Promise.resolve(where?.id ? { pricingTier: 1, creditLimit: 10 } : { id: "cust-1" }),
      );
      prisma.product.findMany.mockResolvedValue([
        { ...MOCK_PRODUCT, id: "prod-1", unitsPerBox: null },
      ]);
      prisma.customerPrice.findMany.mockResolvedValue([]);
      prisma.invoice.findMany.mockResolvedValue([]);
      prisma.order.findMany.mockResolvedValue([]);

      await expect(
        service.updateOrderItems(
          "ord-1",
          { items: [{ productId: "prod-1", qty: 3 }] },
          customerPayload,
        ),
      ).rejects.toMatchObject({ response: { code: "CREDIT_LIMIT_EXCEEDED" } });
      expect(prisma.order.update).not.toHaveBeenCalled();
    });

    it("skips both guards entirely on a DRAFT order", async () => {
      prisma.order.findUnique.mockResolvedValue({ ...editableOrder(), status: "DRAFT" });
      // Would block if the guard ran:
      prisma.customer.findUnique.mockResolvedValue({ creditLimit: 0.01 });

      await service.updateOrderItems("ord-1", editDto, operatorPayload);

      expect(prisma.invoice.findMany).not.toHaveBeenCalled();
      expect(prisma.order.update).toHaveBeenCalled();
    });
  });

  describe("assertWithinCreditLimit — flag.credit_limits plan-flag gate (WP3)", () => {
    const ORIGINAL_ENV = process.env;

    // Same PENDING/qty-3/$5 fixture as the P5-08b block above, primed to land
    // OVER a $100 limit: exposure = 120 (open invoice balance) + 15 (projected) = 135.
    const editableOrder = () => ({
      ...MOCK_ORDER,
      status: "PENDING" as const,
      routeRun: null,
      lineItems: [
        {
          id: "li-1",
          orderId: "ord-1",
          productId: "prod-1",
          qty: 2,
          unitPrice: 5,
          subtotal: 10,
          status: "PENDING",
          boxes: null,
          pieces: null,
        },
      ],
    });
    const editDto = { items: [{ id: "li-1", action: "UPDATE" as const, qty: 3, unitPrice: 5 }] };
    const postEditItems = [
      { id: "li-1", productId: "prod-1", qty: 3, unitPrice: 5, subtotal: 15, status: "PENDING" },
    ];

    let loggerError: jest.SpyInstance;

    beforeEach(() => {
      process.env = { ...ORIGINAL_ENV };
      delete process.env.PLAN_FLAG_ENFORCEMENT;
      // the resolution-failure case logs; keep the suite output clean
      loggerError = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
      prisma.order.findUnique.mockResolvedValue(editableOrder());
      prisma.orderItem.findMany.mockResolvedValue(postEditItems);
      prisma.orderRevision.aggregate.mockResolvedValue({ _max: { revisionNumber: null } });
      prisma.customer.findFirst.mockResolvedValue({ creditLimit: 100 });
      prisma.invoice.findMany.mockResolvedValue([
        { total: 200, orderId: null, payments: [{ amount: 80 }] }, // balance 120
      ]);
      prisma.order.findMany.mockResolvedValue([]);
    });

    afterEach(() => {
      process.env = ORIGINAL_ENV;
      loggerError.mockRestore();
    });

    it("PLAN_FLAG_ENFORCEMENT off (kill switch dark) → legacy behavior: check always runs, over-limit order rejected", async () => {
      // Even a mock configured to deny must never be consulted — off short-circuits first.
      entitlementsService.hasFlag.mockResolvedValue(false);

      await expect(
        service.updateOrderItems("ord-1", editDto, operatorPayload),
      ).rejects.toMatchObject({
        response: { code: "CREDIT_LIMIT_EXCEEDED", limit: 100, exposure: 135 },
      });
      expect(entitlementsService.hasFlag).not.toHaveBeenCalled();
      expect(prisma.order.update).not.toHaveBeenCalled();
    });

    it("PLAN_FLAG_ENFORCEMENT on + flag absent → check is skipped: over-limit order passes", async () => {
      process.env.PLAN_FLAG_ENFORCEMENT = "on";
      entitlementsService.hasFlag.mockResolvedValue(false);

      await service.updateOrderItems("ord-1", editDto, operatorPayload);

      expect(entitlementsService.hasFlag).toHaveBeenCalledWith("test-tenant", "flag.credit_limits");
      expect(prisma.order.update).toHaveBeenCalled();
    });

    it("PLAN_FLAG_ENFORCEMENT on + flag present → check still runs: over-limit order rejected", async () => {
      process.env.PLAN_FLAG_ENFORCEMENT = "on";
      entitlementsService.hasFlag.mockResolvedValue(true);

      await expect(
        service.updateOrderItems("ord-1", editDto, operatorPayload),
      ).rejects.toMatchObject({
        response: { code: "CREDIT_LIMIT_EXCEEDED", limit: 100, exposure: 135 },
      });
      expect(entitlementsService.hasFlag).toHaveBeenCalledWith("test-tenant", "flag.credit_limits");
      expect(prisma.order.update).not.toHaveBeenCalled();
    });

    it("PLAN_FLAG_ENFORCEMENT on + entitlement resolution THROWS → degrades to the legacy check, not a failed edit", async () => {
      // EntitlementsService.compute throws on a missing tenant row, and
      // PlanCatalogService.getVersionForTenant throws when no catalog is published.
      // The credit guard runs inside the edit transaction, so that must NOT
      // surface as a rolled-back edit reporting a billing-catalog error.
      process.env.PLAN_FLAG_ENFORCEMENT = "on";
      entitlementsService.hasFlag.mockRejectedValue(
        new NotFoundException("No published plan catalog exists. Seed the billing catalog first."),
      );

      await expect(
        service.updateOrderItems("ord-1", editDto, operatorPayload),
      ).rejects.toMatchObject({
        response: { code: "CREDIT_LIMIT_EXCEEDED", limit: 100, exposure: 135 },
      });
      expect(prisma.order.update).not.toHaveBeenCalled();
    });
  });

  describe("updateOrderItems — stock guard + settle (P5-08b + WP1, delta-based)", () => {
    // PENDING order already holding qty 5 of prod-1 (create() decremented that
    // 5 from currentStock at order time — only INCREASES need coverage).
    const stockOrder = () => ({
      ...MOCK_ORDER,
      status: "PENDING" as const,
      routeRun: null,
      lineItems: [
        {
          id: "li-1",
          orderId: "ord-1",
          productId: "prod-1",
          qty: 5,
          unitPrice: 5,
          subtotal: 25,
          status: "PENDING",
          boxes: null,
          pieces: null,
        },
      ],
    });

    // WP1/F2: the settle no longer derives the PRE-edit qtys from the pre-tx
    // `order.lineItems` — it consumes a snapshot read INSIDE the transaction
    // (after the order row is locked), which is the only read in the path that
    // selects `deliveredQty`. Route THAT read to the order's held lines and
    // let every other orderItem.findMany (the hoisted price-history read, the
    // post-edit totals recompute) return whatever the test stubs via
    // `setPostEditItems`. Stubbing both from one mockResolvedValue would make
    // held === requested and silently neuter every case in this block.
    const heldSnapshot = [{ productId: "prod-1", qty: 5, deliveredQty: 0, status: "PENDING" }];
    let postEditItems: any[] = [];
    const setPostEditItems = (items: any[]) => {
      postEditItems = items;
    };

    beforeEach(() => {
      prisma.order.findUnique.mockResolvedValue(stockOrder());
      prisma.orderRevision.aggregate.mockResolvedValue({ _max: { revisionNumber: null } });
      // Credit guard stays inert in this block:
      prisma.customer.findUnique.mockResolvedValue({ pricingTier: 1, creditLimit: null });
      prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
      prisma.customerPrice.findMany.mockResolvedValue([]);
      postEditItems = [];
      prisma.orderItem.findMany.mockImplementation((args: any) =>
        Promise.resolve(args?.select?.deliveredQty ? heldSnapshot : postEditItems),
      );
    });

    it("blocks a CUSTOMER increase beyond available stock (delta 3 > available 2)", async () => {
      prisma.product.findMany.mockResolvedValue([
        { ...MOCK_PRODUCT, id: "prod-1", currentStock: 2, unitsPerBox: null },
      ]);
      setPostEditItems([
        { id: "li-1", productId: "prod-1", qty: 8, unitPrice: 5, subtotal: 40, status: "PENDING" },
      ]);

      await expect(
        service.updateOrderItems(
          "ord-1",
          { items: [{ productId: "prod-1", qty: 8 }] },
          customerPayload,
        ),
      ).rejects.toMatchObject({
        response: { code: "INSUFFICIENT_STOCK", productId: "prod-1", available: 2, requested: 8 },
      });
      expect(prisma.order.update).not.toHaveBeenCalled();
      expect(prisma.orderRevision.create).not.toHaveBeenCalled();
    });

    it("checks the DELTA, not the absolute qty: 5 → 8 passes with only 3 in stock", async () => {
      prisma.product.findMany.mockResolvedValue([
        { ...MOCK_PRODUCT, id: "prod-1", currentStock: 3, unitsPerBox: null },
      ]);
      setPostEditItems([
        { id: "li-1", productId: "prod-1", qty: 8, unitPrice: 5, subtotal: 40, status: "PENDING" },
      ]);

      await service.updateOrderItems(
        "ord-1",
        { items: [{ productId: "prod-1", qty: 8 }] },
        customerPayload,
      );
      expect(prisma.order.update).toHaveBeenCalled();
    });

    it("never false-blocks a same-qty edit when the shelf is empty (delta 0, stock 0)", async () => {
      // The order's own creation emptied the shelf; re-saving qty 5 must pass
      // and must not even query product stock.
      prisma.product.findMany.mockResolvedValue([
        { ...MOCK_PRODUCT, id: "prod-1", currentStock: 0, unitsPerBox: null },
      ]);
      setPostEditItems([
        { id: "li-1", productId: "prod-1", qty: 5, unitPrice: 5, subtotal: 25, status: "PENDING" },
      ]);

      await service.updateOrderItems(
        "ord-1",
        { items: [{ productId: "prod-1", qty: 5 }] },
        customerPayload,
      );
      expect(prisma.order.update).toHaveBeenCalled();
    });

    it("a NEW line needs full coverage (held 0): qty 4 vs stock 3 blocks", async () => {
      prisma.product.findMany.mockResolvedValue([
        { ...MOCK_PRODUCT, id: "prod-1", currentStock: 99, unitsPerBox: null },
        { ...MOCK_PRODUCT, id: "prod-2", name: "Basil", currentStock: 3, unitsPerBox: null },
      ]);
      setPostEditItems([
        { id: "li-1", productId: "prod-1", qty: 5, unitPrice: 5, subtotal: 25, status: "PENDING" },
        { id: "li-2", productId: "prod-2", qty: 4, unitPrice: 2, subtotal: 8, status: "PENDING" },
      ]);

      await expect(
        service.updateOrderItems(
          "ord-1",
          {
            items: [
              { productId: "prod-1", qty: 5 },
              { productId: "prod-2", qty: 4 },
            ],
          },
          customerPayload,
        ),
      ).rejects.toMatchObject({
        response: { code: "INSUFFICIENT_STOCK", productId: "prod-2", available: 3, requested: 4 },
      });
    });

    it("operator over-stock increase WARNS and passes (may oversell, matches create())", async () => {
      const warnSpy = jest.spyOn((service as any).logger, "warn").mockImplementation();
      prisma.product.findMany.mockResolvedValue([
        { ...MOCK_PRODUCT, id: "prod-1", currentStock: 1, unitsPerBox: null },
      ]);
      setPostEditItems([
        {
          id: "li-1",
          productId: "prod-1",
          qty: 50,
          unitPrice: 5,
          subtotal: 250,
          status: "PENDING",
        },
      ]);

      await service.updateOrderItems(
        "ord-1",
        { items: [{ id: "li-1", action: "UPDATE", qty: 50, unitPrice: 5 }] },
        operatorPayload,
      );

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("below stock"));
      expect(prisma.order.update).toHaveBeenCalled();
      expect(prisma.orderRevision.create).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it("WP1: an increase is no longer validate-only — the delta is decremented from currentStock", async () => {
      // held 5 (stockOrder's existing line) → requested 8 → delta 3 written.
      // This test previously asserted the OPPOSITE (validate-only, never
      // decrements) — that was the exact defect WP1 fixes: an edit that
      // increases a boxed line's qty validated against stock but never
      // touched it, so an edit could sell inventory that create()'s
      // decrement-on-order-time accounting never reflected.
      prisma.product.findMany.mockResolvedValue([
        { ...MOCK_PRODUCT, id: "prod-1", currentStock: 100, unitsPerBox: null },
      ]);
      setPostEditItems([
        { id: "li-1", productId: "prod-1", qty: 8, unitPrice: 5, subtotal: 40, status: "PENDING" },
      ]);

      await service.updateOrderItems(
        "ord-1",
        { items: [{ productId: "prod-1", qty: 8 }] },
        customerPayload,
      );

      expect(prisma.product.update).toHaveBeenCalledWith({
        where: { id: "prod-1" },
        data: { currentStock: { decrement: 3 } },
      });
    });
  });

  // ─── WP1: settleStockForEdit — applies stock deltas over the union ────────
  //
  // Called directly (same pattern as the linePieceQty specs below) rather
  // than threaded through updateOrderItems/approveChangeRequestAtStop: those
  // callers exercise plenty of unrelated pricing/promo/invoice machinery to
  // reach this guard, which would make each case's exact qty numbers fragile
  // to unrelated changes elsewhere in the edit path. A fake `db` with just
  // $executeRaw + product.findMany/update isolates the settle contract itself.
  describe("WP1 settleStockForEdit — applies deltas over the union (validate THEN write)", () => {
    let fakeDb: {
      $executeRaw: jest.Mock;
      product: { findMany: jest.Mock; update: jest.Mock };
    };

    // WP1/F2: settle takes the PRE-edit lines as their own argument — the
    // callers now snapshot them inside their transaction (post order-row
    // lock) instead of reusing the pre-transaction order.lineItems.
    const settle = (order: any, finalActiveItems: any[], user?: any) =>
      (service as any).settleStockForEdit(
        fakeDb,
        order,
        order.lineItems ?? [],
        finalActiveItems,
        user,
      );

    const orderWith = (lineItems: any[], status = "PENDING") => ({
      id: "ord-1",
      status,
      lineItems,
    });

    beforeEach(() => {
      fakeDb = {
        $executeRaw: jest.fn().mockResolvedValue(0),
        product: {
          findMany: jest.fn().mockResolvedValue([]),
          update: jest.fn().mockResolvedValue({}),
        },
      };
    });

    it("(a) increase 1→3 boxes (qty 12→36) decrements 24", async () => {
      fakeDb.product.findMany.mockResolvedValue([
        { id: "prod-box", name: "Water Case", currentStock: 500 },
      ]);
      const order = orderWith([{ productId: "prod-box", qty: 12, status: "PENDING" }]);

      await settle(order, [{ productId: "prod-box", qty: 36 }], operatorPayload);

      expect(fakeDb.product.update).toHaveBeenCalledWith({
        where: { id: "prod-box" },
        data: { currentStock: { decrement: 24 } },
      });
    });

    it("(b) decrease 3→1 boxes (qty 36→12) increments 24 back", async () => {
      fakeDb.product.findMany.mockResolvedValue([
        { id: "prod-box", name: "Water Case", currentStock: 500 },
      ]);
      const order = orderWith([{ productId: "prod-box", qty: 36, status: "PENDING" }]);

      await settle(order, [{ productId: "prod-box", qty: 12 }], operatorPayload);

      expect(fakeDb.product.update).toHaveBeenCalledWith({
        where: { id: "prod-box" },
        data: { currentStock: { increment: 24 } },
      });
    });

    it("(c) a removed line returns its full held qty", async () => {
      const order = orderWith([{ productId: "prod-1", qty: 10, status: "PENDING" }]);

      // The product no longer appears in the post-edit active set at all.
      await settle(order, [], operatorPayload);

      expect(fakeDb.product.update).toHaveBeenCalledWith({
        where: { id: "prod-1" },
        data: { currentStock: { increment: 10 } },
      });
    });

    it("(d) an added line decrements its full requested qty", async () => {
      fakeDb.product.findMany.mockResolvedValue([
        { id: "prod-2", name: "Basil", currentStock: 500 },
      ]);
      const order = orderWith([]); // held nothing

      await settle(order, [{ productId: "prod-2", qty: 7 }], operatorPayload);

      expect(fakeDb.product.update).toHaveBeenCalledWith({
        where: { id: "prod-2" },
        data: { currentStock: { decrement: 7 } },
      });
    });

    it("(e) a DRAFT order's edit writes nothing (no validation, no query, no write)", async () => {
      const order = orderWith([{ productId: "prod-1", qty: 5, status: "PENDING" }], "DRAFT");

      await settle(order, [{ productId: "prod-1", qty: 20 }], operatorPayload);

      expect(fakeDb.$executeRaw).not.toHaveBeenCalled();
      expect(fakeDb.product.findMany).not.toHaveBeenCalled();
      expect(fakeDb.product.update).not.toHaveBeenCalled();
    });

    it("(f) non-staff increase beyond stock throws INSUFFICIENT_STOCK and writes nothing", async () => {
      fakeDb.product.findMany.mockResolvedValue([
        { id: "prod-1", name: "Tomatoes", currentStock: 2 },
      ]);
      const order = orderWith([{ productId: "prod-1", qty: 5, status: "PENDING" }]);

      await expect(
        settle(order, [{ productId: "prod-1", qty: 10 }], customerPayload),
      ).rejects.toMatchObject({
        response: { code: "INSUFFICIENT_STOCK", productId: "prod-1", available: 2, requested: 10 },
      });
      expect(fakeDb.product.update).not.toHaveBeenCalled();
    });

    it("(g) staff increase beyond stock warns and the write still proceeds (stock goes negative)", async () => {
      const warnSpy = jest.spyOn((service as any).logger, "warn").mockImplementation();
      fakeDb.product.findMany.mockResolvedValue([
        { id: "prod-1", name: "Tomatoes", currentStock: 2 },
      ]);
      const order = orderWith([{ productId: "prod-1", qty: 5, status: "PENDING" }]);

      await settle(order, [{ productId: "prod-1", qty: 10 }], operatorPayload);

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("below stock"));
      expect(fakeDb.product.update).toHaveBeenCalledWith({
        where: { id: "prod-1" },
        data: { currentStock: { decrement: 5 } },
      });
      warnSpy.mockRestore();
    });

    it("(h) unchanged lines produce zero product.update calls (and never query stock)", async () => {
      const order = orderWith([{ productId: "prod-1", qty: 5, status: "PENDING" }]);

      await settle(order, [{ productId: "prod-1", qty: 5 }], operatorPayload);

      expect(fakeDb.product.findMany).not.toHaveBeenCalled();
      expect(fakeDb.product.update).not.toHaveBeenCalled();
    });

    // F1: a negative delta credits back only the UNDELIVERED remainder.
    // Delivered goods physically left the warehouse — the at-door path refuses
    // such an edit outright (LINE_ALREADY_DELIVERED); the operator edit path
    // allows it but must not invent inventory by crediting delivered units.
    it("(i) a FULLY delivered line removed writes nothing — delivered goods never come back", async () => {
      const order = orderWith([
        { productId: "prod-box", qty: 24, deliveredQty: 24, status: "PENDING" },
      ]);

      await settle(order, [], operatorPayload);

      expect(fakeDb.product.update).not.toHaveBeenCalled();
    });

    it("(j) a PARTIALLY delivered line (24, of which 10 delivered) reduced to 0 credits back exactly 14", async () => {
      const order = orderWith([
        { productId: "prod-box", qty: 24, deliveredQty: 10, status: "PENDING" },
      ]);

      await settle(order, [], operatorPayload);

      expect(fakeDb.product.update).toHaveBeenCalledTimes(1);
      expect(fakeDb.product.update).toHaveBeenCalledWith({
        where: { id: "prod-box" },
        data: { currentStock: { increment: 14 } },
      });
    });
  });

  // ─── P5-09: approveChangeRequestAtStop (approve-merge money path) ──────────

  describe("approveChangeRequestAtStop (P5-09)", () => {
    const driverPayload = {
      sub: "user-drv",
      username: "driver1",
      role: "DRIVER" as const,
      status: "ACTIVE" as const,
      forcePasswordChange: false,
    };

    const baseCr = (overrides: Record<string, any> = {}) => ({
      id: "cr-1",
      tenantId: "test-tenant",
      orderId: "ord-1",
      orderItemId: null,
      productId: null,
      routeRunStopId: "stop-1",
      type: "CHANGE_QTY",
      status: "PENDING",
      payload: {},
      note: null,
      requestedById: "user-cust",
      requestedByName: "Buyer Co",
      requestedByRole: "CUSTOMER",
      ...overrides,
    });

    const baseOrder = (lineItems: any[], overrides: Record<string, any> = {}) => ({
      id: "ord-1",
      customerId: "cust-1",
      orderNumber: "ORD-123",
      status: "OUT_FOR_DELIVERY",
      subtotal: 24,
      tax: 0,
      total: 24,
      routeRunId: "run-1",
      routeRunStopId: "stop-1",
      lineItems,
      routeRun: { id: "run-1", status: "IN_PROGRESS", driverId: "drv-1" },
      routeRunStop: { id: "stop-1", status: "PENDING" },
      ...overrides,
    });

    beforeEach(() => {
      prisma.changeRequest.updateMany.mockResolvedValue({ count: 1 });
      prisma.customer.findUnique.mockResolvedValue({ creditLimit: null, pricingTier: 1 });
      prisma.orderRevision.aggregate.mockResolvedValue({ _max: { revisionNumber: null } });
    });

    it("CHANGE_QTY boxed proration: 24 -> 18 on a 12-per-box line prices via computeLineSubtotal, not qty*unitPrice", async () => {
      const line = {
        id: "li-1",
        orderId: "ord-1",
        productId: "prod-1",
        qty: 24,
        boxes: 2,
        pieces: 0,
        unitsPerBox: 12,
        unitPrice: 24,
        subtotal: 48,
        status: "PENDING",
        deliveredQty: 0,
      };
      prisma.changeRequest.findUnique.mockResolvedValue(
        baseCr({
          type: "CHANGE_QTY",
          orderItemId: "li-1",
          payload: { orderItemId: "li-1", newQty: 18 },
        }),
      );
      prisma.order.findUnique.mockResolvedValue(baseOrder([line]));
      // B135: the priced inputs come from the LOCKED re-read of the held row (an empty re-read
      // now refuses rather than falling back to this snapshot).
      prisma.orderItem.findUnique.mockResolvedValue(line);
      prisma.orderItem.findMany.mockResolvedValue([
        {
          id: "li-1",
          productId: "prod-1",
          qty: 18,
          unitPrice: 24,
          subtotal: 36,
          status: "PENDING",
          trackedCategoryId: null,
        },
      ]);

      await service.approveChangeRequestAtStop("cr-1", operatorPayload, null);

      // 24 * (1 box + 6/12) = 36.00 — NOT 18 * 24 = 432.
      expect(prisma.orderItem.update).toHaveBeenCalledWith({
        where: { id: "li-1" },
        data: { qty: 18, boxes: 1, pieces: 6, unitsPerBox: 12, subtotal: 36 },
      });
    });

    it("ADD_ITEM onto an existing line keeps the line's stored (agreed) unitPrice", async () => {
      const line = {
        id: "li-1",
        orderId: "ord-1",
        productId: "prod-1",
        qty: 10,
        boxes: null,
        pieces: null,
        unitsPerBox: null,
        unitPrice: 8.5,
        subtotal: 85,
        status: "PENDING",
        deliveredQty: 0,
      };
      prisma.changeRequest.findUnique.mockResolvedValue(
        baseCr({
          type: "ADD_ITEM",
          productId: "prod-1",
          payload: {
            productId: "prod-1",
            qty: 5,
            boxes: null,
            pieces: null,
            productName: "Widget",
          },
        }),
      );
      prisma.order.findUnique.mockResolvedValue(baseOrder([line]));
      // Catalog price moved to 10 — the merge must NOT re-price the agreed line.
      const catalogProduct = {
        id: "prod-1",
        name: "Widget",
        pricePerUnit: 10,
        unitsPerBox: null,
        category: null,
        trackedCategoryId: null,
      };
      prisma.product.findUnique.mockResolvedValue(catalogProduct); // in-tx ADD_ITEM price read
      prisma.product.findFirst.mockResolvedValue(catalogProduct); // pre-tx regulated guard read
      prisma.orderItem.findMany
        .mockResolvedValueOnce([]) // getCustomerPriceHistory (hoisted, pre-tx)
        .mockResolvedValue([
          {
            id: "li-1",
            productId: "prod-1",
            qty: 15,
            unitPrice: 8.5,
            subtotal: 127.5,
            status: "PENDING",
            deliveredQty: 0,
            trackedCategoryId: null,
          },
        ]);
      // B135: the ADD_ITEM merge target comes from the locked held row, then its authoritative
      // qty/price is re-read through the tx.
      prisma.orderItem.findUnique.mockResolvedValue(line);

      await service.approveChangeRequestAtStop("cr-1", operatorPayload, null);

      expect(prisma.orderItem.update).toHaveBeenCalledWith({
        where: { id: "li-1" },
        data: { qty: 15, boxes: null, pieces: null, unitsPerBox: null, subtotal: 127.5 },
      });
      expect(prisma.orderItem.create).not.toHaveBeenCalled();
    });

    it("ADD_ITEM new line prices through the customer's tier (resolveBuyerLinePrice) and records an ADD_ON mutation", async () => {
      prisma.changeRequest.findUnique.mockResolvedValue(
        baseCr({
          type: "ADD_ITEM",
          productId: "prod-2",
          payload: { productId: "prod-2", qty: 5, boxes: null, pieces: null, productName: "Basil" },
        }),
      );
      prisma.order.findUnique.mockResolvedValue(baseOrder([])); // no existing line for prod-2
      // Serves BOTH the buyerTier pricingTier read and the credit guard's creditLimit read.
      prisma.customer.findFirst.mockResolvedValue({ pricingTier: 2, creditLimit: null });
      const catalogProduct = {
        id: "prod-2",
        name: "Basil",
        pricePerUnit: 10,
        priceTier2: 9,
        unitsPerBox: null,
        category: null,
        trackedCategoryId: null,
      };
      prisma.product.findUnique.mockResolvedValue(catalogProduct); // in-tx ADD_ITEM price read
      prisma.product.findFirst.mockResolvedValue(catalogProduct); // pre-tx regulated guard read
      prisma.orderItem.create.mockResolvedValue({ id: "li-new" });
      prisma.orderItem.findMany
        .mockResolvedValueOnce([]) // getCustomerPriceHistory (hoisted, pre-tx)
        .mockResolvedValue([
          {
            id: "li-new",
            productId: "prod-2",
            qty: 5,
            unitPrice: 9,
            subtotal: 45,
            status: "PENDING",
            trackedCategoryId: null,
          },
        ]);

      await service.approveChangeRequestAtStop("cr-1", operatorPayload, null);

      expect(prisma.orderItem.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          orderId: "ord-1",
          productId: "prod-2",
          qty: 5,
          unitPrice: 9,
          originalPrice: 10,
          priceType: "SPECIAL",
        }),
      });
      expect(prisma.deliveryMutation.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          type: "ADD_ON",
          routeRunStopId: "stop-1",
          qty: 5,
          orderItemId: "li-new",
          productId: "prod-2",
        }),
      });
    });

    it("REMOVE_ITEM cancels the line (never hard-deletes) and records a REFUSED mutation with negative qty", async () => {
      const line = {
        id: "li-1",
        orderId: "ord-1",
        productId: "prod-1",
        qty: 10,
        boxes: null,
        pieces: null,
        unitsPerBox: null,
        unitPrice: 5,
        subtotal: 50,
        status: "PENDING",
        deliveredQty: 0,
      };
      prisma.changeRequest.findUnique.mockResolvedValue(
        baseCr({ type: "REMOVE_ITEM", orderItemId: "li-1", payload: { orderItemId: "li-1" } }),
      );
      prisma.order.findUnique.mockResolvedValue(baseOrder([line]));
      prisma.orderItem.findMany.mockResolvedValue([]); // cancelled line drops out of the active set

      await service.approveChangeRequestAtStop("cr-1", operatorPayload, null);

      expect(prisma.orderItem.update).toHaveBeenCalledWith({
        where: { id: "li-1" },
        data: {
          status: "CANCELLED",
          qty: 0,
          subtotal: 0,
          boxes: null,
          pieces: null,
          // A zeroed line has no free units left to show against it.
          promoFreeUnits: null,
        },
      });
      expect(prisma.deliveryMutation.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          type: "REFUSED",
          qty: -10,
          orderItemId: "li-1",
          productId: "prod-1",
        }),
      });
    });

    it("G6 race: a lost claim (updateMany count 0) rejects with 409 and writes nothing", async () => {
      const line = {
        id: "li-1",
        orderId: "ord-1",
        productId: "prod-1",
        qty: 10,
        boxes: null,
        pieces: null,
        unitsPerBox: null,
        unitPrice: 5,
        subtotal: 50,
        status: "PENDING",
        deliveredQty: 0,
      };
      prisma.changeRequest.findUnique.mockResolvedValue(
        baseCr({
          type: "CHANGE_QTY",
          orderItemId: "li-1",
          payload: { orderItemId: "li-1", newQty: 12 },
        }),
      );
      prisma.order.findUnique.mockResolvedValue(baseOrder([line]));
      prisma.changeRequest.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.approveChangeRequestAtStop("cr-1", operatorPayload, null),
      ).rejects.toMatchObject({ response: { code: "CHANGE_REQUEST_ALREADY_RESOLVED" } });

      expect(prisma.orderItem.update).not.toHaveBeenCalled();
      expect(prisma.orderItem.create).not.toHaveBeenCalled();
      expect(prisma.deliveryMutation.create).not.toHaveBeenCalled();
    });

    it("stock guard hard-blocks a DRIVER resolver on an ADD_ITEM that exceeds available stock", async () => {
      prisma.changeRequest.findUnique.mockResolvedValue(
        baseCr({
          type: "ADD_ITEM",
          productId: "prod-3",
          payload: { productId: "prod-3", qty: 5, boxes: null, pieces: null, productName: "Basil" },
        }),
      );
      prisma.order.findUnique.mockResolvedValue(baseOrder([])); // held 0 — a brand-new line
      const catalogProduct = {
        id: "prod-3",
        name: "Basil",
        pricePerUnit: 10,
        unitsPerBox: null,
        category: null,
        trackedCategoryId: null,
      };
      prisma.product.findUnique.mockResolvedValue(catalogProduct); // in-tx ADD_ITEM price read
      prisma.product.findFirst.mockResolvedValue(catalogProduct); // pre-tx regulated guard read
      prisma.orderItem.findMany
        .mockResolvedValueOnce([]) // getCustomerPriceHistory (hoisted, pre-tx)
        .mockResolvedValueOnce([]) // WP1/F2 in-tx held snapshot — held 0
        .mockResolvedValue([
          {
            id: "li-new",
            productId: "prod-3",
            qty: 5,
            unitPrice: 10,
            subtotal: 50,
            status: "PENDING",
            trackedCategoryId: null,
          },
        ]);
      prisma.product.findMany.mockResolvedValue([{ id: "prod-3", name: "Basil", currentStock: 1 }]);

      await expect(
        service.approveChangeRequestAtStop("cr-1", driverPayload as any, null),
      ).rejects.toMatchObject({ response: { code: "INSUFFICIENT_STOCK" } });

      expect(invoicesService.reconcileOrderDraftInvoice).not.toHaveBeenCalled();
      expect(prisma.orderRevision.create).not.toHaveBeenCalled();
      expect(prisma.product.update).not.toHaveBeenCalled();
    });

    // EXTRA-1: the at-door call site WRITES stock now. Before WP1 this path
    // only validated the delta — an approved door increase sold goods that
    // currentStock never accounted for. CHANGE_QTY keeps the reads simple:
    // no price history (ADD_ITEM only) and no BOGO snapshot, so the two in-tx
    // orderItem.findMany calls are the held snapshot then the recompute.
    it("EXTRA-1: an approved at-door qty INCREASE decrements currentStock by the delta", async () => {
      const line = {
        id: "li-1",
        orderId: "ord-1",
        productId: "prod-1",
        qty: 12,
        boxes: 1,
        pieces: 0,
        unitsPerBox: 12,
        unitPrice: 24,
        subtotal: 24,
        status: "PENDING",
        deliveredQty: 0,
      };
      prisma.changeRequest.findUnique.mockResolvedValue(
        baseCr({
          type: "CHANGE_QTY",
          orderItemId: "li-1",
          payload: { orderItemId: "li-1", newQty: 36 },
        }),
      );
      prisma.order.findUnique.mockResolvedValue(baseOrder([line]));
      prisma.orderItem.findMany
        .mockResolvedValueOnce([
          // WP1/F2 in-tx held snapshot (post order-row lock, pre-mutation).
          { productId: "prod-1", qty: 12, deliveredQty: 0, status: "PENDING" },
        ])
        .mockResolvedValue([
          {
            id: "li-1",
            productId: "prod-1",
            qty: 36,
            unitPrice: 24,
            subtotal: 72,
            status: "PENDING",
            trackedCategoryId: null,
          },
        ]);
      prisma.product.findMany.mockResolvedValue([
        { id: "prod-1", name: "Water Case", currentStock: 500 },
      ]);

      await service.approveChangeRequestAtStop("cr-1", operatorPayload, null);

      expect(prisma.product.update).toHaveBeenCalledWith({
        where: { id: "prod-1" },
        data: { currentStock: { decrement: 24 } },
      });
    });

    it("credit guard blocks all roles when the merge would exceed the customer's credit limit", async () => {
      const line = {
        id: "li-1",
        orderId: "ord-1",
        productId: "prod-1",
        qty: 2,
        boxes: null,
        pieces: null,
        unitsPerBox: null,
        unitPrice: 10,
        subtotal: 20,
        status: "PENDING",
        deliveredQty: 0,
      };
      prisma.changeRequest.findUnique.mockResolvedValue(
        baseCr({
          type: "CHANGE_QTY",
          orderItemId: "li-1",
          payload: { orderItemId: "li-1", newQty: 5 },
        }),
      );
      prisma.order.findUnique.mockResolvedValue(baseOrder([line]));
      prisma.orderItem.findUnique.mockResolvedValue(line); // B135 locked re-read
      prisma.orderItem.findMany.mockResolvedValue([
        {
          id: "li-1",
          productId: "prod-1",
          qty: 5,
          unitPrice: 10,
          subtotal: 50,
          status: "PENDING",
          trackedCategoryId: null,
        },
      ]);
      prisma.customer.findFirst.mockResolvedValue({ creditLimit: 10, pricingTier: 1 });

      await expect(
        service.approveChangeRequestAtStop("cr-1", operatorPayload, null),
      ).rejects.toMatchObject({ response: { code: "CREDIT_LIMIT_EXCEEDED" } });

      expect(invoicesService.reconcileOrderDraftInvoice).not.toHaveBeenCalled();
      expect(prisma.orderRevision.create).not.toHaveBeenCalled();
    });

    it("409s with STOP_ALREADY_COMPLETED when the stop is already COMPLETED, without attempting a claim", async () => {
      prisma.changeRequest.findUnique.mockResolvedValue(
        baseCr({ type: "NOTE", payload: { text: "please substitute if out" } }),
      );
      prisma.order.findUnique.mockResolvedValue(
        baseOrder([], { routeRunStop: { id: "stop-1", status: "COMPLETED" } }),
      );

      await expect(
        service.approveChangeRequestAtStop("cr-1", operatorPayload, null),
      ).rejects.toMatchObject({ response: { code: "STOP_ALREADY_COMPLETED" } });

      expect(prisma.changeRequest.updateMany).not.toHaveBeenCalled();
    });

    it("post-commit: reconciles the draft invoice and appends a CHANGE_REQUEST revision", async () => {
      const line = {
        id: "li-1",
        orderId: "ord-1",
        productId: "prod-1",
        qty: 2,
        boxes: null,
        pieces: null,
        unitsPerBox: null,
        unitPrice: 10,
        subtotal: 20,
        status: "PENDING",
        deliveredQty: 0,
      };
      prisma.changeRequest.findUnique.mockResolvedValue(
        baseCr({
          type: "CHANGE_QTY",
          orderItemId: "li-1",
          payload: { orderItemId: "li-1", newQty: 5 },
          note: "please add more",
        }),
      );
      prisma.order.findUnique.mockResolvedValue(baseOrder([line]));
      prisma.orderItem.findUnique.mockResolvedValue(line); // B135 locked re-read
      prisma.orderItem.findMany.mockResolvedValue([
        {
          id: "li-1",
          productId: "prod-1",
          qty: 5,
          unitPrice: 10,
          subtotal: 50,
          status: "PENDING",
          trackedCategoryId: null,
        },
      ]);

      await service.approveChangeRequestAtStop("cr-1", operatorPayload, "looked fine at the door");

      expect(invoicesService.reconcileOrderDraftInvoice).toHaveBeenCalledWith("ord-1", {
        basis: "order",
      });
      expect(prisma.orderRevision.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            orderId: "ord-1",
            source: "CHANGE_REQUEST",
            reason: "please add more",
          }),
        }),
      );
    });

    it("regulated guard re-runs on ADD_ITEM approval; a throw writes nothing", async () => {
      prisma.changeRequest.findUnique.mockResolvedValue(
        baseCr({
          type: "ADD_ITEM",
          productId: "prod-4",
          payload: {
            productId: "prod-4",
            qty: 2,
            boxes: null,
            pieces: null,
            productName: "Tobacco",
          },
        }),
      );
      prisma.order.findUnique.mockResolvedValue(baseOrder([]));
      prisma.product.findUnique.mockResolvedValue({ id: "prod-4", trackedCategoryId: "cat-1" }); // in-tx ADD_ITEM price read
      prisma.product.findFirst.mockResolvedValue({ id: "prod-4", trackedCategoryId: "cat-1" }); // pre-tx regulated guard read
      const authGuard = (service as any).authGuard;
      authGuard.assertAuthorizedOrThrow.mockRejectedValueOnce(
        new ConflictException({ code: "REGULATED_AUTH_REQUIRED" }),
      );

      await expect(
        service.approveChangeRequestAtStop("cr-1", operatorPayload, null),
      ).rejects.toMatchObject({ response: { code: "REGULATED_AUTH_REQUIRED" } });

      expect(authGuard.assertAuthorizedOrThrow).toHaveBeenCalledWith({
        customerId: "cust-1",
        lines: [{ trackedCategoryId: "cat-1" }],
        orderId: "ord-1",
      });
      expect(prisma.changeRequest.updateMany).not.toHaveBeenCalled();
      expect(prisma.orderItem.create).not.toHaveBeenCalled();
    });

    describe("approveChangeRequestAtStop: tx boundary (B134/B135)", () => {
      const sharedLine = {
        id: "li-1",
        orderId: "ord-1",
        productId: "prod-1",
        qty: 24,
        boxes: 2,
        pieces: 0,
        unitsPerBox: 12,
        unitPrice: 24,
        subtotal: 48,
        status: "PENDING",
        deliveredQty: 0,
      };

      /** Shared fixture for T1-T7, P4: a DECREASE change so the stock guard never fires. */
      const setUpSharedFixture = () => {
        prisma.changeRequest.findUnique.mockResolvedValue(
          baseCr({
            type: "CHANGE_QTY",
            orderItemId: "li-1",
            payload: { orderItemId: "li-1", newQty: 18 },
          }),
        );
        prisma.orderItem.findMany.mockResolvedValue([
          {
            id: "li-1",
            productId: "prod-1",
            qty: 18,
            unitPrice: 24,
            subtotal: 36,
            status: "PENDING",
            deliveredQty: 0,
          },
        ]);
        // B135: the merge re-reads the HELD row in full for its money fields, and now fails
        // closed when that read comes back empty. `findUnique` defaults to null, so the pins
        // below would exercise the refusal instead of the merge — resolve the locked row (the
        // full li-1 the order carries) so they run through the locked-row path by default.
        prisma.orderItem.findUnique.mockResolvedValue(sharedLine);
      };

      /**
       * Captures the merge tx via a one-time tenantTransaction override. `onError` receives the
       * error a failing merge threw from INSIDE that callback — T3's rollback oracle. It is a
       * parameter rather than a second `mockImplementationOnce` in the test because a second
       * once-implementation queues BEHIND this one and would never see the first tx.
       */
      const captureMergeTx = (onError?: (e: unknown) => void) => {
        const seenTx: any = {
          ...prisma.forTenant(),
          $executeRaw: jest.fn().mockResolvedValue(0),
          $queryRaw: jest.fn().mockResolvedValue([]),
        };
        prisma.tenantTransaction.mockImplementationOnce(async (fn: any) => {
          try {
            return await fn(seenTx);
          } catch (e) {
            onError?.(e);
            throw e;
          }
        });
        prisma.order.findUnique.mockResolvedValue(baseOrder([sharedLine]));
        return seenTx;
      };

      it("REG-B134 (T1): the invoice un-send runs inside the merge transaction (receives the tx)", async () => {
        setUpSharedFixture();
        const seenTx = captureMergeTx();

        await service.approveChangeRequestAtStop("cr-1", operatorPayload, null);

        expect(invoicesService.revertLinkedInvoicesForOrderEdit.mock.calls[0]?.[1]).toBe(seenTx);
      });

      it("P18: the merge asks the un-send to hold each invoice row while it counts payments", async () => {
        setUpSharedFixture();
        captureMergeTx();

        await service.approveChangeRequestAtStop("cr-1", operatorPayload, null);

        expect(invoicesService.revertLinkedInvoicesForOrderEdit.mock.calls[0]?.[2]).toEqual({
          lockRows: true,
        });
      });

      it("REG-B134 (T2): the un-send runs after the order row lock, never before it", async () => {
        setUpSharedFixture();
        const seenTx = captureMergeTx();

        await service.approveChangeRequestAtStop("cr-1", operatorPayload, null);

        expect(
          invoicesService.revertLinkedInvoicesForOrderEdit.mock.invocationCallOrder[0],
        ).toBeGreaterThan(seenTx.$executeRaw.mock.invocationCallOrder[0]);
      });

      it("REG-B134 (T3): when the merge fails (lost claim), the un-send went through the rolled-back tx", async () => {
        setUpSharedFixture();
        let txError: unknown;
        const seenTx = captureMergeTx((e) => {
          txError = e;
        });
        prisma.changeRequest.updateMany.mockResolvedValue({ count: 0 });

        await expect(
          service.approveChangeRequestAtStop("cr-1", operatorPayload, null),
        ).rejects.toMatchObject({ response: { code: "CHANGE_REQUEST_ALREADY_RESOLVED" } });

        // The lost claim threw from INSIDE the tx callback (txError), so the un-send it had
        // already issued on that same tx — before the claim — rolls back with it.
        expect(txError).toMatchObject({ response: { code: "CHANGE_REQUEST_ALREADY_RESOLVED" } });
        expect(invoicesService.revertLinkedInvoicesForOrderEdit.mock.calls[0]?.[1]).toBe(seenTx);
        expect(
          invoicesService.revertLinkedInvoicesForOrderEdit.mock.invocationCallOrder[0],
        ).toBeLessThan(prisma.changeRequest.updateMany.mock.invocationCallOrder[0]);
      });

      it("REG-B135 (T4): a stop completed between the snapshot and the lock refuses with STOP_ALREADY_COMPLETED", async () => {
        setUpSharedFixture();
        const LIVE_ROW = {
          tenantId: "test-tenant",
          status: "OUT_FOR_DELIVERY",
          routeRun: { status: "IN_PROGRESS" },
          routeRunStop: { status: "COMPLETED" },
        };
        prisma.order.findUnique.mockImplementation(async (args: any) =>
          args?.select?.routeRunStop ? LIVE_ROW : baseOrder([sharedLine]),
        );

        await expect(
          service.approveChangeRequestAtStop("cr-1", operatorPayload, null),
        ).rejects.toMatchObject({ response: { code: "STOP_ALREADY_COMPLETED" } });
      });

      it("REG-B135 (T5): an order that went DELIVERED between the snapshot and the lock refuses (ORDER_STATUS)", async () => {
        setUpSharedFixture();
        const LIVE_ROW = {
          tenantId: "test-tenant",
          status: "DELIVERED",
          routeRun: { status: "IN_PROGRESS" },
          routeRunStop: { status: "PENDING" },
        };
        prisma.order.findUnique.mockImplementation(async (args: any) =>
          args?.select?.routeRunStop ? LIVE_ROW : baseOrder([sharedLine]),
        );

        await expect(
          service.approveChangeRequestAtStop("cr-1", operatorPayload, null),
        ).rejects.toMatchObject({
          response: { code: "CHANGE_WINDOW_CLOSED", reason: "ORDER_STATUS" },
        });
      });

      it("REG-B135 (T6): a run that left IN_PROGRESS between the snapshot and the lock refuses (RUN_NOT_ACTIVE)", async () => {
        setUpSharedFixture();
        const LIVE_ROW = {
          tenantId: "test-tenant",
          status: "OUT_FOR_DELIVERY",
          routeRun: { status: "COMPLETED" },
          routeRunStop: { status: "PENDING" },
        };
        prisma.order.findUnique.mockImplementation(async (args: any) =>
          args?.select?.routeRunStop ? LIVE_ROW : baseOrder([sharedLine]),
        );

        await expect(
          service.approveChangeRequestAtStop("cr-1", operatorPayload, null),
        ).rejects.toMatchObject({
          response: { code: "CHANGE_WINDOW_CLOSED", reason: "RUN_NOT_ACTIVE" },
        });
      });

      it("REG-B135 (T7): LINE_ALREADY_DELIVERED is judged on the locked in-tx line, not the pre-tx snapshot", async () => {
        prisma.changeRequest.findUnique.mockResolvedValue(
          baseCr({
            type: "CHANGE_QTY",
            orderItemId: "li-1",
            payload: { orderItemId: "li-1", newQty: 18 },
          }),
        );
        prisma.order.findUnique.mockResolvedValue(baseOrder([sharedLine])); // snapshot line: deliveredQty 0
        prisma.orderItem.findMany.mockResolvedValue([
          {
            id: "li-1",
            productId: "prod-1",
            qty: 24,
            unitPrice: 24,
            subtotal: 48,
            status: "PENDING",
            deliveredQty: 24, // the held (locked) row: already delivered
          },
        ]);

        await expect(
          service.approveChangeRequestAtStop("cr-1", operatorPayload, null),
        ).rejects.toMatchObject({ response: { code: "LINE_ALREADY_DELIVERED" } });
      });

      // T7's twin: the same guard's cancelled half. Without it, dropping
      // `held?.status === "CANCELLED"` would leave every test in this file green.
      it("P10: a line cancelled between the snapshot and the lock is refused on the locked row", async () => {
        prisma.changeRequest.findUnique.mockResolvedValue(
          baseCr({
            type: "CHANGE_QTY",
            orderItemId: "li-1",
            payload: { orderItemId: "li-1", newQty: 18 },
          }),
        );
        prisma.order.findUnique.mockResolvedValue(baseOrder([sharedLine])); // snapshot line: PENDING
        prisma.orderItem.findMany.mockResolvedValue([
          {
            id: "li-1",
            productId: "prod-1",
            qty: 24,
            unitPrice: 24,
            subtotal: 48,
            status: "CANCELLED", // the held (locked) row: cancelled since the snapshot
            deliveredQty: 0,
          },
        ]);

        const err = await service
          .approveChangeRequestAtStop("cr-1", operatorPayload, null)
          .catch((e) => e);

        expect(err).toBeInstanceOf(BadRequestException);
        expect(err.message).toContain("already cancelled");
      });

      it("P7: the ORDER row is locked BEFORE the stop row, and the stop lock never waits (NOWAIT)", async () => {
        setUpSharedFixture();
        const seenTx = captureMergeTx();

        await service.approveChangeRequestAtStop("cr-1", operatorPayload, null);

        // Order→stop is the repo-wide acquisition order (reopenStop, the customers.service merge
        // and purge paths); inverting it here would deadlock against them. The stop lock is
        // therefore taken second and NOWAIT, so this tx never waits on a stop row.
        expect(seenTx.$executeRaw.mock.calls[0][0].join("?")).toContain('"Order"');
        const stopLockSql = seenTx.$executeRaw.mock.calls[1][0].join("?");
        expect(stopLockSql).toContain('"RouteRunStop"');
        expect(stopLockSql).toContain("FOR NO KEY UPDATE NOWAIT");
        // order.findUnique call [0] is the pre-tx snapshot, [1] is the in-tx `live` re-read: both
        // locks must be held before that re-read, or an in-flight completion stays invisible.
        expect(seenTx.$executeRaw.mock.invocationCallOrder[1]).toBeLessThan(
          seenTx.order.findUnique.mock.invocationCallOrder[1],
        );
      });

      it("P11: a stop row locked by an in-flight completion (55P03) refuses as retryable STOP_BUSY and writes nothing", async () => {
        setUpSharedFixture();
        const seenTx = captureMergeTx();
        const lockErr: any = new Error("Raw query failed");
        lockErr.meta = { code: "55P03" };
        seenTx.$executeRaw.mockResolvedValueOnce(0).mockRejectedValueOnce(lockErr);

        // A busy stop is transient, so it must NOT read as the terminal CHANGE_WINDOW_CLOSED —
        // the resolver is told to retry.
        await expect(
          service.approveChangeRequestAtStop("cr-1", operatorPayload, null),
        ).rejects.toMatchObject({
          response: { code: "CONCURRENT_UPDATE", reason: "STOP_BUSY", retryable: true },
        });

        expect(invoicesService.revertLinkedInvoicesForOrderEdit).not.toHaveBeenCalled();
        expect(seenTx.orderItem.update).not.toHaveBeenCalled();
        expect(seenTx.orderItem.create).not.toHaveBeenCalled();
        expect(seenTx.changeRequest.updateMany).not.toHaveBeenCalled();
        expect(seenTx.deliveryMutation.create).not.toHaveBeenCalled();
        expect(seenTx.product.update).not.toHaveBeenCalled();
      });

      it("P12: the same refusal when the lock error carries only a message (no meta.code)", async () => {
        setUpSharedFixture();
        const seenTx = captureMergeTx();
        seenTx.$executeRaw
          .mockResolvedValueOnce(0)
          .mockRejectedValueOnce(
            new Error('could not obtain lock on row in relation "RouteRunStop"'),
          );

        await expect(
          service.approveChangeRequestAtStop("cr-1", operatorPayload, null),
        ).rejects.toMatchObject({
          response: { code: "CONCURRENT_UPDATE", reason: "STOP_BUSY", retryable: true },
        });

        expect(seenTx.changeRequest.updateMany).not.toHaveBeenCalled();
      });

      it("P13: a non-55P03 failure on the stop lock is rethrown unchanged, not turned into a 409", async () => {
        setUpSharedFixture();
        const seenTx = captureMergeTx();
        const boom = new Error("connection terminated unexpectedly");
        seenTx.$executeRaw.mockResolvedValueOnce(0).mockRejectedValueOnce(boom);

        await expect(
          service.approveChangeRequestAtStop("cr-1", operatorPayload, null),
        ).rejects.toBe(boom);
      });

      // The shipping fee is the last money input the total took from the PRE-TX snapshot: a fee
      // edited between that read and the lock was billed away — by the total AND by the immutable
      // revision snapshot, which is the audit record of what the order was billed at.
      it("P19: the total and the revision snapshot take shippingFee from the locked in-tx row, not the pre-tx snapshot", async () => {
        setUpSharedFixture();
        (service as any).systemConfig.get.mockResolvedValue("0"); // taxRate 0 — isolate the fee
        const seenTx = captureMergeTx();
        prisma.order.findUnique.mockImplementation(async (args: any) =>
          args?.select?.routeRunStop
            ? {
                tenantId: "test-tenant",
                status: "OUT_FOR_DELIVERY",
                shippingFee: 7.5, // raised after the snapshot was taken
                routeRun: { status: "IN_PROGRESS" },
                routeRunStop: { status: "PENDING" },
              }
            : baseOrder([sharedLine], { shippingFee: 0 }),
        );

        await service.approveChangeRequestAtStop("cr-1", operatorPayload, null);

        const written = seenTx.order.update.mock.calls.at(-1)[0].data;
        expect(written.subtotal).toBe(36);
        expect(written.total).toBe(43.5); // 36 + 0 tax + 0 category tax + 7.50 shipping
        // D3: the same live value rides out of the tx into the revision, so the audit trail
        // agrees with the total instead of recording the snapshot's 0.
        const revision = prisma.orderRevision.create.mock.calls.at(-1)[0].data;
        expect(revision.snapshot.shippingFee).toBe(7.5);
        expect(revision.snapshot.total).toBe(43.5);
      });

      // The B135 twin of P8 for the CHANGE_QTY branch: the PRICE it bills must come from the
      // locked row too, not from a snapshot a concurrent re-price has since overtaken.
      it("P20: CHANGE_QTY bills the locked row's unitPrice, not the pre-tx snapshot's", async () => {
        setUpSharedFixture(); // CHANGE_QTY li-1 → newQty 18
        const seenTx = captureMergeTx();
        const plainLine = {
          id: "li-1",
          orderId: "ord-1",
          productId: "prod-1",
          qty: 24,
          boxes: null,
          pieces: null,
          unitsPerBox: null,
          unitPrice: 24, // the stale snapshot price
          subtotal: 576,
          status: "PENDING",
          deliveredQty: 0,
        };
        prisma.order.findUnique.mockResolvedValue(baseOrder([plainLine]));
        prisma.orderItem.findUnique.mockResolvedValue({
          ...plainLine,
          unitPrice: 30, // re-priced under the lock, same qty
          promoFreeUnits: null,
        });

        await service.approveChangeRequestAtStop("cr-1", operatorPayload, null);

        const written = seenTx.orderItem.update.mock.calls.at(-1)[0].data;
        expect(written.subtotal).toBe(
          computeLineSubtotal({
            unitPrice: 30,
            qty: 18,
            boxes: null,
            pieces: null,
            unitsPerBox: 0,
            freeUnits: 0,
          }),
        );
        expect(written.subtotal).not.toBe(24 * 18); // the snapshot price would have under-billed
      });

      // A row held under the Order lock cannot vanish inside the same tx, so an empty re-read
      // means the lock did not hold. Falling back to the stale snapshot there would price the
      // edit off exactly the data the lock exists to replace — refuse instead.
      it("P24: a held row whose locked re-read comes back empty refuses as CONCURRENT_UPDATE and writes nothing", async () => {
        setUpSharedFixture();
        const seenTx = captureMergeTx();
        prisma.orderItem.findUnique.mockResolvedValue(null);

        await expect(
          service.approveChangeRequestAtStop("cr-1", operatorPayload, null),
        ).rejects.toMatchObject({
          response: { code: "CONCURRENT_UPDATE", reason: "LINE_VANISHED", retryable: true },
        });

        expect(seenTx.orderItem.update).not.toHaveBeenCalled();
        expect(seenTx.order.update).not.toHaveBeenCalled();
      });

      it("P8: ADD_ITEM increments from the LOCKED row's qty, not the pre-tx snapshot's", async () => {
        prisma.changeRequest.findUnique.mockResolvedValue(
          baseCr({
            type: "ADD_ITEM",
            productId: "prod-1",
            payload: { productId: "prod-1", qty: 6, boxes: null, pieces: null },
          }),
        );
        // Snapshot says 24; a concurrent edit committed 12 before the lock.
        prisma.order.findUnique.mockResolvedValue(
          baseOrder([
            { ...sharedLine, boxes: null, pieces: null, unitsPerBox: null, unitPrice: 1 },
          ]),
        );
        const catalogProduct = {
          id: "prod-1",
          name: "Widget",
          pricePerUnit: 1,
          unitsPerBox: null,
          category: null,
          trackedCategoryId: null,
        };
        prisma.product.findUnique.mockResolvedValue(catalogProduct);
        prisma.product.findFirst.mockResolvedValue(catalogProduct);
        prisma.orderItem.findMany
          .mockResolvedValueOnce([]) // getCustomerPriceHistory (hoisted, pre-tx)
          .mockResolvedValue([
            {
              id: "li-1",
              productId: "prod-1",
              qty: 12,
              unitPrice: 1,
              subtotal: 12,
              status: "PENDING",
              deliveredQty: 0,
            },
          ]);
        prisma.orderItem.findUnique.mockResolvedValue({
          id: "li-1",
          productId: "prod-1",
          qty: 12,
          boxes: null,
          pieces: null,
          unitsPerBox: null,
          unitPrice: 1,
          subtotal: 12,
          status: "PENDING",
          deliveredQty: 0,
        });

        await service.approveChangeRequestAtStop("cr-1", operatorPayload, null);

        expect(prisma.orderItem.update).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { id: "li-1" },
            data: expect.objectContaining({ qty: 18 }),
          }),
        );
        expect(prisma.orderItem.update).not.toHaveBeenCalledWith(
          expect.objectContaining({ data: expect.objectContaining({ qty: 30 }) }),
        );
      });

      it("P9: ADD_ITEM opens a NEW line when the locked row for that product is CANCELLED (snapshot says PENDING)", async () => {
        prisma.changeRequest.findUnique.mockResolvedValue(
          baseCr({
            type: "ADD_ITEM",
            productId: "prod-1",
            payload: { productId: "prod-1", qty: 6, boxes: null, pieces: null },
          }),
        );
        prisma.order.findUnique.mockResolvedValue(
          baseOrder([
            { ...sharedLine, boxes: null, pieces: null, unitsPerBox: null, unitPrice: 1 },
          ]),
        );
        const catalogProduct = {
          id: "prod-1",
          name: "Widget",
          pricePerUnit: 1,
          unitsPerBox: null,
          category: null,
          trackedCategoryId: null,
        };
        prisma.product.findUnique.mockResolvedValue(catalogProduct);
        prisma.product.findFirst.mockResolvedValue(catalogProduct);
        prisma.orderItem.create.mockResolvedValue({ id: "li-new" });
        prisma.orderItem.findMany
          .mockResolvedValueOnce([]) // getCustomerPriceHistory (hoisted, pre-tx)
          .mockResolvedValue([
            {
              id: "li-1",
              productId: "prod-1",
              qty: 0,
              unitPrice: 1,
              subtotal: 0,
              status: "CANCELLED",
              deliveredQty: 0,
            },
          ]);

        await service.approveChangeRequestAtStop("cr-1", operatorPayload, null);

        expect(prisma.orderItem.create).toHaveBeenCalled();
        expect(prisma.orderItem.update).not.toHaveBeenCalled();
      });

      it("P4: the at-door approval still aborts before any claim when the un-send throws for recorded payments", async () => {
        setUpSharedFixture();
        prisma.order.findUnique.mockResolvedValue(baseOrder([sharedLine]));
        invoicesService.revertLinkedInvoicesForOrderEdit.mockRejectedValueOnce(
          new BadRequestException("invoice has payments recorded"),
        );

        await service.approveChangeRequestAtStop("cr-1", operatorPayload, null).catch((e) => e);

        expect(prisma.changeRequest.updateMany).not.toHaveBeenCalled();
      });
    });
  });

  describe("RF-4 linePieceQty — per-unit tax basis survives an edit (recompute drift)", () => {
    const pieceQty = (li: any, fallback?: number) => (service as any).linePieceQty(li, fallback);

    it("a box-split line (boxes != null) is already in pieces — returns qty as-is", () => {
      expect(pieceQty({ qty: 27, boxes: 2, unitsPerBox: 12 })).toBe(27);
    });

    it("a selling-unit line WITH a snapshotted unitsPerBox expands qty → pieces", () => {
      expect(pieceQty({ qty: 5, boxes: null, unitsPerBox: 6 })).toBe(30);
    });

    it("a selling-unit boxed line stores unitsPerBox:null — falls back to the PRODUCT box size (no 6x under-charge on edit)", () => {
      // create() computed 5*6=30 pieces but stored unitsPerBox:null; without the
      // product fallback the recompute would collapse to 5 → a 6x category-tax drop.
      expect(pieceQty({ qty: 5, boxes: null, unitsPerBox: null }, 6)).toBe(30);
    });

    it("a genuinely loose line (no box size anywhere) stays qty", () => {
      expect(pieceQty({ qty: 8, boxes: null, unitsPerBox: null }, 0)).toBe(8);
      expect(pieceQty({ qty: 8, boxes: null, unitsPerBox: null })).toBe(8);
    });
  });
});

// ─── Controller: the merge-choice branch bypasses OrdersService.create ───────

describe("OrdersController — merge choice vs orderDate", () => {
  let controller: OrdersController;
  let ordersService: {
    findActiveOrder: jest.Mock;
    updateOrderItems: jest.Mock;
    mergeAllPendingForCustomer: jest.Mock;
    findOne: jest.Mock;
    create: jest.Mock;
  };

  const activeOrder = {
    id: "ord-open",
    orderNumber: "ORD-00009",
    status: "PENDING",
    total: 10,
    createdAt: new Date(),
    // priceType MANUAL: only an operator override survives the fold (F30/R11 refined
    // contract) — derived prices are omitted so updateOrderItems re-derives at the
    // merged qty; orders.scan-hardening.spec.ts pins that branch.
    lineItems: [{ productId: "prod-1", qty: 2, unitPrice: 5, priceType: "MANUAL", name: null }],
  };

  beforeEach(async () => {
    ordersService = {
      findActiveOrder: jest.fn().mockResolvedValue(activeOrder),
      updateOrderItems: jest.fn().mockResolvedValue(undefined),
      mergeAllPendingForCustomer: jest.fn().mockResolvedValue(null),
      findOne: jest.fn().mockResolvedValue(activeOrder),
      create: jest.fn().mockResolvedValue({ id: "ord-new", customerId: "cust-1" }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [OrdersController],
      providers: [
        { provide: OrdersService, useValue: ordersService },
        { provide: ChangeRequestsService, useValue: {} },
      ],
    }).compile();

    controller = module.get<OrdersController>(OrdersController);
  });

  it("rejects merge + orderDate before any items are folded in", async () => {
    await expect(
      controller.create(
        {
          customerId: "cust-1",
          items: [{ productId: "prod-1", qty: 1 }],
          mergeChoice: "merge",
          orderDate: isoDaysAgo(4),
        } as any,
        operatorPayload,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(ordersService.updateOrderItems).not.toHaveBeenCalled();
    expect(ordersService.mergeAllPendingForCustomer).not.toHaveBeenCalled();
    expect(ordersService.create).not.toHaveBeenCalled();
  });

  it("still merges an undated order into the open one", async () => {
    await controller.create(
      {
        customerId: "cust-1",
        items: [{ productId: "prod-1", qty: 1 }],
        mergeChoice: "merge",
      } as any,
      operatorPayload,
    );

    // F30/R11 (B199): the fold carries the EXISTING line's unitPrice through —
    // a merge is never where an operator's price override quietly disappears.
    // B465 fix round 4: the create-merge call site now always passes a 4th
    // opts argument naming isCreateMerge — the ONLY place this ever gets set.
    expect(ordersService.updateOrderItems).toHaveBeenCalledWith(
      "ord-open",
      expect.objectContaining({ items: [{ productId: "prod-1", qty: 3, unitPrice: 5 }] }),
      operatorPayload,
      expect.objectContaining({ isCreateMerge: true }),
    );
  });

  it("a dated order chosen as separate goes through create()", async () => {
    const orderDate = isoDaysAgo(4);

    await controller.create(
      {
        customerId: "cust-1",
        items: [{ productId: "prod-1", qty: 1 }],
        mergeChoice: "separate",
        orderDate,
      } as any,
      operatorPayload,
    );

    expect(ordersService.updateOrderItems).not.toHaveBeenCalled();
    expect(ordersService.create).toHaveBeenCalledWith(
      expect.objectContaining({ orderDate }),
      operatorPayload,
      { skipAutoMerge: true },
    );
  });
});
