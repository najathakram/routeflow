import { regulatedGateOpenProvider } from "./testing/regulated-gate-open-provider";
import { oversellReaderOffProvider } from "../orders/testing/policy-reader-provider";
import { Test } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { OrderTemplatesService } from "./order-templates.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { OrdersService } from "../orders/orders.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { NotificationsService } from "../notifications/notifications.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { AuditService } from "../audit/audit.service";
import { createMockPrisma } from "../testing/prisma-mock";

/**
 * B48: a standing-order line was priced with the raw catalog price
 * (`Number(product.pricePerUnit)`), never the shared buyer-pricing resolver —
 * so a template order ignored the customer's pricing tier, per-product
 * CustomerPrice overrides, active promotions (including BUY_N_GET_M), the
 * sticky-upsell price memory, and boxed selling-unit semantics that every
 * interactive order already applies via `OrdersService.resolveBuyerLinePrice`
 * + `computeLineSubtotal`. These specs run the REAL resolver (the prototype
 * method takes no `this`) and the REAL `computeLineSubtotal`, mocking only
 * the database and the promotion/history loaders, so the money assertions are
 * arithmetic, not mirrors of a mock — test-plan.md §2.1 "T9 — harness".
 *
 * T25/T26 (B09, R20/R21): `update()`'s PATCH item-replacement path — an atomic,
 * product-validated, tenantId-stamped swap.
 */
const V2 = "flag.units_prices_v2";
let v2On = true;

describe("S19: a standing order prices from the customer layer (flag.units_prices_v2)", () => {
  let service: OrderTemplatesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let ordersService: {
    mergeAllPendingForCustomer: jest.Mock;
    loadActivePromotions: jest.Mock;
    getCustomerPriceHistory: jest.Mock;
    resolveBuyerLinePrice: jest.Mock;
    entitlements: { hasFlag: jest.Mock };
  };
  let authGuard: { checkAuthorized: jest.Mock };
  let notifications: { sendToCustomer: jest.Mock; sendToUser: jest.Mock };

  // The prototype method takes no `this` (test-plan.md §2.1), so calling it
  // unbound reproduces the exact production pricing ladder.
  const realResolver = (OrdersService.prototype as any).resolveBuyerLinePrice;

  beforeEach(async () => {
    prisma = createMockPrisma();
    ordersService = {
      mergeAllPendingForCustomer: jest.fn().mockResolvedValue(null),
      loadActivePromotions: jest.fn().mockResolvedValue([]),
      getCustomerPriceHistory: jest.fn().mockResolvedValue({}),
      resolveBuyerLinePrice: jest.fn((...args: any[]) => realResolver(...args)),
      entitlements: { hasFlag: jest.fn(async (_t: string, k: string) => k === V2 && v2On) },
    };
    authGuard = { checkAuthorized: jest.fn().mockResolvedValue({ blocked: [] }) };
    notifications = {
      sendToCustomer: jest.fn().mockResolvedValue(1),
      sendToUser: jest.fn().mockResolvedValue(1),
    };

    const mod = await Test.createTestingModule({
      providers: [
        oversellReaderOffProvider,
        OrderTemplatesService,
        regulatedGateOpenProvider,
        { provide: PrismaService, useValue: prisma },
        { provide: TenantContextService, useValue: { run: jest.fn((_id, fn) => fn()) } },
        // settings.taxRate is stored as a PERCENT string — "10" is 10%.
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue("10") } },
        { provide: OrdersService, useValue: ordersService },
        { provide: AuthorizationGuardService, useValue: authGuard },
        { provide: NotificationsService, useValue: notifications },
        { provide: AuditService, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
        {
          provide: SellingRestrictionsService,
          useValue: {
            assertLinesSellable: jest.fn().mockResolvedValue(undefined),
            checkLinesSellable: jest.fn().mockResolvedValue({ outcome: "ALLOW", reasons: [] }),
          },
        },
      ],
    }).compile();
    service = mod.get(OrderTemplatesService);

    prisma.customer.findUnique.mockResolvedValue({ id: "c1", pricingTier: 1 });
    prisma.customerPrice.findMany.mockResolvedValue([]);
    prisma.order.create.mockImplementation((a: any) => Promise.resolve({ id: "o1", ...a.data }));
  });

  const P1 = {
    id: "p1",
    pricePerUnit: 10,
    priceTier2: null,
    unitsPerBox: null,
    category: null,
    trackedCategoryId: null,
  };
  const setup = (typedPrice: number) => {
    (prisma.forTenant() as any).customerUnitPrice = {
      findMany: jest
        .fn()
        .mockResolvedValue([{ productId: "p1", unitRef: "pack", price: String(typedPrice) }]),
    };
    prisma.product.findMany.mockResolvedValue([P1]);
    prisma.orderTemplate.findUnique.mockResolvedValue({
      id: "t1",
      customerId: "c1",
      name: "Weekly",
      isActive: true,
      items: [{ productId: "p1", qty: 2, notes: null }],
    });
  };
  const line = () => prisma.order.create.mock.calls[0][0].data.lineItems.create[0];

  it("flag on: the standing order bills the typed pack price (SPECIAL), and the resolver gets the layer as its 8th argument", async () => {
    v2On = true;
    setup(7);
    await service.generateOrder("t1");
    expect(line()).toMatchObject({
      unitPrice: 7,
      priceType: "SPECIAL",
      originalPrice: 10,
      subtotal: 14,
    });
    expect(ordersService.resolveBuyerLinePrice.mock.calls[0]).toHaveLength(8);
  });

  it("flag on, a typed price above list ($12 over $10) is the MANUAL upsell, not promo-eligible", async () => {
    v2On = true;
    setup(12);
    await service.generateOrder("t1");
    expect(line()).toMatchObject({ unitPrice: 12, priceType: "MANUAL", originalPrice: 10 });
  });

  it("flag OFF with typed rows present: master's list price and master's 7 arguments", async () => {
    v2On = false;
    setup(7);
    await service.generateOrder("t1");
    expect(line()).toMatchObject({ unitPrice: 10, priceType: "STANDARD" });
    expect(ordersService.resolveBuyerLinePrice.mock.calls[0]).toHaveLength(7);
  });
});
