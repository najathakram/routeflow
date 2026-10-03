// SA-429 (#2377): these driver cases pin OTHER behaviour (pricing, merges, restrictions, returns),
// not ownership, and their mocks carry no assigned run; the ownership predicate itself is pinned by
// driver-edit-access.spec.ts and driver-edit-access.db.spec.ts.
jest.mock("./driver-edit-access", () => ({ assertDriverMayEditOrder: jest.fn() }));
/**
 * OWNER RULING 2026-10-03: a customer always gets their own tier / special price, whoever enters
 * the item, and a DRIVER still can't set a custom price or discount. Before the fix a driver-added
 * (diff ADD), substituted or replace-all line billed at LIST because the edit-items branches forced
 * tier 1 for non-staff. Now NEW and SUBSTITUTED driver lines resolve the customer's tier/special
 * price exactly as a staff line does; a client-sent price/discount from a driver is still ignored,
 * and a qty edit of an existing line keeps its stored price (no retro re-pricing). SIBLING spec
 * (orders.service.spec.ts is at its size-ratchet cap).
 */
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
import { BadRequestException } from "@nestjs/common";
import * as fs from "fs";
import * as path from "path";
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

describe("OrdersService — driver lines resolve the customer tier price (ruling 2026-10-03)", () => {
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
          useValue: { reverseInvoiceEntries: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();

    service = module.get<OrdersService>(OrdersService);
    invoicesService = module.get(InvoicesService);
    promotionsService = module.get(PromotionsService);
  });

  // list 10, tier-2 price 8, tier-3 price 7; boxed twin: list BOX price 120, tier-2 box price 100.
  const PRODUCT = {
    id: "prod-1",
    name: "Tiered Widget",
    pricePerUnit: 10,
    priceTier2: 8,
    priceTier3: 7,
    unitsPerBox: null as number | null,
    category: null,
    trackedCategoryId: null,
    trackedSubcategoryId: null,
  };
  const BOXED = {
    ...PRODUCT,
    id: "prod-2",
    name: "Case Widget",
    pricePerUnit: 120,
    priceTier2: 100,
    unitsPerBox: 24,
  };
  const line = (over: Record<string, unknown> = {}) => ({
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
    overrideReason: null,
    ...over,
  });
  function prime(lineItems: unknown[], tier = 1, products: any[] = [PRODUCT]) {
    prisma.order.findUnique.mockResolvedValue({ ...MOCK_ORDER, status: "PENDING", lineItems });
    prisma.customer.findFirst.mockResolvedValue({ pricingTier: tier });
    prisma.customerPrice.findMany.mockResolvedValue([]);
    prisma.product.findFirst.mockResolvedValue(products[0]);
    prisma.product.findUnique.mockResolvedValue(products[0]);
    prisma.product.findUniqueOrThrow.mockResolvedValue(products[0]);
    prisma.product.findMany.mockResolvedValue(products);
    prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 12, status: "PENDING" }]);
  }
  const as = (role: "driver" | "operator") => (role === "driver" ? driverPayload : operatorPayload);
  const add = (role: "driver" | "operator", extra: Record<string, unknown> = {}) =>
    service.updateOrderItems(
      "ord-1",
      { items: [{ productId: "prod-1", qty: 2, ...extra }], replaceAll: false } as any,
      as(role) as any,
    );
  const created = () => (prisma.orderItem.create as jest.Mock).mock.calls[0][0].data;
  const updated = () => (prisma.orderItem.update as jest.Mock).mock.calls[0][0].data;
  const clearCreated = () => (prisma.orderItem.create as jest.Mock).mockClear();

  describe("diff ADD (a driver adds an item to an order)", () => {
    it("D1: a driver add for a tier-2 customer bills at tier 2 (SPECIAL, original = list), not list", async () => {
      prime([], 2);
      await add("driver");
      expect(created()).toMatchObject({ unitPrice: 8, priceType: "SPECIAL", originalPrice: 10 });
      expect(created().subtotal).toBe(16);
    });

    it("D2: a per-product customer special price (CustomerPrice row) beats the customer default tier", async () => {
      prime([], 1);
      prisma.customerPrice.findMany.mockResolvedValue([{ productId: "prod-1", pricingTier: 3 }]);
      await add("driver");
      expect(created()).toMatchObject({ unitPrice: 7, priceType: "SPECIAL", originalPrice: 10 });
    });

    it("D3: a driver-sent unitPrice / overrideReason / discount is ignored: the same line as sending none", async () => {
      prime([], 2);
      await add("driver", {
        unitPrice: 1,
        overrideReason: "pls",
        discount: 5,
        priceType: "MANUAL",
      });
      const sent = created();
      clearCreated();
      await add("driver");
      expect(sent).toMatchObject({ unitPrice: 8, priceType: "SPECIAL", originalPrice: 10 });
      expect(sent.unitPrice).toBe(created().unitPrice);
      expect(sent.overriddenBy ?? null).toBeNull();
      expect(sent.overrideReason ?? null).toBeNull();
    });

    it("D4: a customer with no tier (tier 1, no special row) is billed list / STANDARD", async () => {
      prime([], 1);
      await add("driver");
      expect(created()).toMatchObject({
        unitPrice: 10,
        priceType: "STANDARD",
        originalPrice: null,
      });
    });

    it("D5: boxed: 1 box of 24 at the tier-2 BOX price is $100, never qty x box price; loose pieces prorate", async () => {
      prime([], 2, [BOXED]);
      await service.updateOrderItems(
        "ord-1",
        { items: [{ productId: "prod-2", boxes: 1, pieces: 0 }], replaceAll: false } as any,
        driverPayload as any,
      );
      expect(created()).toMatchObject({ unitPrice: 100, subtotal: 100, priceType: "SPECIAL" });
      clearCreated();
      await service.updateOrderItems(
        "ord-1",
        { items: [{ productId: "prod-2", boxes: 0, pieces: 12 }], replaceAll: false } as any,
        driverPayload as any,
      );
      expect(created()).toMatchObject({ unitPrice: 100, subtotal: 50 });
    });

    it("D6: parity: a driver add resolves identically to the same add by an operator (tier, promos, price)", async () => {
      prime([], 2);
      promotionsService.activeForCatalog.mockResolvedValue([
        {
          id: "pr-1",
          type: "PERCENT",
          value: 50,
          minQty: null,
          scope: "ALL",
          category: null,
          productIds: [],
        },
      ]);
      await add("operator");
      const staff = created();
      clearCreated();
      await add("driver");
      const drv = created();
      for (const k of ["unitPrice", "subtotal", "priceType", "originalPrice", "qty"]) {
        expect(drv[k]).toEqual(staff[k]);
      }
    });

    it("D7: tenant isolation: the tier and special-price lookups are keyed to THIS order's customer", async () => {
      prime([], 2);
      await add("driver");
      expect(prisma.customer.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "cust-1" } }),
      );
      expect(prisma.customerPrice.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ customerId: "cust-1" }) }),
      );
    });
  });

  describe("staff behaviour is unchanged", () => {
    it("S1: an operator add with no typed price is tier-priced; typed below list is DISCOUNTED, above is MANUAL", async () => {
      prime([], 2);
      await add("operator");
      expect(created()).toMatchObject({ unitPrice: 8, priceType: "SPECIAL", originalPrice: 10 });
      clearCreated();
      await add("operator", { unitPrice: 5, overrideReason: "x" });
      expect(created()).toMatchObject({
        unitPrice: 5,
        priceType: "DISCOUNTED",
        originalPrice: 10,
      });
      clearCreated();
      await add("operator", { unitPrice: 12, overrideReason: "x" });
      expect(created()).toMatchObject({ unitPrice: 12, priceType: "MANUAL", originalPrice: 10 });
    });

    it("S2: an operator edit of a stored price still honours the typed price", async () => {
      prime([line()], 2);
      await service.updateOrderItems(
        "ord-1",
        {
          items: [{ id: "li-1", action: "UPDATE", qty: 3, unitPrice: 9, overrideReason: "x" }],
        } as any,
        operatorPayload as any,
      );
      expect(updated()).toMatchObject({ unitPrice: 9, priceType: "DISCOUNTED" });
    });
  });

  describe("existing driver lines are not re-priced", () => {
    it("E1: a driver qty edit keeps the stored price (an agreed price is never silently moved to tier)", async () => {
      prime([line({ unitPrice: 10, subtotal: 30 })], 2);
      await service.updateOrderItems(
        "ord-1",
        { items: [{ id: "li-1", action: "UPDATE", qty: 5, unitPrice: 1 }] } as any,
        driverPayload as any,
      );
      const data = updated();
      expect(data.unitPrice ?? 10).toBe(10);
      expect(data.subtotal).toBe(50);
      expect(data.priceType ?? "STANDARD").toBe("STANDARD");
    });
  });

  describe("driver substitute", () => {
    const substitute = (role: "driver" | "operator", extra: Record<string, unknown> = {}) =>
      service.updateOrderItems(
        "ord-1",
        {
          items: [{ id: "li-1", substituteProductId: "prod-1", qty: 2, ...extra }],
          replaceAll: false,
        } as any,
        as(role) as any,
      );

    it("U1: a driver substitute bills the substitute at the customer tier price, a driver-sent price ignored", async () => {
      prime([line({ productId: "prod-9" })], 2);
      await substitute("driver", { unitPrice: 1, overrideReason: "pls" });
      expect(updated()).toMatchObject({
        productId: "prod-1",
        unitPrice: 8,
        priceType: "SPECIAL",
        originalPrice: 10,
        overriddenBy: null,
      });
    });

    it("U2: a driver substitute honours a per-product special price; a staff substitute is unchanged", async () => {
      prime([line({ productId: "prod-9" })], 1);
      prisma.customerPrice.findMany.mockResolvedValue([{ productId: "prod-1", pricingTier: 3 }]);
      await substitute("driver");
      expect(updated()).toMatchObject({ unitPrice: 7, priceType: "SPECIAL" });
      (prisma.orderItem.update as jest.Mock).mockClear();
      await substitute("operator");
      expect(updated()).toMatchObject({ unitPrice: 7, priceType: "SPECIAL" });
    });
  });

  describe("driver replace-all (full item list, no ids)", () => {
    it("R1: every line the driver lists resolves the customer tier price, never list", async () => {
      prime([], 2);
      await service.updateOrderItems(
        "ord-1",
        { items: [{ productId: "prod-1", qty: 2, unitPrice: 1 }] } as any,
        driverPayload as any,
      );
      expect(created()).toMatchObject({ unitPrice: 8, priceType: "SPECIAL", originalPrice: 10 });
    });
  });

  describe("create() at the door (already tier-priced: pinned, unchanged)", () => {
    it("C1: a driver-created order for a tier-2 customer bills tier 2, a driver-sent unitPrice ignored", async () => {
      prisma.customer.findUnique.mockResolvedValue({ id: "cust-1", pricingTier: 2 });
      prisma.customer.findFirst.mockResolvedValue({ pricingTier: 2, fulfillPath: null });
      prisma.customerPrice.findMany.mockResolvedValue([]);
      prisma.product.findMany.mockResolvedValue([PRODUCT]);
      prisma.order.create.mockResolvedValue(MOCK_ORDER);
      (service as any).systemConfig.get.mockResolvedValue("0");

      await service.create(
        { customerId: "cust-1", items: [{ productId: "prod-1", qty: 1, unitPrice: 1 }] },
        driverPayload as any,
      );

      expect(prisma.order.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            lineItems: {
              create: expect.arrayContaining([
                expect.objectContaining({ unitPrice: 8, priceType: "SPECIAL", originalPrice: 10 }),
              ]),
            },
          }),
        }),
      );
    });
  });
});
