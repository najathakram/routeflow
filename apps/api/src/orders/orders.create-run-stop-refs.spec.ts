/**
 * B1106 / SA-1105 PR B (writer 4): `OrdersService.create` stores the caller-supplied `routeRunId` / `routeRunStopId` on the
 * order. The DRIVER branch proves them (own, in-progress run; B309); the OPERATOR / TENANT_ADMIN branch stored them unread, and
 * an FK is no tenant proof. A foreign run or stop is the same 404 as a missing one and nothing is written. Harness copied from
 * `orders.create-restrictions.spec.ts`.
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
import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
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
import { wireStockHelper } from "../inventory/testing/stock-helper-mock";

let stock!: ReturnType<typeof wireStockHelper>;

const operatorPayload = {
  sub: "user-op",
  username: "operator",
  role: "OPERATOR" as const,
  status: "ACTIVE" as const,
  forcePasswordChange: false,
};

describe("OrdersService.create — staff run and stop ids are tenant-proven (B1106 PR B)", () => {
  let service: OrdersService;
  let moduleRef: TestingModule;
  const featureConfig = { getEffectiveMode: jest.fn() };
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    featureConfig.getEffectiveMode.mockReset().mockResolvedValue("unset");
    prisma = createMockPrisma();
    stock = wireStockHelper(prisma, { ample: true });

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
          useValue: {
            reverseInvoiceEntries: jest.fn().mockResolvedValue(undefined),
            settleRegulatedLedger: jest.fn().mockResolvedValue({ written: 0, amendedPeriod: null }),
          },
        },
      ],
    }).compile();

    moduleRef = module;
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
  const arrange = () => {
    prisma.customer.findUnique.mockResolvedValue({
      id: "cust-1",
      pricingTier: 1,
      user: { status: "ACTIVE" },
      deletedAt: null,
    });
    prisma.product.findMany.mockResolvedValue([MOCK_PRODUCT]);
    prisma.order.create.mockResolvedValue(NEW_ORDER);
    (prisma.tenantTransaction as jest.Mock).mockImplementation((fn: any) =>
      fn({
        ...prisma,
        $queryRaw: stock.queryRaw(jest.fn().mockResolvedValue([{ max: null }])),
        $executeRaw: jest.fn().mockResolvedValue(0),
      }),
    );
  };
  const input = (over: Record<string, unknown>) =>
    ({ customerId: "cust-1", items: [{ productId: "prod-1", qty: 1 }], ...over }) as never;
  const staff = (role: "OPERATOR" | "TENANT_ADMIN") =>
    ({ ...operatorPayload, role, tenantId: "t-1" }) as never;

  describe.each(["OPERATOR", "TENANT_ADMIN"] as const)("%s", (role) => {
    it("a routeRunId outside the tenant is a 404 'Run not found' and nothing is written", async () => {
      arrange();
      prisma.routeRun.findMany.mockResolvedValue([]); // the tenant-scoped read finds nothing
      const err = await service
        .create(input({ routeRunId: "run-of-another-tenant" }), staff(role))
        .catch((e) => e);
      expect(err).toBeInstanceOf(NotFoundException);
      expect(err.message).toBe("Run not found");
      expect(prisma.order.create).not.toHaveBeenCalled();
      expect(prisma.order.update).not.toHaveBeenCalled();
      expect(prisma.tenantTransaction).not.toHaveBeenCalled();
    });

    it("a routeRunStopId outside the tenant is a 404 'Stop not found' and nothing is written", async () => {
      arrange();
      prisma.routeRunStop.findMany.mockResolvedValue([]);
      const err = await service
        .create(input({ routeRunStopId: "stop-of-another-tenant" }), staff(role))
        .catch((e) => e);
      expect(err).toBeInstanceOf(NotFoundException);
      expect(err.message).toBe("Stop not found");
      expect(prisma.order.create).not.toHaveBeenCalled();
      expect(prisma.order.update).not.toHaveBeenCalled();
      expect(prisma.tenantTransaction).not.toHaveBeenCalled();
    });

    it("a run and a stop inside the tenant are linked as before", async () => {
      arrange();
      prisma.routeRun.findMany.mockResolvedValue([{ id: "run-1" }]);
      prisma.routeRunStop.findMany.mockResolvedValue([{ id: "stop-1" }]);
      await service.create(input({ routeRunId: "run-1", routeRunStopId: "stop-1" }), staff(role));
      expect(prisma.order.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ routeRunId: "run-1", routeRunStopId: "stop-1" }),
        }),
      );
    });
  });

  it("an order with no run and no stop reads neither (the proof skips empty values)", async () => {
    arrange();
    await service.create(input({}), staff("OPERATOR"));
    expect(prisma.routeRun.findMany).not.toHaveBeenCalled();
    expect(prisma.routeRunStop.findMany).not.toHaveBeenCalled();
  });

  describe("status DRAFT with a run link and immediateDelivery (SA-1158)", () => {
    const linked = { routeRunId: "run-1", routeRunStopId: "stop-1" };
    const link = () => {
      prisma.routeRun.findMany.mockResolvedValue([{ id: "run-1" }]);
      prisma.routeRunStop.findMany.mockResolvedValue([{ id: "stop-1" }]);
    };

    it.each(["OPERATOR", "TENANT_ADMIN"] as const)(
      "%s: status DRAFT + routeRunStopId + immediateDelivery true is 400 ORDER_DRAFT_CANNOT_DELIVER_NOW and nothing is written",
      async (role) => {
        arrange();
        link();
        const err = await service
          .create(input({ status: "DRAFT", ...linked, immediateDelivery: true }), staff(role))
          .catch((e) => e);
        expect(err).toBeInstanceOf(BadRequestException);
        expect(err.getStatus()).toBe(400);
        expect(err.getResponse().code).toBe("ORDER_DRAFT_CANNOT_DELIVER_NOW");
        expect(prisma.order.create).not.toHaveBeenCalled();
        expect(prisma.order.update).not.toHaveBeenCalled();
        expect(prisma.tenantTransaction).not.toHaveBeenCalled();
      },
    );

    it("status DRAFT + routeRunId + immediateDelivery true is refused the same way, with no stop id", async () => {
      arrange();
      link();
      const err = await service
        .create(
          input({ status: "DRAFT", routeRunId: "run-1", immediateDelivery: true }),
          staff("OPERATOR"),
        )
        .catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getStatus()).toBe(400);
      expect(err.getResponse().code).toBe("ORDER_DRAFT_CANNOT_DELIVER_NOW");
      expect(prisma.order.create).not.toHaveBeenCalled();
    });

    it("guard: status DRAFT + a run link without immediateDelivery is created and linked, never written CONFIRMED", async () => {
      arrange();
      link();
      prisma.order.create.mockResolvedValue({ ...NEW_ORDER, status: "DRAFT" });
      await service.create(input({ status: "DRAFT", ...linked }), staff("OPERATOR"));
      const update = prisma.order.update.mock.calls[0][0];
      expect(update.data).toMatchObject({ routeRunId: "run-1", routeRunStopId: "stop-1" });
      expect(update.data.status).not.toBe("CONFIRMED");
    });

    it("guard: status DRAFT + immediateDelivery false is not refused", async () => {
      arrange();
      link();
      prisma.order.create.mockResolvedValue({ ...NEW_ORDER, status: "DRAFT" });
      await expect(
        service.create(
          input({ status: "DRAFT", ...linked, immediateDelivery: false }),
          staff("OPERATOR"),
        ),
      ).resolves.toBeDefined();
    });

    it("guard: a non-DRAFT order with a run link and immediateDelivery true is written CONFIRMED", async () => {
      arrange();
      link();
      const creditGate = jest.spyOn(service as any, "creditGate").mockResolvedValue(undefined);
      const out: any = await service.create(
        input({ ...linked, immediateDelivery: true }),
        staff("OPERATOR"),
      );
      // the three entry checks ran, and stock was taken
      expect(moduleRef.get(AuthorizationGuardService).assertAuthorizedOrThrow).toHaveBeenCalled();
      expect(moduleRef.get(SellingRestrictionsService).assertLinesSellable).toHaveBeenCalled();
      expect(creditGate).toHaveBeenCalledTimes(1);
      expect(stock.written().length).toBeGreaterThan(0);
      expect(prisma.order.update.mock.calls[0][0].data.status).toBe("CONFIRMED");
      expect(out.status).toBe("CONFIRMED");
    });
  });

  it("a DRIVER keeps the B309 refusal (403, own run only) and never reaches the staff proof", async () => {
    arrange();
    prisma.driver.findFirst.mockResolvedValue({ id: "drv-1" });
    prisma.routeRun.findFirst.mockResolvedValue(null); // the run is not in the driver's tenant
    const err = await service
      .create(input({ routeRunId: "run-of-another-tenant" }), {
        ...operatorPayload,
        role: "DRIVER",
        tenantId: "t-1",
      } as never)
      .catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(prisma.routeRun.findMany).not.toHaveBeenCalled();
    expect(prisma.order.create).not.toHaveBeenCalled();
  });
});
