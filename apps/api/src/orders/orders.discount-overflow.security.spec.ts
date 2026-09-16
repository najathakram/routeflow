import { Test, TestingModule } from "@nestjs/testing";
import { getQueueToken } from "@nestjs/bull";
import { ConfigService } from "@nestjs/config";

jest.mock("../common/db-locks", () => ({
  ...jest.requireActual("../common/db-locks"),
  withAdvisoryLock: jest.fn(async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  })),
}));

jest.mock("../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({
    createFromOrder: jest.fn().mockResolvedValue({ id: "inv-1" }),
    findAll: jest.fn().mockResolvedValue({ data: [], meta: {} }),
  })),
}));

jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({
    sendToCustomer: jest.fn().mockResolvedValue(undefined),
    sendToDriver: jest.fn().mockResolvedValue(undefined),
  })),
}));

import { OrdersService } from "./orders.service";
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
import { Prisma } from "@prisma/client";

const MOCK_PRODUCT = { id: "prod-1", name: "Tomatoes", pricePerUnit: 4.99, unit: "punnet" };

const operatorPayload = {
  sub: "user-op",
  username: "operator",
  role: "OPERATOR" as const,
  status: "ACTIVE" as const,
  forcePasswordChange: false,
};

/**
 * B451 — Strix coverage gap 4 (business-logic financial-total manipulation)
 * on POST /orders. Phase A CONFIRMED this: unlike CreateInvoiceDto's
 * create() path (invoices.service.ts:469-502, which already rejects a
 * negative line subtotal, a discount exceeding subtotal, and a negative
 * total), orders.service.ts create() computed
 * `total = subtotal + tax + categoryTax - orderDiscount + orderShippingFee`
 * with NO equivalent guard — discountAmount is DTO-bounded to
 * [0, 1_000_000] (create-order.dto.ts) but was never compared against the
 * order's own subtotal, so a bounded-but-oversized discount drove the
 * persisted total negative.
 *
 * Phase B FIX: `assertMoneyInvariantsOrThrow` (the shared
 * `@routeflow/pricing` guard) now runs right after `total` is computed and
 * before any stock lock or transaction opens — this spec now pins the FIXED
 * behavior (400 MONEY_INVARIANT, nothing persisted).
 */
describe("OrdersService.create — discount-overflow negative total (B451 gap 4)", () => {
  let service: OrdersService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const tenantCtx = { run: jest.fn((_tenantId: string | null, fn: () => unknown) => fn()) };
    const mockQueue = { add: jest.fn() };
    const mockGateway = {
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
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(0) } },
        {
          provide: InvoicesService,
          useValue: {
            createFromOrder: jest.fn().mockResolvedValue({ id: "inv-1" }),
            createInvoiceFromOrder: jest.fn().mockResolvedValue([{ id: "inv-1" }]),
            createInvoiceFromOrderWithTenant: jest.fn().mockResolvedValue([{ id: "inv-1" }]),
            findOpenOrderDraft: jest.fn().mockResolvedValue(null),
            reconcileOrderDraftInvoice: jest.fn().mockResolvedValue({ id: "inv-1" }),
          },
        },
        {
          provide: SystemConfigService,
          useValue: {
            get: jest.fn().mockResolvedValue("0"),
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
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(true) } },
        {
          provide: RegulatedLedgerService,
          useValue: { reverseInvoiceEntries: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: TenantContextService, useValue: tenantCtx },
      ],
    }).compile();

    service = module.get<OrdersService>(OrdersService);
  });

  it("FIXED: a DTO-legal discountAmount exceeding the order subtotal now 400s and persists nothing", async () => {
    prisma.customer.findUnique.mockResolvedValue({ pricingTier: 1, user: { status: "ACTIVE" } });
    prisma.customerPrice.findMany.mockResolvedValue([]);
    prisma.product.findMany.mockResolvedValue([MOCK_PRODUCT]);
    prisma.order.create.mockImplementation((args: any) =>
      Promise.resolve({
        id: "ord-1",
        orderNumber: "ORD-1",
        customerId: "cust-1",
        customer: { businessName: "Test Biz" },
        urgent: false,
        createdAt: new Date(),
        ...args.data,
      }),
    );

    // Line subtotal = 1 × 4.99 = 4.99. discountAmount = 500 is well inside the
    // DTO's own @Min(0) @Max(1_000_000) bound on CreateOrderDto — nothing at
    // the DTO layer rejects it, so this is now caught by
    // assertMoneyInvariantsOrThrow instead.
    await expect(
      service.create(
        {
          customerId: "cust-1",
          items: [{ productId: "prod-1", qty: 1 }],
          discountAmount: 500,
        } as any,
        operatorPayload,
      ),
    ).rejects.toMatchObject({
      status: 400,
      response: { code: "MONEY_INVARIANT" },
    });

    expect(prisma.order.create).not.toHaveBeenCalled();
  });
});
