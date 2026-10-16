/**
 * Units S19 (flag.units_prices_v2): `OrdersService.create` bills the customer's TYPED unit price, and resolves tiers through
 * `customerTierFor`. Flag off, or no typed row for the customer: master's price, no entitlement lookup for the new flag.
 * The pure seams are in units-prices-v2.spec.ts; this pins the wiring (what create() reads and writes).
 * Harness copied from orders.create-units.spec.ts.
 */
jest.mock("../invoices/invoices.service", () => ({ InvoicesService: class InvoicesService {} }));
jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: class NotificationsService {},
}));

import { Test } from "@nestjs/testing";
import { ConflictException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import { OrdersService } from "./orders.service";
import { PrismaService } from "../prisma/prisma.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { PromotionsService } from "../promotions/promotions.service";
import { createMockPrisma } from "../testing/prisma-mock";

const autoMock = () =>
  new Proxy({} as Record<string | symbol, jest.Mock>, {
    get: (t, k) =>
      k === "then" || typeof k === "symbol"
        ? undefined
        : (t[k] ??= jest.fn().mockResolvedValue(undefined)),
  });

const V2 = "flag.units_prices_v2";
const staff = { sub: "user-op", username: "operator", role: "OPERATOR", tenantId: "t-1" } as never;
const buyer = { sub: "user-cust", username: "cust", role: "CUSTOMER", tenantId: "t-1" } as never;

const PRODUCT = {
  id: "prod-1",
  name: "Widget",
  unit: "Box",
  pricePerUnit: 42,
  priceTier2: 40,
  unitsPerBox: 24,
  category: null,
  trackedCategoryId: null,
  trackedSubcategoryId: null,
  isActive: true,
  kind: "STANDARD",
  portalVisible: true,
  parent: null,
};
const CASE_ROW = {
  id: "u-case",
  productId: "prod-1",
  label: "Case",
  factorToBase: 288,
  price: "480.00",
  priceTier2: null,
  priceTier3: null,
  priceTier4: null,
  priceTier5: null,
  sortOrder: 0,
};

describe("OrdersService.create: billing reads typed customer unit prices (S19)", () => {
  let service: OrdersService;
  let prisma: ReturnType<typeof createMockPrisma>;
  const typedRows = jest.fn();
  let promos: unknown[] = [];
  const flags = new Set<string>();
  const hasFlag = jest.fn(async (_t: string, k: string) => flags.has(k));
  const orderData = () => prisma.order.create.mock.calls[0][0].data;
  const create = (items: unknown[], user: never = staff) =>
    service.create({ customerId: "cust-1", items } as never, user);

  beforeEach(async () => {
    flags.clear();
    flags.add("flag.units_v1");
    hasFlag.mockClear();
    typedRows.mockReset().mockResolvedValue([]);
    promos = [];
    prisma = createMockPrisma();
    const module = await Test.createTestingModule({ providers: [OrdersService] })
      .useMocker((token) => {
        if (token === PrismaService) return prisma;
        if (token === ConfigService) return { get: jest.fn().mockReturnValue(0.1) };
        if (token === EntitlementsService) return { hasFlag };
        if (token === PromotionsService) return { activeForCatalog: jest.fn(async () => promos) };
        return autoMock();
      })
      .compile();
    service = module.get(OrdersService);
    prisma.customer.findFirst.mockResolvedValue({ id: "cust-1", pricingTier: 1 });
    prisma.customer.findUnique.mockResolvedValue({
      id: "cust-1",
      pricingTier: 1,
      user: { status: "ACTIVE" },
      deletedAt: null,
    });
    prisma.product.findMany.mockResolvedValue([PRODUCT]);
    (prisma.forTenant as jest.Mock).mockReturnValue({
      ...(prisma.forTenant as jest.Mock)(),
      productUnit: { findMany: jest.fn().mockResolvedValue([CASE_ROW]) },
      customerUnitPrice: { findMany: typedRows },
    });
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
  });

  const typed = (...rows: Array<[string, number]>) =>
    typedRows.mockResolvedValue(
      rows.map(([unitRef, price]) => ({ productId: "prod-1", unitRef, price: String(price) })),
    );

  it("flag on: a typed PACK price is the pack line's unit price (SPECIAL against list)", async () => {
    flags.add(V2);
    typed(["pack", 33]);
    await create([{ productId: "prod-1", qty: 2, boxes: 2, pieces: 0 }]);
    expect(orderData().lineItems.create[0]).toMatchObject({
      unitPrice: 33,
      originalPrice: 42,
      priceType: "SPECIAL",
      subtotal: 66,
    });
    expect(typedRows.mock.calls[0][0].where).toMatchObject({
      customerId: "cust-1",
      productId: { in: ["prod-1"] },
    });
  });

  it("flag on: a typed price for the Case (its ProductUnit id) is a unit line's price", async () => {
    flags.add(V2);
    typed(["u-case", 450]);
    await create([{ productId: "prod-1", qty: 3, unitLabel: "Case" }]);
    expect(orderData().lineItems.create[0]).toMatchObject({
      unitLabel: "Case",
      unitPrice: 450,
      subtotal: 1350,
    });
  });

  it("R1a (SA-811a): typed pack $33 puts the Case in the customer's shape: 480 x 33/42 = $377.14 SPECIAL (at 1320178da it billed $480)", async () => {
    flags.add(V2);
    typed(["pack", 33]);
    await create([{ productId: "prod-1", qty: 1, unitLabel: "Case" }]);
    expect(orderData().lineItems.create[0]).toMatchObject({
      unitLabel: "Case",
      unitPrice: 377.14,
      originalPrice: 480,
      priceType: "SPECIAL",
    });
  });

  it("R1b (SA-811a): typed Case $450 on the customer's order unit bills the PACK line $39.38 (at 1320178da it billed $42)", async () => {
    flags.add(V2);
    typed(["u-case", 450]);
    (prisma.forTenant() as any).customerPrice.findMany.mockResolvedValue([
      { productId: "prod-1", pricingTier: null, orderUnitRef: "u-case" },
    ]);
    await create([{ productId: "prod-1", qty: 1, boxes: 1, pieces: 0 }]);
    expect(orderData().lineItems.create[0]).toMatchObject({
      unitPrice: 39.38,
      priceType: "SPECIAL",
    });
  });

  it("S19-b: a typed Case price only leaves a pack line at tier/list, the sticky above-list price still runs", async () => {
    flags.add(V2);
    typed(["u-case", 450]);
    jest.spyOn(service, "getCustomerPriceHistory").mockResolvedValue({
      "prod-1": { lastPrice: 50, listPriceAtTime: 42 },
    });
    await create([{ productId: "prod-1", qty: 1, boxes: 1, pieces: 0 }]);
    expect(orderData().lineItems.create[0]).toMatchObject({ unitPrice: 50, priceType: "MANUAL" });
  });

  it("S19-a: typed pack $33 beats a remembered above-list $50 (flag on); flag off the $50 sticky MANUAL holds (guard)", async () => {
    typed(["pack", 33]);
    jest.spyOn(service, "getCustomerPriceHistory").mockResolvedValue({
      "prod-1": { lastPrice: 50, listPriceAtTime: 42 },
    });
    await create([{ productId: "prod-1", qty: 1, boxes: 1, pieces: 0 }]);
    expect(orderData().lineItems.create[0]).toMatchObject({ unitPrice: 50, priceType: "MANUAL" });
    prisma.order.create.mockClear();
    flags.add(V2);
    await create([{ productId: "prod-1", qty: 1, boxes: 1, pieces: 0 }]);
    expect(orderData().lineItems.create[0]).toMatchObject({ unitPrice: 33, priceType: "SPECIAL" });
  });

  it("flag OFF with typed rows present (a revoked tenant): master's price, the rows are ignored", async () => {
    typed(["pack", 33], ["u-case", 450]);
    await create([
      { productId: "prod-1", qty: 2, boxes: 2, pieces: 0 },
      { productId: "prod-1", qty: 1, unitLabel: "Case" },
    ]);
    const [pack, unit] = orderData().lineItems.create;
    expect(pack).toMatchObject({ unitPrice: 42, priceType: "STANDARD", subtotal: 84 });
    expect(unit).toMatchObject({ unitPrice: 480 });
  });

  it("no typed rows and ordinary tiers: the new flag is never asked (a pack-only create reads nothing new)", async () => {
    flags.add(V2);
    await create([{ productId: "prod-1", qty: 1 }]);
    expect(hasFlag).not.toHaveBeenCalledWith(expect.anything(), V2);
    expect(orderData().lineItems.create[0]).toMatchObject({ unitPrice: 42 });
  });

  describe("tiers go through customerTierFor (PF-14: the one named difference, flag on only)", () => {
    beforeEach(() => {
      prisma.customer.findFirst.mockResolvedValue({ id: "cust-1", pricingTier: 2 });
      (prisma.forTenant() as any).customerPrice.findMany.mockResolvedValue([
        { productId: "prod-1", pricingTier: 0 }, // junk customer-product tier
      ]);
    });
    it("flag on: a junk customer-product tier falls through to the customer's own tier (2 => $40)", async () => {
      flags.add(V2);
      await create([{ productId: "prod-1", qty: 1 }]);
      expect(orderData().lineItems.create[0]).toMatchObject({
        unitPrice: 40,
        priceType: "SPECIAL",
      });
    });
    it("flag off: master reads tier 0 as the list price", async () => {
      await create([{ productId: "prod-1", qty: 1 }]);
      expect(orderData().lineItems.create[0]).toMatchObject({ unitPrice: 42 });
    });
  });

  describe("a buyer's cart is judged against the typed price (no false 409, no stale price)", () => {
    beforeEach(() => {
      flags.add(V2);
      typed(["pack", 33]);
    });
    it("a cart at the typed price passes and bills the typed price", async () => {
      await create([{ productId: "prod-1", qty: 1, unitPrice: 33 }], buyer);
      expect(orderData().lineItems.create[0]).toMatchObject({ unitPrice: 33 });
    });
    it("S19-c: a 10% promo on the typed $33 bills $29.70 PROMO, the typed row untouched", async () => {
      promos = [
        {
          id: "pr",
          type: "PERCENT",
          value: 10,
          minQty: null,
          scope: "ALL",
          category: null,
          productIds: [],
        },
      ];
      await create([{ productId: "prod-1", qty: 1 }], buyer);
      expect(orderData().lineItems.create[0]).toMatchObject({
        unitPrice: 29.7,
        originalPrice: 33,
        priceType: "PROMO",
      });
    });
    it("R2a: typed $45 above the $42 list with a 10% promo bills $45 MANUAL, no promo (at 1320178da it billed $40.50)", async () => {
      typed(["pack", 45]);
      promos = [
        {
          id: "pr",
          type: "PERCENT",
          value: 10,
          minQty: null,
          scope: "ALL",
          category: null,
          productIds: [],
        },
      ];
      await create([{ productId: "prod-1", qty: 1 }], buyer);
      expect(orderData().lineItems.create[0]).toMatchObject({
        unitPrice: 45,
        originalPrice: 42,
        priceType: "MANUAL",
      });
    });
    it("a cart still at the old tier price is a 409 naming the typed price", async () => {
      await expect(create([{ productId: "prod-1", qty: 1, unitPrice: 42 }], buyer)).rejects.toThrow(
        ConflictException,
      );
    });
  });
});
