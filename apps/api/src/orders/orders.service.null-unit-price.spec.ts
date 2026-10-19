/**
 * Register row 591 — a `null` line price is NO override, exactly as an absent one.
 *
 * `UpdateOrderItemDto.unitPrice` is `@IsOptional() @IsNumber()`: class-validator's IsOptional skips every
 * validator for null, so `{ productId, qty: 2, unitPrice: null }` reaches the service. The three staff
 * pricing sites tested `!== undefined ? Number(x) : null` — and `Number(null)` is 0, so a null became a typed
 * $0 override instead of "no price sent". Master's real outcomes are recorded in each case below.
 * SIBLING spec: orders.service.spec.ts is at its size-ratchet cap. Harness: orders.service.driver-tier-price.spec.ts.
 */
// invoice-pdf.service.ts imports @react-pdf/renderer (ESM-only), so mock the module that pulls it in.
jest.mock("../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({
    createFromOrder: jest.fn().mockResolvedValue({ id: "inv-1" }),
    findAll: jest.fn().mockResolvedValue({ data: [], meta: {} }),
  })),
}));

// NotificationsService imports expo-server-sdk, which is ESM-only and fails Jest's CommonJS parser.
jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({
    sendToCustomer: jest.fn().mockResolvedValue(undefined),
    sendToDriver: jest.fn().mockResolvedValue(undefined),
  })),
}));

import { oversellReaderOffProvider } from "./testing/policy-reader-provider";
import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
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

const principal = (role: "DRIVER" | "OPERATOR", sub: string) => ({
  sub,
  username: sub,
  role,
  status: "ACTIVE" as const,
  forcePasswordChange: false,
});
const driverPayload = principal("DRIVER", "user-drv");
const operatorPayload = principal("OPERATOR", "user-op");

// list 10, tier-2 price 8, tier-3 price 7.
const PRODUCT = {
  id: "prod-1",
  name: "Tiered Widget",
  unit: "Each",
  pricePerUnit: 10,
  priceTier2: 8,
  priceTier3: 7,
  unitsPerBox: null as number | null,
  category: null,
  trackedCategoryId: null,
  trackedSubcategoryId: null,
};

const line = (over: Record<string, unknown> = {}) => ({
  id: "li-1",
  orderId: "ord-1",
  productId: "prod-1",
  name: null,
  qty: 3,
  unitPrice: 10,
  subtotal: 30,
  status: "PENDING",
  boxes: null,
  pieces: null,
  unitsPerBox: null,
  unitLabel: null,
  deliveredQty: 0,
  invoicedQty: 0,
  priceType: "STANDARD",
  originalPrice: null,
  overrideReason: null,
  overriddenBy: null,
  promoFreeUnits: null,
  trackedCategoryId: null,
  position: 0,
  createdAt: new Date("2026-01-01"),
  ...over,
});

describe("OrdersService.updateOrderItems — a null line price is no override (row 591)", () => {
  let service: OrdersService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        oversellReaderOffProvider,
        OrdersService,
        {
          provide: TenantContextService,
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
            releaseOrderCreditsInTx: jest.fn().mockResolvedValue([]),
            settleOrderCreditsInTx: jest.fn().mockResolvedValue({ applied: 0, unapplied: 0 }),
            syncOrderCreditSelections: jest.fn().mockResolvedValue(undefined),
            previewOrderCreditRelease: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: CommissionEngineService,
          useValue: {
            syncOrderInvoices: jest.fn().mockResolvedValue(undefined),
            removeInvoiceCommission: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: EntitlementsService,
          useValue: (() => {
            const flagRead = jest.fn().mockResolvedValue(true);
            return { hasFlag: flagRead, hasFlagStrict: flagRead };
          })(),
        },
        {
          provide: RegulatedLedgerService,
          useValue: { reverseInvoiceEntries: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();

    service = module.get<OrdersService>(OrdersService);
  });

  function prime(lineItems: unknown[], tier = 1, products: unknown[] = [PRODUCT]) {
    prisma.order.findUnique.mockResolvedValue({ ...MOCK_ORDER, status: "PENDING", lineItems });
    prisma.customer.findFirst.mockResolvedValue({ id: "cust-1", pricingTier: tier });
    prisma.customerPrice.findMany.mockResolvedValue([]);
    prisma.product.findFirst.mockResolvedValue(products[0]);
    prisma.product.findUnique.mockResolvedValue(products[0]);
    prisma.product.findUniqueOrThrow.mockResolvedValue(products[0]);
    prisma.product.findMany.mockResolvedValue(products);
    prisma.productUnit.findMany.mockResolvedValue([]);
    prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 12, status: "PENDING" }]);
  }
  const as = (role: "driver" | "operator") => (role === "driver" ? driverPayload : operatorPayload);
  const edit = (role: "driver" | "operator", items: Record<string, unknown>[], more = {}) =>
    service.updateOrderItems("ord-1", { items, ...more } as never, as(role) as never);
  const add = (role: "driver" | "operator", extra: Record<string, unknown> = {}) =>
    edit(role, [{ productId: "prod-1", qty: 2, ...extra }], { replaceAll: false });
  const writes = () => prisma.orderItem.create.mock.calls.map((c) => c[0].data);
  const created = () => writes()[0];
  const updated = () =>
    prisma.orderItem.update.mock.calls.map((c) => c[0]).find((c) => c.where?.id === "li-1").data;
  const clearWrites = () => {
    prisma.orderItem.create.mockClear();
    prisma.orderItem.update.mockClear();
  };

  const orderUpdateData = () =>
    prisma.order.update.mock.calls.map((c) => c[0].data).find((d) => d.subtotal !== undefined);

  describe("diff ADD (staff adds an item to an order)", () => {
    it("A1: unitPrice null for a tier-2 customer bills the tier price, as if no price were sent", async () => {
      prime([], 2);
      await add("operator", { unitPrice: null });
      // Master (static read): Number(null) = 0 -> a typed $0 on a SPECIAL-tier line -> 400 "reason required".
      expect(created()).toMatchObject({ unitPrice: 8, priceType: "SPECIAL", originalPrice: 10 });
      expect(created().subtotal).toBe(16);
      expect(created().overriddenBy ?? null).toBeNull();
    });

    it("A2: unitPrice null WITH a reason attached is still the tier price, never a silent $0 DISCOUNTED line", async () => {
      prime([], 2);
      await add("operator", { unitPrice: null, overrideReason: "pls" });
      // Master (static read): the reason lets the $0 through: DISCOUNTED / unitPrice 0 / subtotal 0.
      expect(created()).toMatchObject({ unitPrice: 8, priceType: "SPECIAL", originalPrice: 10 });
      expect(created().subtotal).toBe(16);
      expect(created().overrideReason ?? null).toBeNull();
      expect(created().overriddenBy ?? null).toBeNull();
    });

    it("A3: unitPrice null for a retail (tier-1) customer bills list / STANDARD, not a $0 DISCOUNTED line", async () => {
      prime([], 1);
      await add("operator", { unitPrice: null });
      // Master (static read): unitPrice 0 / DISCOUNTED / originalPrice 10 / subtotal 0 - no reason needed at tier 1.
      expect(created()).toMatchObject({
        unitPrice: 10,
        priceType: "STANDARD",
        originalPrice: null,
      });
      expect(created().subtotal).toBe(20);
    });

    it("A4 (control): an explicit unitPrice 0 is still a typed price: tier 1 -> DISCOUNTED $0; tier 2 needs a reason", async () => {
      prime([], 1);
      await add("operator", { unitPrice: 0 });
      expect(created()).toMatchObject({ unitPrice: 0, priceType: "DISCOUNTED", originalPrice: 10 });
      expect(created().subtotal).toBe(0);
      clearWrites();
      prime([], 2);
      await expect(add("operator", { unitPrice: 0 })).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.orderItem.create).not.toHaveBeenCalled();
    });

    it("A5 (control): unitPrice absent is unchanged: tier-priced", async () => {
      prime([], 2);
      await add("operator");
      expect(created()).toMatchObject({ unitPrice: 8, priceType: "SPECIAL", originalPrice: 10 });
      clearWrites();
      prime([], 1);
      await add("operator");
      expect(created()).toMatchObject({ unitPrice: 10, priceType: "STANDARD" });
    });
  });

  describe("qty edit of an existing line (staff)", () => {
    const qtyEdit = (extra: Record<string, unknown>) =>
      edit("operator", [{ id: "li-1", action: "UPDATE", qty: 5, ...extra }]);

    it("B1: unitPrice null keeps the stored price and reprices only the qty", async () => {
      prime([line({ unitPrice: 10, subtotal: 30 })], 1);
      await qtyEdit({ unitPrice: null });
      // Master (static read): the null becomes a typed $0: unitPrice 0 / DISCOUNTED / subtotal 0.
      expect(updated()).toMatchObject({ unitPrice: 10, subtotal: 50 });
      expect(updated().priceType).toBeUndefined();
    });

    it("B2: unitPrice null on a tier-2 customer's line is not a $0 override (no 400, stored price kept)", async () => {
      prime([line({ unitPrice: 10, subtotal: 30 })], 2);
      await qtyEdit({ unitPrice: null });
      // Master (static read): $0 on a SPECIAL-tier line with no reason on file -> 400 "reason required".
      expect(updated()).toMatchObject({ unitPrice: 10, subtotal: 50 });
    });

    it("B3 (control): an explicit unitPrice 0 is still a typed price (tier 1 -> DISCOUNTED $0)", async () => {
      prime([line({ unitPrice: 10, subtotal: 30 })], 1);
      await qtyEdit({ unitPrice: 0 });
      expect(updated()).toMatchObject({ unitPrice: 0, priceType: "DISCOUNTED", subtotal: 0 });
    });

    it("B4 (control): unitPrice absent keeps the stored price", async () => {
      prime([line({ unitPrice: 10, subtotal: 30 })], 1);
      await qtyEdit({});
      expect(updated()).toMatchObject({ unitPrice: 10, subtotal: 50 });
      expect(updated().priceType).toBeUndefined();
    });

    it("B5: a reason-only edit with unitPrice null is the minimal reason write, not a re-priced line", async () => {
      prime([line({ unitPrice: 10, subtotal: 30 })], 1);
      await edit("operator", [
        { id: "li-1", action: "UPDATE", unitPrice: null, overrideReason: "note" },
      ]);
      // Master (static read): null !== undefined skipped the reason-only fast path -> the full path ran
      // with a typed $0 and wrote unitPrice 0 / subtotal 0.
      expect(updated()).toMatchObject({ overrideReason: "note" });
      expect(updated()).not.toHaveProperty("unitPrice");
      expect(updated()).not.toHaveProperty("subtotal");
    });
  });

  describe("replace-all (staff sends the full list, no ids)", () => {
    const replaceAll = (items: Record<string, unknown>[]) => edit("operator", items);

    it("C1: a NEW line with unitPrice null prices at the customer's tier (tier 2 -> $8 SPECIAL)", async () => {
      prime([], 2);
      await replaceAll([{ productId: "prod-1", qty: 2, unitPrice: null }]);
      // Master (static read): the typed $0 against the tier baseline: refused (SPECIAL tier, no reason) or $0.
      expect(created()).toMatchObject({ unitPrice: 8, priceType: "SPECIAL", originalPrice: 10 });
      expect(created().subtotal).toBe(16);
    });

    it("C2: a NEW line with unitPrice null at tier 1 is list / STANDARD, not a $0 DISCOUNTED line", async () => {
      prime([], 1);
      await replaceAll([{ productId: "prod-1", qty: 2, unitPrice: null }]);
      expect(created()).toMatchObject({ unitPrice: 10, priceType: "STANDARD", subtotal: 20 });
    });

    it("C3: a re-sent EXISTING line with unitPrice null keeps its stored price", async () => {
      prime([line({ unitPrice: 10, subtotal: 30 })], 1);
      await replaceAll([{ productId: "prod-1", qty: 3, unitPrice: null }]);
      expect(created()).toMatchObject({ unitPrice: 10, subtotal: 30 });
    });

    it("C4 (control): an explicit unitPrice 0 on a replace-all line is still a typed price", async () => {
      prime([], 1);
      await replaceAll([{ productId: "prod-1", qty: 2, unitPrice: 0 }]);
      expect(created()).toMatchObject({ unitPrice: 0, priceType: "DISCOUNTED", subtotal: 0 });
    });

    it("C5 (control): unitPrice absent is tier-priced", async () => {
      prime([], 2);
      await replaceAll([{ productId: "prod-1", qty: 2 }]);
      expect(created()).toMatchObject({ unitPrice: 8, priceType: "SPECIAL" });
    });
  });

  describe("shippingFee (sibling: a null fee must not zero the stored fee)", () => {
    const withStoredFee = () => {
      prime([line({ unitPrice: 10, subtotal: 30 })], 1);
      prisma.order.findUnique.mockResolvedValue({
        ...MOCK_ORDER,
        status: "PENDING",
        shippingFee: 5,
        lineItems: [line({ unitPrice: 10, subtotal: 30 })],
      });
    };
    const qtyEdit = (more: Record<string, unknown>) =>
      edit("operator", [{ id: "li-1", action: "UPDATE", qty: 5 }], more);

    it("F1: shippingFee null leaves the stored fee alone (same write as an absent fee)", async () => {
      withStoredFee();
      await qtyEdit({});
      const absent = orderUpdateData();
      prisma.order.update.mockClear();
      await qtyEdit({ shippingFee: null });
      const sent = orderUpdateData();
      // Master (static read): null !== undefined -> Math.max(0, null) = 0 -> shippingFee: 0 written, total drops the fee.
      expect(sent).not.toHaveProperty("shippingFee");
      expect(sent.total).toBe(absent.total);
    });

    it("F2 (control): an explicit shippingFee 0 still clears the fee", async () => {
      withStoredFee();
      await qtyEdit({ shippingFee: 0 });
      expect(orderUpdateData()).toMatchObject({ shippingFee: 0 });
    });
  });
});
