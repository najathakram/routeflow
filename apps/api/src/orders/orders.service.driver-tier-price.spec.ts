// SA-429 (#2377): these driver cases pin pricing, not ownership; the ownership predicate itself is pinned by
// driver-edit-access.spec.ts and driver-edit-access.db.spec.ts.
jest.mock("./driver-edit-access", () => ({ assertDriverMayEditOrder: jest.fn() }));
/**
 * B1036 — OWNER RULING 2026-10-03: a customer always gets their own tier / per-product special price, whoever
 * enters the item, and a DRIVER still can't set a custom price, discount, override reason or price type.
 *
 * Before the fix a driver's diff-added, substituted or full-list line billed at LIST because `updateOrderItems`
 * resolved the customer's tier only for staff (and the buyer). Now a NEW or SUBSTITUTED driver line resolves the
 * customer's tier / special price / customer-typed price (flag.units_prices_v2, with its fail-closed 503)
 * exactly as a staff line does; a driver-sent price is still dropped; and an EXISTING line keeps its stored
 * price on a driver qty edit and on a driver full-list re-send (forward-only: no re-pricing, no backfill).
 * SIBLING spec: orders.service.spec.ts is at its size-ratchet cap. Harness: orders.update-units-prices-v2.spec.ts.
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
import { ServiceUnavailableException } from "@nestjs/common";
import { getQueueToken } from "@nestjs/bull";
import { ConfigService } from "@nestjs/config";
import { API_ERROR_CODES } from "../common/api-error-codes";

import { OrdersService } from "./orders.service";
import * as editPayload from "./order-edit-payload";
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

// list 10, tier-2 price 8, tier-3 price 7; boxed twin: list BOX price 120, tier-2 box price 100.
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
const BOXED = {
  ...PRODUCT,
  id: "prod-2",
  name: "Case Widget",
  pricePerUnit: 120,
  priceTier2: 100,
  unitsPerBox: 24,
};
const OTHER = { ...PRODUCT, id: "prod-3", name: "Other Widget" };
// The units_prices_v2 shape (a boxed pack with a customer-typed pack price), as orders.update-units-prices-v2.spec.ts.
const TYPED = {
  id: "prod-case",
  unit: "Box",
  unitsPerBox: 12,
  pricePerUnit: 10,
  priceTier2: null,
  priceTier3: null,
  priceTier4: null,
  priceTier5: null,
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

describe("OrdersService.updateOrderItems — driver lines resolve the customer's tier price (B1036)", () => {
  let service: OrdersService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let entitlements: { hasFlag: jest.Mock; hasFlagStrict: jest.Mock };
  let invoicesService: { revertLinkedInvoicesForOrderEdit: jest.Mock };
  let promotionsService: { activeForCatalog: jest.Mock };

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
    entitlements = module.get(EntitlementsService);
    invoicesService = module.get(InvoicesService);
    promotionsService = module.get(PromotionsService);
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

  describe("diff ADD (a driver adds an item to an order)", () => {
    it("D1: a driver add for a tier-2 customer bills at tier 2 (SPECIAL, original = list), not list", async () => {
      prime([], 2);
      await add("driver");
      // Master billed unitPrice 10 / STANDARD / originalPrice null / subtotal 20 (LIST).
      expect(created()).toMatchObject({ unitPrice: 8, priceType: "SPECIAL", originalPrice: 10 });
      expect(created().subtotal).toBe(16);
    });

    it("D2: a per-product customer special price (CustomerPrice row) beats the customer's default tier", async () => {
      prime([], 1);
      prisma.customerPrice.findMany.mockResolvedValue([{ productId: "prod-1", pricingTier: 3 }]);
      await add("driver");
      expect(created()).toMatchObject({ unitPrice: 7, priceType: "SPECIAL", originalPrice: 10 });
    });

    it("D3: a driver-sent unitPrice / discount / overrideReason / priceType is ignored: the same line as sending none", async () => {
      prime([], 2);
      await add("driver", {
        unitPrice: 1,
        overrideReason: "pls",
        discount: 5,
        priceType: "MANUAL",
      });
      const sent = created();
      clearWrites();
      await add("driver");
      expect(sent).toMatchObject({ unitPrice: 8, priceType: "SPECIAL", originalPrice: 10 });
      expect(sent.unitPrice).toBe(created().unitPrice);
      expect(sent.priceType).toBe(created().priceType);
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
      await edit("driver", [{ productId: "prod-2", boxes: 1, pieces: 0 }], { replaceAll: false });
      expect(created()).toMatchObject({ unitPrice: 100, subtotal: 100, priceType: "SPECIAL" });
      expect(created().subtotal).not.toBe(2400); // 24 pieces x the $100 box price
      clearWrites();
      await edit("driver", [{ productId: "prod-2", boxes: 0, pieces: 12 }], { replaceAll: false });
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
      clearWrites();
      await add("driver");
      const drv = created();
      expect(drv.unitPrice).toBe(8);
      for (const k of ["unitPrice", "subtotal", "priceType", "originalPrice", "qty"]) {
        expect(drv[k]).toEqual(staff[k]);
      }
    });

    it("D7: tenant isolation: the tier and special-price lookups are keyed to THIS order's customer only", async () => {
      prime([], 2);
      await add("driver");
      expect(prisma.customer.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "cust-1" } }),
      );
      expect(prisma.customerPrice.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ customerId: "cust-1" }) }),
      );
      for (const [args] of prisma.customerPrice.findMany.mock.calls) {
        expect(args.where.customerId).toBe("cust-1");
      }
    });
  });

  describe("staff behaviour is unchanged", () => {
    it("S1: an operator add with no typed price is tier-priced; typed below list is DISCOUNTED, above is MANUAL", async () => {
      prime([], 2);
      await add("operator");
      expect(created()).toMatchObject({ unitPrice: 8, priceType: "SPECIAL", originalPrice: 10 });
      clearWrites();
      await add("operator", { unitPrice: 5, overrideReason: "x" });
      expect(created()).toMatchObject({ unitPrice: 5, priceType: "DISCOUNTED", originalPrice: 10 });
      clearWrites();
      await add("operator", { unitPrice: 12, overrideReason: "x" });
      expect(created()).toMatchObject({ unitPrice: 12, priceType: "MANUAL", originalPrice: 10 });
      expect(created().overriddenBy).toBe("user-op");
    });

    it("S2: an operator edit of a stored price still honours the typed price", async () => {
      prime([line()], 2);
      await edit("operator", [
        { id: "li-1", action: "UPDATE", qty: 3, unitPrice: 9, overrideReason: "x" },
      ]);
      expect(updated()).toMatchObject({ unitPrice: 9, priceType: "DISCOUNTED" });
    });
  });

  describe("existing driver lines are not re-priced", () => {
    it("E1: a driver qty edit keeps the stored price (an agreed price is never silently moved to tier)", async () => {
      prime([line({ unitPrice: 10, subtotal: 30 })], 2);
      await edit("driver", [{ id: "li-1", action: "UPDATE", qty: 5, unitPrice: 1 }]);
      const data = updated();
      expect(data.unitPrice).toBe(10); // not the tier-2 $8, and not the driver's $1
      expect(data.subtotal).toBe(50);
      expect(data.priceType).toBeUndefined();
    });

    it("E3: a driver price reaching the UPDATE branch unstripped is still dropped (typedLinePrice, not classifyEditPayload)", async () => {
      // SA-814l: the diff UPDATE branch must not rely on classifyEditPayload having stripped the price.
      const spy = jest.spyOn(editPayload, "classifyEditPayload").mockReturnValue(true);
      try {
        prime([line({ unitPrice: 10, subtotal: 30 })], 2);
        await edit("driver", [{ id: "li-1", action: "UPDATE", qty: 5, unitPrice: 1 }]);
        const data = updated();
        expect(data.unitPrice).toBe(10); // a direct read billed the driver's $1
        expect(data.subtotal).toBe(50);
      } finally {
        spy.mockRestore();
      }
    });

    it("E2: a driver qty edit of a boxed line keeps the stored box price and prorates (never qty x box price)", async () => {
      prime(
        [
          line({
            productId: "prod-2",
            qty: 24,
            boxes: 1,
            pieces: 0,
            unitsPerBox: 24,
            unitPrice: 120,
          }),
        ],
        2,
        [BOXED],
      );
      await edit("driver", [{ id: "li-1", action: "UPDATE", qty: 36 }]);
      expect(updated()).toMatchObject({ unitPrice: 120, boxes: 1, pieces: 12, subtotal: 180 });
    });
  });

  describe("driver substitute", () => {
    const substitute = (role: "driver" | "operator", extra: Record<string, unknown> = {}) =>
      edit(role, [{ id: "li-1", substituteProductId: "prod-1", qty: 2, ...extra }], {
        replaceAll: false,
      });

    it("U1: a driver substitute bills the substitute at the customer tier price, a driver-sent price ignored", async () => {
      prime([line({ productId: "prod-9" })], 2);
      await substitute("driver", { unitPrice: 1, overrideReason: "pls" });
      // Master billed the substitute at LIST: unitPrice 10 / STANDARD / originalPrice null.
      expect(updated()).toMatchObject({
        productId: "prod-1",
        unitPrice: 8,
        priceType: "SPECIAL",
        originalPrice: 10,
        overriddenBy: null,
      });
    });

    it("U2: a driver substitute honours a per-product special price, same as a staff substitute", async () => {
      prime([line({ productId: "prod-9" })], 1);
      prisma.customerPrice.findMany.mockResolvedValue([{ productId: "prod-1", pricingTier: 3 }]);
      await substitute("driver");
      expect(updated()).toMatchObject({ unitPrice: 7, priceType: "SPECIAL" });
      clearWrites();
      await substitute("operator");
      expect(updated()).toMatchObject({ unitPrice: 7, priceType: "SPECIAL" });
    });
  });

  describe("driver replace-all (full item list, no ids)", () => {
    const replaceAll = (items: Record<string, unknown>[]) => edit("driver", items);
    const createdFor = (productId: string) => writes().find((d) => d.productId === productId);

    it("R1: every NEW line the driver lists resolves the customer tier price, never list; a typed price is ignored", async () => {
      prime([], 2);
      await replaceAll([{ productId: "prod-1", qty: 2, unitPrice: 1 }]);
      expect(created()).toMatchObject({ unitPrice: 8, priceType: "SPECIAL", originalPrice: 10 });
    });

    it("R2: a per-product special price applies to a replace-all line too", async () => {
      prime([], 1);
      prisma.customerPrice.findMany.mockResolvedValue([{ productId: "prod-1", pricingTier: 3 }]);
      await replaceAll([{ productId: "prod-1", qty: 2 }]);
      expect(created()).toMatchObject({ unitPrice: 7, priceType: "SPECIAL", originalPrice: 10 });
    });

    it("R3: boxed replace-all: a NEW pack line of 1 box bills the tier-2 BOX price $100, never 24 x the box price", async () => {
      prime([], 2, [BOXED]);
      await replaceAll([{ productId: "prod-2", qty: 1 }]);
      expect(created()).toMatchObject({ unitPrice: 100, subtotal: 100, priceType: "SPECIAL" });
    });

    it("R4: boxed replace-all of a box-split line keeps its stored box price and prorates (computeLineSubtotal)", async () => {
      prime(
        [
          line({
            productId: "prod-2",
            qty: 24,
            boxes: 1,
            pieces: 0,
            unitsPerBox: 24,
            unitPrice: 120,
          }),
        ],
        2,
        [BOXED],
      );
      await replaceAll([{ productId: "prod-2", qty: 36 }]);
      expect(createdFor("prod-2")).toMatchObject({
        unitPrice: 120,
        boxes: 1,
        pieces: 12,
        subtotal: 180,
      });
    });

    it("K1: a listed line the order already has keeps its stored price; only the NEW product resolves the tier", async () => {
      prime([line({ unitPrice: 10, subtotal: 30 })], 2, [PRODUCT, OTHER]);
      await replaceAll([
        { productId: "prod-1", qty: 5 },
        { productId: "prod-3", qty: 2 },
      ]);
      expect(createdFor("prod-1")).toMatchObject({
        unitPrice: 10,
        priceType: "STANDARD",
        originalPrice: null,
        subtotal: 50,
      });
      expect(createdFor("prod-3")).toMatchObject({ unitPrice: 8, priceType: "SPECIAL" });
    });

    it("K2: a no-change re-send keeps $30 (3 @ $10), never $24 at the tier price", async () => {
      prime([line({ unitPrice: 10, subtotal: 30 })], 2);
      await replaceAll([{ productId: "prod-1", qty: 3 }]);
      expect(createdFor("prod-1")).toMatchObject({ unitPrice: 10, subtotal: 30 });
    });

    it("K3: an operator's discounted $5 line stays $5 (DISCOUNTED, original = list) with its attribution, not tier $8", async () => {
      prime(
        [
          line({
            unitPrice: 5,
            subtotal: 15,
            priceType: "DISCOUNTED",
            originalPrice: 10,
            overrideReason: "deal",
            overriddenBy: "user-op",
          }),
        ],
        2,
      );
      await replaceAll([{ productId: "prod-1", qty: 3 }]);
      expect(createdFor("prod-1")).toMatchObject({
        unitPrice: 5,
        subtotal: 15,
        priceType: "DISCOUNTED",
        originalPrice: 10,
        overrideReason: "deal",
        overriddenBy: "user-op",
      });
    });

    it("K4: a CANCELLED existing line is not an agreed price: the re-listed product resolves the tier", async () => {
      prime([line({ status: "CANCELLED" })], 2);
      await replaceAll([{ productId: "prod-1", qty: 2 }]);
      expect(createdFor("prod-1")).toMatchObject({ unitPrice: 8, priceType: "SPECIAL" });
    });

    it("K5: a kept line's free units are re-derived for a changed qty at the rate they were earned when the promo has ended", async () => {
      prime(
        [line({ qty: 6, unitPrice: 10, subtotal: 50, priceType: "PROMO", promoFreeUnits: 1 })],
        2,
      );
      await replaceAll([{ productId: "prod-1", qty: 6 }]);
      expect(createdFor("prod-1")).toMatchObject({
        unitPrice: 10,
        promoFreeUnits: 1,
        subtotal: 50,
      });
      clearWrites();
      await replaceAll([{ productId: "prod-1", qty: 7 }]);
      // floor(1 free x 7 / 6) = 1: (7 - 1) x $10. The old drop-to-zero billed 7 x $10 = 70.
      expect(createdFor("prod-1")).toMatchObject({
        unitPrice: 10,
        promoFreeUnits: 1,
        subtotal: 60,
      });
    });

    it("K6: buy-5-get-1 at $10, 6 -> 12 on a kept driver line earns 2 free and bills $100, the same as the diff qty edit", async () => {
      const bogo = [
        {
          id: "pr-bogo",
          type: "BUY_N_GET_M",
          value: 1,
          minQty: 5,
          scope: "ALL",
          category: null,
          productIds: [],
        },
      ];
      const stored = line({
        qty: 6,
        unitPrice: 10,
        subtotal: 50,
        priceType: "PROMO",
        promoFreeUnits: 1,
      });
      prime([stored], 2);
      promotionsService.activeForCatalog.mockResolvedValue(bogo);
      await replaceAll([{ productId: "prod-1", qty: 12 }]);
      // Dropping the free units billed 12 x $10 = $120 here.
      expect(createdFor("prod-1")).toMatchObject({
        unitPrice: 10,
        promoFreeUnits: 2,
        subtotal: 100,
      });
      const viaReplace = createdFor("prod-1").subtotal;
      clearWrites();
      prime([stored], 2);
      promotionsService.activeForCatalog.mockResolvedValue(bogo);
      await edit("driver", [{ id: "li-1", action: "UPDATE", qty: 12 }]);
      expect(updated().subtotal).toBe(viaReplace);
    });

    it("K7: an untouched kept line keeps its stored free units when a different BUY_N_GET_M rule is live now", async () => {
      const bogo = (minQty: number) => [
        {
          id: `pr-bogo-${minQty}`,
          type: "BUY_N_GET_M",
          value: 1,
          minQty,
          scope: "ALL",
          category: null,
          productIds: [],
        },
      ];
      // 8 x $10 sold with 1 free under a rule that has ended; buy-3-get-1 is live now. A re-derive would
      // give 2 free and bill $60: a free-unit gain on a line the driver did not touch.
      prime(
        [line({ qty: 8, unitPrice: 10, subtotal: 70, priceType: "PROMO", promoFreeUnits: 1 })],
        2,
      );
      promotionsService.activeForCatalog.mockResolvedValue(bogo(3));
      await replaceAll([{ productId: "prod-1", qty: 8 }]);
      expect(createdFor("prod-1")).toMatchObject({
        unitPrice: 10,
        promoFreeUnits: 1,
        subtotal: 70,
      });
      // The reverse: buy-10-get-1 is live now, so a re-derive would drop the free unit and bill $60 for $50.
      clearWrites();
      prime(
        [line({ qty: 6, unitPrice: 10, subtotal: 50, priceType: "PROMO", promoFreeUnits: 1 })],
        2,
      );
      promotionsService.activeForCatalog.mockResolvedValue(bogo(10));
      await replaceAll([{ productId: "prod-1", qty: 6 }]);
      expect(createdFor("prod-1")).toMatchObject({
        unitPrice: 10,
        promoFreeUnits: 1,
        subtotal: 50,
      });
    });
  });

  describe("customer-typed unit prices (flag.units_prices_v2) reach a driver exactly as they reach staff", () => {
    const V2 = "flag.units_prices_v2";
    const typed = (...rows: Array<[string, number]>) => {
      (prisma.forTenant() as any).customerUnitPrice = {
        findMany: jest
          .fn()
          .mockResolvedValue(
            rows.map(([unitRef, price]) => ({ productId: "prod-case", unitRef, price })),
          ),
      };
    };
    const flagV2 = (on: boolean) =>
      entitlements.hasFlag.mockImplementation(async (_t: string, k: string) => k !== V2 || on);
    const addTyped = (role: "driver" | "operator") =>
      edit(role, [{ productId: "prod-case", qty: 2 }], { replaceAll: false });

    beforeEach(() => {
      prime([line({ productId: "prod-other", unitPrice: 3, subtotal: 15, qty: 5 })], 1, [TYPED]);
    });

    it("V1: flag on: a driver's NEW pack line takes the customer's typed pack price (SPECIAL against list), same as staff", async () => {
      flagV2(true);
      typed(["pack", 6]);
      await addTyped("operator");
      const staff = created();
      clearWrites();
      await addTyped("driver");
      // Master billed the driver at the catalog LIST $10 / STANDARD.
      expect(created()).toMatchObject({ unitPrice: 6, originalPrice: 10, priceType: "SPECIAL" });
      for (const k of ["unitPrice", "subtotal", "priceType", "originalPrice"]) {
        expect(created()[k]).toEqual(staff[k]);
      }
    });

    it("V2: flag on: a driver's SUBSTITUTE and a driver's replace-all line take the typed pack price too", async () => {
      flagV2(true);
      typed(["pack", 6]);
      prime([line({ productId: "prod-other" })], 1, [TYPED]);
      await edit("driver", [{ id: "li-1", substituteProductId: "prod-case", qty: 2 }], {
        replaceAll: false,
      });
      expect(updated()).toMatchObject({ unitPrice: 6, priceType: "SPECIAL" });
      clearWrites();
      await edit("driver", [{ productId: "prod-case", qty: 2 }]);
      expect(created()).toMatchObject({ unitPrice: 6, priceType: "SPECIAL", originalPrice: 10 });
    });

    it("V3: flag OFF with typed rows present: master's list price, rows ignored", async () => {
      flagV2(false);
      typed(["pack", 6]);
      await addTyped("driver");
      expect(created()).toMatchObject({ unitPrice: 10, priceType: "STANDARD" });
    });

    it("V4: a driver-typed price cannot undercut the customer's typed price: it is dropped, the typed price bills", async () => {
      flagV2(true);
      typed(["pack", 6]);
      await edit(
        "driver",
        [{ productId: "prod-case", qty: 2, unitPrice: 1, overrideReason: "x" }],
        {
          replaceAll: false,
        },
      );
      expect(created()).toMatchObject({ unitPrice: 6, priceType: "SPECIAL" });
      expect(created().overriddenBy ?? null).toBeNull();
    });

    it("V5: typed rows + a failed flag read is the coded 503 for a driver, and nothing is written or reverted", async () => {
      entitlements.hasFlag.mockRejectedValue(new Error("entitlements down"));
      typed(["pack", 6]);
      const err = await addTyped("driver").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ServiceUnavailableException);
      expect((err as ServiceUnavailableException).getResponse()).toMatchObject({
        code: API_ERROR_CODES.CUSTOMER_PRICES_UNAVAILABLE,
      });
      expect(invoicesService.revertLinkedInvoicesForOrderEdit).not.toHaveBeenCalled();
      expect(prisma.orderItem.create).not.toHaveBeenCalled();
    });

    it("V6: the same 503 for a driver's full list (replace-all), before anything is written", async () => {
      entitlements.hasFlag.mockRejectedValue(new Error("entitlements down"));
      typed(["pack", 6]);
      const err = await edit("driver", [{ productId: "prod-case", qty: 2 }]).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ServiceUnavailableException);
      expect(invoicesService.revertLinkedInvoicesForOrderEdit).not.toHaveBeenCalled();
      expect(prisma.orderItem.create).not.toHaveBeenCalled();
    });

    it("V7: control: the same driver add with a readable flag does run the revert (V5 is not vacuous)", async () => {
      flagV2(true);
      typed(["pack", 6]);
      await addTyped("driver");
      expect(invoicesService.revertLinkedInvoicesForOrderEdit).toHaveBeenCalledWith("ord-1");
    });
  });

  describe("create() at the door (already tier-priced for a driver: pinned, unchanged)", () => {
    it("C1: a driver-created order for a tier-2 customer bills tier 2, a driver-sent unitPrice ignored", async () => {
      const customer = {
        id: "cust-1",
        pricingTier: 2,
        user: { status: "ACTIVE" },
        fulfillPath: null,
      };
      prisma.customer.findUnique.mockResolvedValue(customer);
      prisma.customer.findFirst.mockResolvedValue(customer);
      prisma.customerPrice.findMany.mockResolvedValue([]);
      prisma.product.findMany.mockResolvedValue([PRODUCT]);
      prisma.order.create.mockResolvedValue(MOCK_ORDER);
      (service as any).systemConfig.get.mockResolvedValue("0");

      await service.create(
        { customerId: "cust-1", items: [{ productId: "prod-1", qty: 1, unitPrice: 1 }] },
        driverPayload as never,
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
