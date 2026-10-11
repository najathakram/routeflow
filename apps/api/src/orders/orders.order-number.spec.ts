/**
 * B587 — POST /orders 500'd after the first create on a seeded tenant: the generator took the
 * lexicographically largest `ORD-*` number, so `ORD-SEED-1` won, parseInt gave NaN, the fallback
 * `ORD-00001` collided on @@unique([tenantId, orderNumber]), and every retry recomputed the same
 * value. Harness copied from `orders.update-items-guards.spec.ts`.
 *
 * REPRO-FIRST: the first test seeds the OLD lookup (`order.findFirst` -> ORD-SEED-1) alongside the
 * numeric max the new generator reads (`$queryRaw` -> 1) and asserts ORD-00002; the old code
 * derives ORD-00001 from the seed row and fails it.
 */

// Mock InvoicesService before it's imported — prevents Jest from traversing
// invoice-pdf.service.ts which imports @react-pdf/renderer (ESM-only module).
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

import { oversellReaderOffProvider } from "./testing/policy-reader-provider";
import { Test, TestingModule } from "@nestjs/testing";
import { ForbiddenException, Logger } from "@nestjs/common";
import { getQueueToken } from "@nestjs/bull";
import { ConfigService } from "@nestjs/config";

import { OrdersService } from "./orders.service";
import { InvoicesService } from "../invoices/invoices.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
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
import { Prisma } from "@prisma/client";
import { ORDER_SEQ_PATTERN } from "./order-number";

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
  notes: null,
  driverNote: null,
  routeRunId: null,
  routeRunStopId: null,
  deliveredAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  customer: { businessName: "Acme Wholesale" },
  routeRun: null,
};

const customerPayload = {
  sub: "user-cust",
  username: "customer1",
  role: "CUSTOMER" as const,
  tenantId: "test-tenant",
  status: "ACTIVE" as const,
  forcePasswordChange: false,
};

const operatorPayload = {
  sub: "user-op",
  username: "operator",
  role: "OPERATOR" as const,
  status: "ACTIVE" as const,
  forcePasswordChange: false,
};

const driverPayload = {
  sub: "user-drv",
  username: "driver1",
  role: "DRIVER" as const,
  status: "ACTIVE" as const,
  forcePasswordChange: false,
};

describe("OrdersService.create — B587 order-number generation", () => {
  let service: OrdersService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let invoicesService: {
    reconcileOrderDraftInvoice: jest.Mock;
    resyncOrderInvoicesForEdit: jest.Mock;
    revertLinkedInvoicesForOrderEdit: jest.Mock;
  };
  let promotionsService: { activeForCatalog: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrisma();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        oversellReaderOffProvider,
        OrdersService,
        {
          provide: TenantContextService,
          // B323: sweepAllPendingOrders() now takes TenantContextService; this spec never
          // exercises the sweep, so a bare run-through mock is enough to satisfy DI.
          useValue: { run: (_tenantId: string | null, fn: () => unknown) => fn() },
        },
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
      ],
    }).compile();

    service = module.get<OrdersService>(OrdersService);
    invoicesService = module.get(InvoicesService);
    promotionsService = module.get(PromotionsService);
  });

  const MOCK_PRODUCT = {
    id: "prod-1",
    name: "Widget",
    pricePerUnit: 10,
    unitsPerBox: null,
    category: null,
    trackedCategoryId: null,
    trackedSubcategoryId: null,
    isActive: true,
    // a real Product row always carries these; the buyer gate (WS6) judges them, never defaults
    kind: "STANDARD",
    portalVisible: true,
    parent: null,
  };
  const NEW_ORDER = {
    id: "ord-new",
    customerId: "cust-1",
    orderNumber: "x",
    total: 10,
    urgent: false,
    createdAt: new Date(),
    customer: { id: "cust-1", businessName: "Acme" },
    lineItems: [],
  };

  const arrange = (queryRawImpl: jest.Mock) => {
    prisma.customer.findFirst.mockResolvedValue({ id: "cust-1", pricingTier: 1 });
    prisma.product.findMany.mockResolvedValue([MOCK_PRODUCT]);
    prisma.order.create.mockResolvedValue(NEW_ORDER);
    withQueryRaw(queryRawImpl);
  };
  // The transaction client the service receives carries its own $queryRaw — wire ours into it.
  // B562 PR-2: the stock decrement is also a `$queryRaw` (UPDATE … RETURNING); it is answered with
  // no rows here so `qr` sees only the order-number query this spec is about.
  const isStockUpdate = (args: any[]) =>
    JSON.stringify(args[0]?.sql ?? args[0] ?? "").includes("currentStock");
  const withQueryRaw = (qr: jest.Mock) =>
    (prisma.tenantTransaction as jest.Mock).mockImplementation((fn: any) =>
      fn({
        ...prisma,
        $queryRaw: (...args: any[]) => (isStockUpdate(args) ? Promise.resolve([]) : qr(...args)),
        $executeRaw: jest.fn().mockResolvedValue(0),
      }),
    );
  const created = () => prisma.order.create.mock.calls.map((c: any) => c[0].data.orderNumber);

  it("a SEEDED tenant (ORD-SEED-1 sorts above every numeric number) gets the next numeric number, not a collision", async () => {
    // the OLD generator's input — a lexicographic-desc lookup that returns the seed row
    prisma.order.findFirst.mockResolvedValue({ orderNumber: "ORD-SEED-1" });
    arrange(jest.fn().mockResolvedValue([{ max: BigInt(1) }])); // ORD-00001 exists already
    await service.create(
      { items: [{ productId: "prod-1", qty: 1 }] } as never,
      customerPayload as never,
    );
    expect(created()).toEqual(["ORD-00002"]);
  });

  it("the create path scopes the query to ITS tenant (Order has no RLS — this argument is the only isolation guard)", async () => {
    const qr = jest.fn().mockResolvedValue([{ max: null }]);
    arrange(qr);
    await service.create(
      { items: [{ productId: "prod-1", qty: 1 }] } as never,
      customerPayload as never,
    );
    expect(qr.mock.calls[0].slice(1)).toEqual([ORDER_SEQ_PATTERN, "test-tenant", "test-tenant"]);
  });

  it("a tenant at ORD-9 gets ORD-00010", async () => {
    arrange(jest.fn().mockResolvedValue([{ max: BigInt(9) }]));
    await service.create(
      { items: [{ productId: "prod-1", qty: 1 }] } as never,
      customerPayload as never,
    );
    expect(created()).toEqual(["ORD-00010"]);
  });

  it("a tenant with no orders gets ORD-00001", async () => {
    arrange(jest.fn().mockResolvedValue([{ max: null }]));
    await service.create(
      { items: [{ productId: "prod-1", qty: 1 }] } as never,
      customerPayload as never,
    );
    expect(created()).toEqual(["ORD-00001"]);
  });

  it("non-conforming numbers never crash the generator (empty result, NaN-ish max)", async () => {
    for (const rows of [[], [{ max: null }], [{ max: Number.NaN }]]) {
      prisma.order.create.mockClear();
      arrange(jest.fn().mockResolvedValue(rows));
      await service.create(
        { items: [{ productId: "prod-1", qty: 1 }] } as never,
        customerPayload as never,
      );
      expect(created()).toEqual(["ORD-00001"]);
    }
  });

  it("a unique-constraint race is retried with a FRESH maximum (RF-014 still works)", async () => {
    prisma.customer.findFirst.mockResolvedValue({ id: "cust-1", pricingTier: 1 });
    prisma.product.findMany.mockResolvedValue([MOCK_PRODUCT]);
    prisma.order.create
      .mockRejectedValueOnce(
        Object.assign(new Error("dup"), {
          code: "P2002",
          meta: { target: ["tenantId", "orderNumber"] },
        }),
      )
      .mockResolvedValueOnce(NEW_ORDER);
    withQueryRaw(
      jest
        .fn()
        .mockResolvedValueOnce([{ max: 5 }])
        .mockResolvedValueOnce([{ max: 6 }]),
    );
    await service.create(
      { items: [{ productId: "prod-1", qty: 1 }] } as never,
      customerPayload as never,
    );
    expect(created()).toEqual(["ORD-00006", "ORD-00007"]);
  });

  // B585 — the credit check at create sits BEFORE the stock tx, behind the OFF/DARK/ENFORCED switch.
  describe("B585 — credit-limit check for a new order", () => {
    const CAPPED = { id: "cust-1", pricingTier: 1, creditLimit: 5 }; // the order below totals 10
    const arrangeOver = (switchValue: string | null = null) => {
      arrange(jest.fn().mockResolvedValue([{ max: null }]));
      prisma.customer.findFirst.mockResolvedValue(CAPPED);
      prisma.invoice.findMany.mockResolvedValue([]);
      prisma.order.findMany.mockResolvedValue([]);
      prisma.systemConfig.findFirst.mockResolvedValue(
        switchValue === null ? null : { value: switchValue },
      );
    };
    const items = { items: [{ productId: "prod-1", qty: 1 }] };
    let warn: jest.SpyInstance;
    beforeEach(() => {
      warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    });
    afterEach(() => warn.mockRestore());

    it("OFF (default, switch absent): the order is created and NO exposure is even computed", async () => {
      arrangeOver();
      await service.create(items as never, customerPayload as never);

      expect(created()).toEqual(["ORD-00001"]);
      expect(prisma.invoice.findMany).not.toHaveBeenCalled();
      expect(warn.mock.calls.map((c) => String(c[0])).some((m) => m.includes("would DENY"))).toBe(
        false,
      );
    });

    it("DARK ('dark'): an over-limit order is still created and one would-deny line is logged", async () => {
      arrangeOver("dark");
      await service.create(items as never, customerPayload as never);

      expect(created()).toEqual(["ORD-00001"]);
      const line = warn.mock.calls.map((c) => String(c[0])).find((m) => m.includes("would DENY"));
      expect(line).toContain("exposure=10");
      expect(line).toContain("limit=5");
    });

    it("ENFORCED ('true'), a BUYER: refused 409 with the code and NO figures, before anything is created", async () => {
      arrangeOver("true");
      const err = await service
        .create(items as never, customerPayload as never)
        .catch((e: { getResponse(): unknown }) => e);

      expect(err.getResponse()).toEqual({
        code: "CREDIT_LIMIT_EXCEEDED",
        message: expect.stringContaining("can't be placed right now"),
      });
      expect(prisma.order.create).not.toHaveBeenCalled();
      expect(prisma.tenantTransaction).not.toHaveBeenCalled(); // refused before the stock transaction
    });

    it("ENFORCED ('true'), STAFF creating for the customer: the same refusal names the figures", async () => {
      arrangeOver("true");
      prisma.customer.findUnique.mockResolvedValue({
        ...CAPPED,
        user: { status: "ACTIVE" },
        deletedAt: null,
      });
      await expect(
        service.create({ customerId: "cust-1", ...items } as never, operatorPayload as never),
      ).rejects.toMatchObject({
        response: { code: "CREDIT_LIMIT_EXCEEDED", limit: 5, exposure: 10 },
      });
    });

    it("a DRAFT is not a sale: never checked, even ENFORCED", async () => {
      arrangeOver("true");
      // an operator names the customer (a customer caller resolves their own via findFirst)
      prisma.customer.findUnique.mockResolvedValue({
        ...CAPPED,
        user: { status: "ACTIVE" },
        deletedAt: null,
      });
      await service.create(
        { customerId: "cust-1", status: "DRAFT", ...items } as never,
        operatorPayload as never,
      );

      expect(created()).toEqual(["ORD-00001"]);
      expect(prisma.systemConfig.findFirst).not.toHaveBeenCalled();
    });
  });
});
