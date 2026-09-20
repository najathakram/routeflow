/**
 * units_v1 step 4b-2b — `OrdersService.create` sells by a unit of the product's ladder for STAFF
 * behind `flag.units_v1`; a pack-only request is byte-identical. The builder itself is proven in
 * `unit-line-build.spec.ts`; this pins the WIRING: what create() reads, refuses and writes.
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

import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, ForbiddenException } from "@nestjs/common";
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

describe("OrdersService.create — sell by a unit (units_v1, 4b-2b)", () => {
  let service: OrdersService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
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
  });

  // A 24-piece box at $42; a Case of 288 with an explicit $480; a Pallet with no price (derived).
  const PRODUCT = {
    id: "prod-1",
    name: "Widget",
    unit: "Box",
    pricePerUnit: 42,
    unitsPerBox: 24,
    category: null,
    trackedCategoryId: null,
    trackedSubcategoryId: null,
    isActive: true,
  };
  const ladder = [
    { productId: "prod-1", label: "Case", factorToBase: 288, price: "480.00", sortOrder: 0 },
    { productId: "prod-1", label: "Pallet", factorToBase: 5760, price: null, sortOrder: 1 },
  ].map((u) => ({ priceTier2: null, priceTier3: null, priceTier4: null, priceTier5: null, ...u }));
  const staff = { ...operatorPayload, tenantId: "t-1" } as never;
  const hasFlag = () => (service as any).entitlements.hasFlag as jest.Mock;
  const orderData = () => prisma.order.create.mock.calls[0][0].data;

  beforeEach(() => {
    prisma.customer.findFirst.mockResolvedValue({ id: "cust-1", pricingTier: 1 });
    prisma.customer.findUnique.mockResolvedValue({
      id: "cust-1",
      pricingTier: 1,
      user: { status: "ACTIVE" },
      deletedAt: null,
    });
    prisma.product.findMany.mockResolvedValue([PRODUCT]);
    prisma.productUnit.findMany.mockResolvedValue(ladder);
    prisma.order.create.mockResolvedValue({
      id: "ord-new",
      customerId: "cust-1",
      orderNumber: "x",
      total: 0,
      urgent: false,
      createdAt: new Date(),
      customer: { id: "cust-1", businessName: "Acme" },
      lineItems: [],
    });
    (prisma.tenantTransaction as jest.Mock).mockImplementation((fn: any) =>
      fn({
        ...prisma,
        $queryRaw: jest.fn().mockResolvedValue([{ max: null }]),
        $executeRaw: jest.fn().mockResolvedValue(0),
      }),
    );
    hasFlag().mockResolvedValue(true);
  });
  const create = (items: unknown[], user: never = staff) =>
    service.create({ customerId: "cust-1", items } as never, user);

  it("writes a Case line from the SERVER ladder: unit count, base-piece qty, factor snapshot, unit price — and never auto-merges the order", async () => {
    await create([{ productId: "prod-1", qty: 3, unitLabel: "Case" }]);
    const d = orderData();
    expect(d.lineItems.create).toHaveLength(1);
    expect(d.lineItems.create[0]).toMatchObject({
      productId: "prod-1",
      unitLabel: "Case",
      boxes: 3,
      pieces: 0,
      qty: 864,
      unitsPerBox: 288,
      unitPrice: 480,
      subtotal: 1440,
      position: 0,
      tenantId: "test-tenant",
    });
    expect(d.subtotal).toBe(1440);
    expect(d.skipAutoMerge).toBe(true);
    expect(prisma.productUnit.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.productUnit.findMany.mock.calls[0][0].where).toEqual({
      productId: { in: ["prod-1"] },
    });
    expect(hasFlag()).toHaveBeenCalledWith("test-tenant", "flag.units_v1");
  });

  it("a mixed order keeps its pack line exactly as before next to a unit line", async () => {
    await create([
      { productId: "prod-1", qty: 2, boxes: 2, pieces: 0 }, // pack: 2 boxes of 24 at $42
      { productId: "prod-1", qty: 1, unitLabel: "Pallet" }, // derived 42 x 5760 / 24 = 10080
    ]);
    const [pack, pallet] = orderData().lineItems.create;
    expect(pack).toMatchObject({ boxes: 2, qty: 48, unitsPerBox: 24, unitPrice: 42, subtotal: 84 });
    expect("unitLabel" in pack).toBe(false);
    expect(pallet).toMatchObject({ unitLabel: "Pallet", unitPrice: 10080, position: 1 });
    expect(orderData().subtotal).toBe(10164);
    expect(orderData().skipAutoMerge).toBe(true);
  });

  it("a pack-only request reads nothing new: no ladder query, no entitlement lookup, merge behaviour unchanged", async () => {
    await create([{ productId: "prod-1", qty: 1 }]);
    expect(prisma.productUnit.findMany).not.toHaveBeenCalled();
    expect(hasFlag()).not.toHaveBeenCalled();
    expect(orderData().skipAutoMerge).toBe(false);
    expect("unitLabel" in orderData().lineItems.create[0]).toBe(false);
  });

  it("the pack's own label (or a blank one) is a plain pack line, not a unit line", async () => {
    await create([
      { productId: "prod-1", qty: 1, boxes: 1, unitLabel: "Box" },
      { productId: "prod-1", qty: 1, boxes: 1, unitLabel: "  " },
    ]);
    for (const line of orderData().lineItems.create) {
      expect("unitLabel" in line).toBe(false);
      expect(line).toMatchObject({ boxes: 1, unitsPerBox: 24, unitPrice: 42 });
    }
    expect(orderData().skipAutoMerge).toBe(false);
  });

  it.each([
    ["a buyer", { ...customerPayload, tenantId: "t-1" }, BadRequestException],
    ["a tenant without flag.units_v1", staff, ForbiddenException],
  ])("%s asking for a unit is refused BEFORE any write", async (who, user, err) => {
    if (who !== "a buyer") hasFlag().mockResolvedValue(false);
    await expect(
      create([{ productId: "prod-1", qty: 1, unitLabel: "Case" }], user as never),
    ).rejects.toBeInstanceOf(err);
    expect(prisma.tenantTransaction).not.toHaveBeenCalled();
    expect(prisma.order.create).not.toHaveBeenCalled();
  });

  it("an unknown unit, boxes beside a unit, and a unit on a custom line are 400s that write nothing", async () => {
    for (const items of [
      [{ productId: "prod-1", qty: 1, unitLabel: "Bogus" }],
      [{ productId: "prod-1", qty: 1, boxes: 1, unitLabel: "Case" }],
      [{ name: "Delivery", qty: 1, unitPrice: 5, unitLabel: "Case" }],
    ]) {
      await expect(create(items)).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(prisma.order.create).not.toHaveBeenCalled();
  });

  it("a staff-typed unit price is a one-time DISCOUNTED price against the tier-1 unit price", async () => {
    await create([{ productId: "prod-1", qty: 2, unitLabel: "Case", unitPrice: 450 }]);
    expect(orderData().lineItems.create[0]).toMatchObject({
      unitPrice: 450,
      priceType: "DISCOUNTED",
      originalPrice: 480,
      subtotal: 900,
    });
  });
});
