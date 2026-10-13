/**
 * POS-5: the counter sale's price-edit rule inside OrdersService.create (`options.priceEditAllowed`).
 *
 *  - `false` (a caller `staffMay(role, "EDIT_LINE_PRICE")` refuses): a line that WOULD be a real override (decideStaffOverride says
 *    DISCOUNTED / MANUAL) is refused 403 PRICE_EDIT_NOT_PERMITTED before any write; a typed price within 1/2 cent
 *    of the server's own price is no override and passes;
 *  - `true` / absent (every other caller): the existing override path is byte-identical (a PIN, green on master).
 * Money is pinned in cents through @routeflow/pricing, never qty x unitPrice.
 */
jest.mock("../common/db-locks", () => ({
  ...jest.requireActual("../common/db-locks"),
  withAdvisoryLock: jest.fn(async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  })),
}));

import { computeLineSubtotal } from "@routeflow/pricing";
import { buildOrdersService, operatorPayload } from "./testing/orders-service-harness";

const operator = { ...operatorPayload, tenantId: "t-1" } as never;
const admin = {
  ...operatorPayload,
  sub: "user-admin",
  role: "TENANT_ADMIN",
  tenantId: "t-1",
} as never;

const PLAIN = {
  id: "prod-1",
  name: "Plain Widget",
  unit: "each",
  pricePerUnit: 10,
  priceTier3: 8,
  unitsPerBox: null,
  category: null,
  trackedCategoryId: null,
  trackedSubcategoryId: null,
  isActive: true,
};
const BOXED = { ...PLAIN, id: "prod-box", name: "Boxed Widget", pricePerUnit: 24, unitsPerBox: 12 };

describe("POS-5 priceEditAllowed in create()", () => {
  let h: Awaited<ReturnType<typeof buildOrdersService>>;
  const line = () => h.prisma.order.create.mock.calls[0][0].data.lineItems.create[0];

  const seed = (tier = 1) => {
    h.prisma.customer.findFirst.mockResolvedValue({ id: "cust-1", pricingTier: tier });
    h.prisma.customer.findUnique.mockResolvedValue({
      id: "cust-1",
      pricingTier: tier,
      user: { status: "ACTIVE" },
      deletedAt: null,
    });
    h.prisma.customerPrice.findMany.mockResolvedValue([]);
    h.prisma.product.findMany.mockResolvedValue([PLAIN, BOXED]);
    h.prisma.order.create.mockImplementation((args: any) =>
      Promise.resolve({
        id: "ord-new",
        orderNumber: "ORD-1",
        customerId: "cust-1",
        customer: { businessName: "Acme" },
        urgent: false,
        createdAt: new Date(),
        ...args.data,
        lineItems: [],
      }),
    );
  };
  const create = (items: unknown[], user: never, priceEditAllowed?: boolean) =>
    h.service.create(
      { customerId: "cust-1", items } as never,
      user,
      priceEditAllowed === undefined ? {} : { priceEditAllowed },
    );
  const nothingWritten = () => {
    expect(h.prisma.order.create).not.toHaveBeenCalled();
    expect(h.prisma.orderIdempotencyKey.create).not.toHaveBeenCalled();
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  };

  beforeEach(async () => {
    h = await buildOrdersService();
  });

  describe("priceEditAllowed: false (an operator at the counter)", () => {
    it("a price below the tier price is 403 PRICE_EDIT_NOT_PERMITTED with the exact message, and NOTHING is written", async () => {
      seed();
      const e: any = await create(
        [{ productId: "prod-1", qty: 2, unitPrice: 9 }],
        operator,
        false,
      ).catch((x) => x);
      expect(e.getStatus()).toBe(403);
      expect(e.getResponse()).toEqual({
        code: "PRICE_EDIT_NOT_PERMITTED",
        message: "You can't change prices. Ask your account admin.",
      });
      nothingWritten();
    });

    it("a price above list (an upsell, MANUAL) is refused the same way", async () => {
      seed();
      await expect(
        create([{ productId: "prod-1", qty: 1, unitPrice: 12 }], operator, false),
      ).rejects.toMatchObject({ response: { code: "PRICE_EDIT_NOT_PERMITTED" } });
      nothingWritten();
    });

    it("one overridden line among plain ones refuses the whole sale", async () => {
      seed();
      await expect(
        create(
          [
            { productId: "prod-1", qty: 1 },
            { productId: "prod-box", boxes: 1, pieces: 2, unitPrice: 20 },
          ],
          operator,
          false,
        ),
      ).rejects.toMatchObject({ response: { code: "PRICE_EDIT_NOT_PERMITTED" } });
      nothingWritten();
    });

    it("a typed price equal to the server's tier price is NOT an override: accepted, plain line, no attribution", async () => {
      seed();
      await create([{ productId: "prod-1", qty: 2, unitPrice: 10 }], operator, false);
      expect(line()).toMatchObject({ unitPrice: 10, priceType: "STANDARD", subtotal: 20 });
      expect(line().overriddenBy ?? null).toBeNull();
    });

    it("no unitPrice at all behaves exactly as today", async () => {
      seed();
      await create([{ productId: "prod-1", qty: 3 }], operator, false);
      expect(line()).toMatchObject({ unitPrice: 10, priceType: "STANDARD", subtotal: 30 });
    });
  });

  describe("priceEditAllowed: true (an admin) prices through the existing override path", () => {
    it("3.335 x 3 stores the cent-rounded net price 3.34 and a 10.02 subtotal (never 10.005)", async () => {
      seed();
      await create([{ productId: "prod-1", qty: 3, unitPrice: 3.335 }], admin, true);
      expect(line()).toMatchObject({
        unitPrice: 3.34,
        priceType: "DISCOUNTED",
        originalPrice: 10,
        overriddenBy: "user-admin",
        subtotal: 10.02,
      });
      expect(line().subtotal).toBe(computeLineSubtotal({ unitPrice: 3.34, qty: 3 }));
    });

    it("a boxed line (2 cases + 3 loose, 12/case) at a 21.60 case price is prorated, never qty x price", async () => {
      seed();
      await create(
        [
          {
            productId: "prod-box",
            boxes: 2,
            pieces: 3,
            unitPrice: 21.6,
            overrideReason: "10% off",
          },
        ],
        admin,
        true,
      );
      const expected = computeLineSubtotal({
        unitPrice: 21.6,
        qty: 27,
        boxes: 2,
        pieces: 3,
        unitsPerBox: 12,
      });
      expect(expected).toBe(48.6);
      expect(line()).toMatchObject({
        unitPrice: 21.6,
        originalPrice: 24,
        overrideReason: "10% off",
        boxes: 2,
        pieces: 3,
        subtotal: 48.6,
      });
    });

    it("a special-tier customer still needs a reason for a real change (400), and with one it is stored", async () => {
      seed(3);
      await expect(
        create([{ productId: "prod-1", qty: 1, unitPrice: 6 }], admin, true),
      ).rejects.toThrow(/reason is required/);
      nothingWritten();
      await create(
        [{ productId: "prod-1", qty: 1, unitPrice: 6, overrideReason: "damaged" }],
        admin,
        true,
      );
      expect(line()).toMatchObject({ unitPrice: 6, overrideReason: "damaged" });
    });
  });

  describe("priceEditAllowed: true for an OPERATOR (SA-762r: staffMay admits the operator)", () => {
    it("an operator's real price change is DISCOUNTED and attributed to them", async () => {
      seed();
      await create([{ productId: "prod-1", qty: 2, unitPrice: 9 }], operator, true);
      expect(line()).toMatchObject({
        unitPrice: 9,
        priceType: "DISCOUNTED",
        overriddenBy: "user-op",
      });
    });

    it("a special-tier override WITHOUT a reason is still refused (400), nothing written", async () => {
      seed(3);
      await expect(
        create([{ productId: "prod-1", qty: 1, unitPrice: 6 }], operator, true),
      ).rejects.toThrow(/reason is required/);
      nothingWritten();
    });
  });

  describe("PIN: callers that do not set the option are unchanged (the rule is the counter's only)", () => {
    it("an OPERATOR on the ordinary create() path with a real unitPrice is still DISCOUNTED and attributed", async () => {
      seed();
      await create([{ productId: "prod-1", qty: 2, unitPrice: 9 }], operator);
      expect(line()).toMatchObject({
        unitPrice: 9,
        priceType: "DISCOUNTED",
        originalPrice: 10,
        overriddenBy: "user-op",
      });
    });
  });
});
