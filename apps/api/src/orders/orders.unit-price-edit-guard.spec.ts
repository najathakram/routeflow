/**
 * H3 / POS-5 — the unit branch of `OrdersService.create` honours `options.priceEditAllowed` exactly like the
 * pack branch (counter-price-edit.spec.ts): `false` refuses a unit-line price that is a real change from the
 * customer's TIER unit price with 403 PRICE_EDIT_NOT_PERMITTED before anything is written; no price, or the
 * tier price, still succeeds. `createSale` (/orders/sell) forwards the same option to the same create().
 * Fixture: tier-3 customer, Case list $480 / tier $450.
 */
jest.mock("../invoices/invoices.service", () => ({ InvoicesService: class InvoicesService {} }));
jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: class NotificationsService {},
}));

import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { OrdersService } from "./orders.service";
import { PrismaService } from "../prisma/prisma.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { createMockPrisma } from "../testing/prisma-mock";

const autoMock = () =>
  new Proxy({} as Record<string | symbol, jest.Mock>, {
    get: (t, k) =>
      k === "then" || typeof k === "symbol"
        ? undefined
        : (t[k] ??= jest.fn().mockResolvedValue(undefined)),
  });

describe("H3 / POS-5 priceEditAllowed on a unit line in create()", () => {
  let service: OrdersService;
  let prisma: ReturnType<typeof createMockPrisma>;
  const staff = {
    sub: "user-op",
    username: "operator",
    role: "OPERATOR",
    tenantId: "t-1",
  } as never;
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
    kind: "STANDARD",
    portalVisible: true,
    parent: null,
  };
  const ladder = [
    {
      productId: "prod-1",
      label: "Case",
      factorToBase: 288,
      price: "480.00",
      priceTier3: "450.00",
      sortOrder: 0,
      priceTier2: null,
      priceTier4: null,
      priceTier5: null,
    },
  ];
  const line = () => prisma.order.create.mock.calls[0][0].data.lineItems.create[0];
  const create = (item: Record<string, unknown>, priceEditAllowed?: boolean) =>
    service.create(
      {
        customerId: "cust-1",
        items: [{ productId: "prod-1", qty: 2, unitLabel: "Case", ...item }],
      } as never,
      staff,
      priceEditAllowed === undefined ? {} : { priceEditAllowed },
    );
  const refused = { response: { code: "PRICE_EDIT_NOT_PERMITTED" } };

  beforeEach(async () => {
    prisma = createMockPrisma();
    const module = await Test.createTestingModule({ providers: [OrdersService] })
      .useMocker((token) => {
        if (token === PrismaService) return prisma;
        if (token === ConfigService) return { get: jest.fn().mockReturnValue(0.1) };
        if (token === EntitlementsService) return { hasFlag: jest.fn().mockResolvedValue(true) };
        return autoMock();
      })
      .compile();
    service = module.get(OrdersService);
    prisma.customer.findFirst.mockResolvedValue({ id: "cust-1", pricingTier: 3 });
    prisma.customer.findUnique.mockResolvedValue({
      id: "cust-1",
      pricingTier: 3,
      user: { status: "ACTIVE" },
      deletedAt: null,
    });
    prisma.customerPrice.findMany.mockResolvedValue([]);
    prisma.product.findMany.mockResolvedValue([PRODUCT]);
    const scopedUnits = { findMany: jest.fn().mockResolvedValue(ladder) };
    (prisma.forTenant as jest.Mock).mockReturnValue({
      ...(prisma.forTenant as jest.Mock)(),
      productUnit: scopedUnits,
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

  describe("priceEditAllowed: false", () => {
    it("a unit price below the tier price is 403 PRICE_EDIT_NOT_PERMITTED and nothing is written", async () => {
      await expect(create({ unitPrice: 400, overrideReason: "x" }, false)).rejects.toMatchObject(
        refused,
      );
      expect(prisma.order.create).not.toHaveBeenCalled();
    });

    it("a unit price at the LIST price (above the tier price) is refused the same way", async () => {
      await expect(create({ unitPrice: 480, overrideReason: "x" }, false)).rejects.toMatchObject(
        refused,
      );
      expect(prisma.order.create).not.toHaveBeenCalled();
    });

    it("the tier price, or no price at all, still succeeds with no attribution", async () => {
      await create({ unitPrice: 450 }, false);
      expect(line()).toMatchObject({ unitPrice: 450, priceType: "SPECIAL", subtotal: 900 });
      expect(line().overriddenBy ?? null).toBeNull();
      prisma.order.create.mockClear();
      await create({}, false);
      expect(line()).toMatchObject({ unitPrice: 450, priceType: "SPECIAL" });
    });

    it("/orders/sell (createSale) forwards the option to the same create(): the same 403", async () => {
      await expect(
        service.createSale(
          {
            customerId: "cust-1",
            items: [
              {
                productId: "prod-1",
                qty: 2,
                unitLabel: "Case",
                unitPrice: 480,
                overrideReason: "x",
              },
            ],
          } as never,
          staff,
          { priceEditAllowed: false } as never,
        ),
      ).rejects.toMatchObject(refused);
      expect(prisma.order.create).not.toHaveBeenCalled();
    });
  });

  describe("priceEditAllowed true / absent: the override path is unchanged", () => {
    it.each([undefined, true])(
      "a typed list price with a reason is MANUAL and stamped (%s)",
      async (allowed) => {
        await create({ unitPrice: 480, overrideReason: " agreed " }, allowed);
        expect(line()).toMatchObject({
          unitPrice: 480,
          priceType: "MANUAL",
          subtotal: 960,
          overrideReason: "agreed",
          overriddenBy: "user-op",
        });
      },
    );
  });
});
