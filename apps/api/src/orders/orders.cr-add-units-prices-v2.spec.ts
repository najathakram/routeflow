/**
 * Row 497 (SA ruling, option B): the buyer's FULL-LIST replace of PACK lines (updateOrderItems, CUSTOMER branch)
 * used to re-price every line at the buyer's current tier, so an operator override on a line the buyer left
 * alone was lost. Now an UNCHANGED line (same product, same unit, paired to its stored line) that carries an
 * OVERRIDE (DISCOUNTED / MANUAL, or SPECIAL with a stored reason) keeps unitPrice, priceType, originalPrice,
 * overrideReason and overriddenBy; the subtotal is recomputed from the kept price. A PLAIN tier line
 * (STANDARD, or SPECIAL without a reason) still re-prices at the current tier (SA-507b, as the unit buyer diff
 * does), and a new line or a changed product prices fresh at the tier.
 * Row 496: the same DTO's overrideReason is capped, trimmed and refused when formula-led.
 * Harness: copied from orders.update-items-guards.spec.ts (mocked PrismaService).
 */
jest.mock("./driver-edit-access", () => ({ assertDriverMayEditOrder: jest.fn() }));
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

import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { UpdateOrderItemsDto } from "./dto/update-order-items.dto";
import { CreateOrderDto } from "./dto/create-order.dto";
import { ForbiddenException } from "@nestjs/common";
import { assertSafeOverrideReasons } from "./buyer-replace-keep";

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
  tenantSlug: "test",
  status: "ACTIVE" as const,
  forcePasswordChange: false,
};

const V2 = "flag.units_prices_v2";
let v2On = true;
const hasFlagMock = jest.fn(async (_t: string, k: string) => k !== V2 || v2On);

describe("S19: a door ADD_ITEM change request prices the new line from the customer layer", () => {
  let service: OrdersService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let promotions: { activeForCatalog: jest.Mock };

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
          useValue: { hasFlag: hasFlagMock },
        },
        // B65: deleteOrder's per-invoice teardown reverses regulated-ledger entries.
        {
          provide: RegulatedLedgerService,
          useValue: { reverseInvoiceEntries: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();

    service = module.get<OrdersService>(OrdersService);
    promotions = module.get(PromotionsService);
  });
  const product = {
    id: "prod-a",
    pricePerUnit: 12,
    priceTier2: null,
    unitsPerBox: 12,
    category: null,
    trackedCategoryId: null,
    trackedSubcategoryId: null,
    kind: "STANDARD",
    isActive: true,
    portalVisible: true,
    parent: null,
  };
  const typed = (...rows: Array<[string, number]>) => {
    (prisma.forTenant() as any).customerUnitPrice = {
      findMany: jest
        .fn()
        .mockResolvedValue(
          rows.map(([unitRef, price]) => ({ productId: "prod-a", unitRef, price })),
        ),
    };
  };
  const approve = async () => {
    prisma.changeRequest.findUnique.mockResolvedValue({
      id: "cr-1",
      tenantId: "test-tenant",
      orderId: "ord-1",
      orderItemId: null,
      productId: "prod-a",
      routeRunStopId: "stop-1",
      type: "ADD_ITEM",
      status: "PENDING",
      payload: { productId: "prod-a", qty: 2 },
      note: null,
      requestedById: "user-cust",
      requestedByName: "Buyer Co",
      requestedByRole: "CUSTOMER",
    });
    prisma.order.findUnique.mockResolvedValue({
      id: "ord-1",
      customerId: "cust-1",
      orderNumber: "ORD-123",
      status: "OUT_FOR_DELIVERY",
      subtotal: 0,
      tax: 0,
      total: 0,
      routeRunId: "run-1",
      routeRunStopId: "stop-1",
      lineItems: [],
      routeRun: { id: "run-1", status: "IN_PROGRESS", driverId: "drv-1" },
      routeRunStop: { id: "stop-1", status: "PENDING" },
    });
    prisma.changeRequest.updateMany.mockResolvedValue({ count: 1 });
    prisma.customer.findUnique.mockResolvedValue({ creditLimit: null, pricingTier: 1 });
    prisma.customer.findFirst.mockResolvedValue({ id: "cust-1", pricingTier: 1 });
    prisma.orderRevision.aggregate.mockResolvedValue({ _max: { revisionNumber: null } });
    prisma.product.findUnique.mockResolvedValue(product);
    prisma.product.findFirst.mockResolvedValue(product);
    prisma.orderItem.create.mockResolvedValue({ id: "li-new" });
    await service.approveChangeRequestAtStop(
      "cr-1",
      { sub: "user-op", role: "OPERATOR" } as never,
      null,
    );
    return prisma.orderItem.create.mock.calls[0][0].data;
  };

  it("flag on: the new line is the customer's typed pack price (SPECIAL), above a remembered price", async () => {
    v2On = true;
    typed(["pack", 9]);
    jest.spyOn(service, "getCustomerPriceHistory").mockResolvedValue({
      "prod-a": { lastPrice: 15, listPriceAtTime: 12 },
    });
    expect(await approve()).toMatchObject({ unitPrice: 9, priceType: "SPECIAL" });
  });

  it("flag OFF with typed rows present: master's price (the sticky $15 MANUAL), rows ignored", async () => {
    v2On = false;
    typed(["pack", 9]);
    jest.spyOn(service, "getCustomerPriceHistory").mockResolvedValue({
      "prod-a": { lastPrice: 15, listPriceAtTime: 12 },
    });
    expect(await approve()).toMatchObject({ unitPrice: 15, priceType: "MANUAL" });
    expect(hasFlagMock).toHaveBeenCalledWith(expect.anything(), V2);
  });
});
