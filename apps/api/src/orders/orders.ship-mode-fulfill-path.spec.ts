/**
 * New orders default to: the client's fulfillPath, else the customer record's own default, else
 * SHIP for a tenant whose effective `fulfilment_model` feature mode is "ship" (ROUTE for every
 * other mode, "unset" included). The mode only replaces the last-resort ROUTE, never a customer's
 * saved value, and a failed mode read fails open to today's chain.
 * Harness copied from `orders.create-restrictions.spec.ts`.
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
import { ConflictException, ForbiddenException } from "@nestjs/common";
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
import { FeatureConfigService } from "../billing/feature-config.service";
import { Prisma } from "@prisma/client";

const customerPayload = {
  sub: "user-cust",
  username: "customer1",
  role: "CUSTOMER" as const,
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

describe("OrdersService.create — ship-mode default fulfilment path", () => {
  let service: OrdersService;
  let featureConfig: { getEffectiveMode: jest.Mock };
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    // Default = the mode is not registered yet ("unset"): every case that does not narrow it is today's behaviour.
    featureConfig = { getEffectiveMode: jest.fn().mockResolvedValue("unset") };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        oversellReaderOffProvider,
        OrdersService,
        { provide: FeatureConfigService, useValue: featureConfig },
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
  const ACTIVE_CUSTOMER = {
    id: "cust-1",
    pricingTier: 1,
    user: { status: "ACTIVE" },
    deletedAt: null,
  };

  // `customerPath` is what the customer RECORD stores (select { pricingTier, fulfillPath }).
  const arrange = (customerPath: "ROUTE" | "SHIP" | undefined) => {
    prisma.customer.findFirst.mockResolvedValue({
      id: "cust-1",
      pricingTier: 1,
      ...(customerPath ? { fulfillPath: customerPath } : {}),
    });
    prisma.customer.findUnique.mockResolvedValue(ACTIVE_CUSTOMER);
    prisma.product.findMany.mockResolvedValue([MOCK_PRODUCT]);
    prisma.order.create.mockResolvedValue(NEW_ORDER);
    (prisma.tenantTransaction as jest.Mock).mockImplementation((fn: any) =>
      fn({
        ...prisma,
        $queryRaw: jest.fn().mockResolvedValue([{ max: null }]),
        $executeRaw: jest.fn().mockResolvedValue(0),
      }),
    );
  };
  // OrdersService also reads `mixed_packs` through the same service, so only fulfilment_model is
  // steered (and counted) here; every other key stays "unset".
  const setMode = (mode: string) =>
    featureConfig.getEffectiveMode.mockImplementation(async (_t: string, key: string) =>
      key === "fulfilment_model" ? mode : "unset",
    );
  const modeReads = () =>
    featureConfig.getEffectiveMode.mock.calls.filter(([, key]) => key === "fulfilment_model");
  const create = (fulfillPath?: "ROUTE" | "SHIP") =>
    service.create(
      {
        customerId: "cust-1",
        items: [{ productId: "prod-1", qty: 1 }],
        ...(fulfillPath ? { fulfillPath } : {}),
      } as never,
      { ...operatorPayload, tenantId: "t-1" } as never,
    );
  const writtenPath = () => prisma.order.create.mock.calls[0][0].data.fulfillPath;

  it.each(["unset", "delivery", "both", "pickup"])(
    "mode %s, nothing sent: the customer's default, else ROUTE, exactly as today",
    async (mode) => {
      setMode(mode);
      arrange("SHIP");
      await create();
      expect(writtenPath()).toBe("SHIP");

      prisma.order.create.mockClear();
      arrange("ROUTE");
      await create();
      expect(writtenPath()).toBe("ROUTE");

      prisma.order.create.mockClear();
      arrange(undefined);
      await create();
      expect(writtenPath()).toBe("ROUTE");
    },
  );

  it("ship mode with a customer record saying ROUTE: ROUTE (the customer's own default wins), no mode read", async () => {
    arrange("ROUTE");
    setMode("ship");
    await create();
    expect(writtenPath()).toBe("ROUTE");
    expect(modeReads()).toEqual([]);
  });

  it("ship mode with no customer default: SHIP, from one fulfilment_model read for the request's tenant", async () => {
    arrange(undefined);
    setMode("ship");
    await create();
    expect(writtenPath()).toBe("SHIP");
    expect(modeReads()).toEqual([["test-tenant", "fulfilment_model"]]);
  });

  it("ship mode with a customer default of SHIP: SHIP", async () => {
    arrange("SHIP");
    setMode("ship");
    await create();
    expect(writtenPath()).toBe("SHIP");
  });

  it("the client's value always wins in ship mode, with no mode read", async () => {
    arrange(undefined);
    setMode("ship");
    await create("ROUTE");
    expect(writtenPath()).toBe("ROUTE");
    prisma.order.create.mockClear();
    arrange("ROUTE");
    await create("SHIP");
    expect(writtenPath()).toBe("SHIP");
    expect(modeReads()).toEqual([]);
  });

  it("the mode read throws: today's chain (customer default / ROUTE), the order still saves", async () => {
    arrange(undefined);
    featureConfig.getEffectiveMode.mockImplementation(async (_t: string, key: string) => {
      if (key === "fulfilment_model") throw new Error("db down");
      return "unset";
    });
    await expect(create()).resolves.toBeDefined();
    expect(writtenPath()).toBe("ROUTE");

    prisma.order.create.mockClear();
    arrange("SHIP");
    await create();
    expect(writtenPath()).toBe("SHIP");
  });
});
