/**
 * Lane R step 2a-5 — `OrdersService.create` calls the selling-restrictions choke point for a real
 * (non-draft) sale, BEFORE the stock transaction, with the channel read from the PRINCIPAL. Harness
 * copied from `orders.order-number.spec.ts`; the choke point itself is proven in
 * `selling-restrictions.service.spec.ts`, this file pins the CALL: what it is asked and when.
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

import { FeatureConfigService } from "../billing/feature-config.service";
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

describe("OrdersService.create — selling restrictions call site (lane R 2a-5)", () => {
  let service: OrdersService;
  const featureConfig = { getEffectiveMode: jest.fn() };
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    featureConfig.getEffectiveMode.mockReset().mockResolvedValue("unset");
    prisma = createMockPrisma();

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
  const withQueryRaw = (qr: jest.Mock) =>
    (prisma.tenantTransaction as jest.Mock).mockImplementation((fn: any) =>
      fn({ ...prisma, $queryRaw: qr, $executeRaw: jest.fn().mockResolvedValue(0) }),
    );

  let restrictions: { assertLinesSellable: jest.Mock };
  beforeEach(() => {
    restrictions = (service as any).sellingRestrictions;
    arrange(jest.fn().mockResolvedValue([{ max: null }]));
  });
  const input = (over: Record<string, unknown> = {}) =>
    ({ items: [{ productId: "prod-1", qty: 1 }], ...over }) as never;
  // The pseudo-user the buyer controller builds (`makePseudoUser`): role CUSTOMER, stamped type BUYER.
  const buyerPrincipal = { ...customerPayload, type: "BUYER" as const };

  it("asks the choke point ONCE, before the stock transaction, with the tenant, customer, listed products only, and the STAFF channel for an operator", async () => {
    prisma.customer.findUnique.mockResolvedValue({
      id: "cust-1",
      pricingTier: 1,
      user: { status: "ACTIVE" },
      deletedAt: null,
    });
    const order: string[] = [];
    restrictions.assertLinesSellable.mockImplementation(
      async () => void order.push("restrictions"),
    );
    (prisma.tenantTransaction as jest.Mock).mockImplementation((fn: any) => {
      order.push("stock-tx");
      return fn({
        ...prisma,
        $queryRaw: jest.fn().mockResolvedValue([{ max: null }]),
        $executeRaw: jest.fn().mockResolvedValue(0),
      });
    });
    await service.create(
      input({
        customerId: "cust-1",
        items: [
          { productId: "prod-1", qty: 1 },
          { name: "Delivery", qty: 1, unitPrice: 5 }, // unlisted: no product to restrict
        ],
      }),
      { ...operatorPayload, tenantId: "t-1" } as never,
    );

    expect(restrictions.assertLinesSellable).toHaveBeenCalledTimes(1);
    expect(restrictions.assertLinesSellable).toHaveBeenCalledWith({
      tenantId: "t-1",
      customerId: "cust-1",
      lines: [{ productId: "prod-1" }], // every line of a new order is a NEW line: no qtyDelta
      channel: "STAFF",
      fulfilmentKind: "DELIVERY",
    });
    expect(order).toEqual(["restrictions", "stock-tx"]);
  });

  it.each([
    [{ counterSale: true, fulfillPath: "PICKUP" }, "COUNTER"],
    [{ fulfillPath: "PICKUP" }, "PICKUP"],
    [{}, "DELIVERY"],
  ])(
    "L8: create with options %j is judged as %s (counter / pickup: the store's state)",
    async (options, kind) => {
      prisma.customer.findUnique.mockResolvedValue({
        id: "cust-1",
        pricingTier: 1,
        user: { status: "ACTIVE" },
        deletedAt: null,
      });
      await service.create(
        input({ customerId: "cust-1" }),
        { ...operatorPayload, tenantId: "t-1" } as never,
        options as never,
      );
      expect(restrictions.assertLinesSellable).toHaveBeenCalledWith(
        expect.objectContaining({ fulfilmentKind: kind }),
      );
    },
  );

  // L8 M1: the buyer's CHOSEN path decides the state: pickup -> the store's, ship -> the buyer's own.
  it.each([
    ["pickup", undefined, "PICKUP"], // pickup-only: a buyer order is always an in-store pickup
    ["pickup", "PICKUP", "PICKUP"],
    ["pickup_ship", "PICKUP", "PICKUP"],
    ["pickup_ship", "SHIP", "DELIVERY"],
  ])(
    "L8 checkout: a buyer on a %s tenant who picks %s is judged as %s",
    async (mode, chosen, kind) => {
      featureConfig.getEffectiveMode.mockResolvedValue(mode);
      prisma.customer.findUnique.mockResolvedValue(activeCustomer);
      await service.create(input({ customerId: "cust-1", fulfillPath: chosen }), {
        ...buyerPrincipal,
        tenantId: "t-1",
      } as never);
      expect(restrictions.assertLinesSellable).toHaveBeenCalledWith(
        expect.objectContaining({ channel: "BUYER_PORTAL", fulfilmentKind: kind }),
      );
    },
  );

  it("the channel comes from the PRINCIPAL: the buyer pseudo-user (type BUYER) and the plain CUSTOMER role are BUYER_PORTAL", async () => {
    for (const user of [buyerPrincipal, customerPayload]) {
      restrictions.assertLinesSellable.mockClear();
      await service.create(input(), { ...user, tenantId: "t-1" } as never);
      expect(restrictions.assertLinesSellable).toHaveBeenCalledWith(
        expect.objectContaining({ channel: "BUYER_PORTAL" }),
      );
    }
  });

  const activeCustomer = {
    id: "cust-1",
    pricingTier: 1,
    user: { status: "ACTIVE" },
    deletedAt: null,
  };

  it.each(["OPERATOR", "TENANT_ADMIN", "DRIVER"])(
    "a %s is judged on the STAFF channel, exactly once (a driver's at-door sale is neither skipped nor over-blocked as a buyer)",
    async (role) => {
      prisma.customer.findUnique.mockResolvedValue(activeCustomer);
      await service.create(input({ customerId: "cust-1" }), {
        ...operatorPayload,
        role,
        tenantId: "t-1",
      } as never);
      expect(restrictions.assertLinesSellable).toHaveBeenCalledTimes(1);
      expect(restrictions.assertLinesSellable.mock.calls[0][0].channel).toBe("STAFF");
    },
  );

  it("an order of ONLY unlisted (catalog-free) lines still asks the choke point, with no lines: they have no product to restrict", async () => {
    prisma.customer.findUnique.mockResolvedValue(activeCustomer);
    await service.create(
      input({ customerId: "cust-1", items: [{ name: "Delivery", qty: 1, unitPrice: 5 }] }),
      { ...operatorPayload, tenantId: "t-1" } as never,
    );
    expect(restrictions.assertLinesSellable).toHaveBeenCalledTimes(1);
    expect(restrictions.assertLinesSellable.mock.calls[0][0].lines).toEqual([]);
  });

  it("a BACKDATED sale is still judged NOW: a staff-settable order date must not move a compliance check", async () => {
    prisma.customer.findUnique.mockResolvedValue({
      id: "cust-1",
      pricingTier: 1,
      user: { status: "ACTIVE" },
      deletedAt: null,
    });
    await service.create(input({ customerId: "cust-1", orderDate: "2026-06-01" }), {
      ...operatorPayload,
      tenantId: "t-1",
    } as never);
    expect(restrictions.assertLinesSellable.mock.calls[0][0].at).toBeUndefined();
  });

  it("a refusal (409 SELLING_RESTRICTED) is thrown before ANY write — no transaction, no order", async () => {
    restrictions.assertLinesSellable.mockRejectedValue(
      new ConflictException({ code: "SELLING_RESTRICTED", blockedLines: [] }),
    );
    await expect(
      service.create(input(), { ...customerPayload, tenantId: "t-1" } as never),
    ).rejects.toMatchObject({ response: { code: "SELLING_RESTRICTED" } });
    expect(prisma.tenantTransaction).not.toHaveBeenCalled();
    expect(prisma.order.create).not.toHaveBeenCalled();
  });

  it("a DRAFT is not a sale yet: never checked here (its promotion is the enforcement point)", async () => {
    // F1(ii): a buyer can no longer start a draft at all; a staff draft is the case that skips the check.
    prisma.customer.findUnique.mockResolvedValue({
      id: "cust-1",
      pricingTier: 1,
      user: { status: "ACTIVE" },
      deletedAt: null,
    });
    await service.create(input({ status: "DRAFT", customerId: "cust-1" }), {
      ...operatorPayload,
      tenantId: "t-1",
    } as never);
    expect(restrictions.assertLinesSellable).not.toHaveBeenCalled();
  });

  // Even with the feature OFF: the tenant is needed to READ the tenant's policy, so a caller that
  // cannot name one is refused rather than assumed OFF (fail closed; the price of a check that can
  // never be skipped by omitting the tenant). Staff and buyer alike.
  it.each([
    ["a buyer", { ...customerPayload, tenantId: null }],
    ["a staff principal", operatorPayload],
  ])(
    "%s with no tenant on the caller and none ambient: refused (403) rather than skipped",
    async (_who, principal) => {
      (prisma.getTenantId as jest.Mock).mockReturnValue(null);
      prisma.customer.findUnique.mockResolvedValue(activeCustomer);
      await expect(
        service.create(input({ customerId: "cust-1" }), principal as never),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(restrictions.assertLinesSellable).not.toHaveBeenCalled();
      expect(prisma.tenantTransaction).not.toHaveBeenCalled();
    },
  );
});
