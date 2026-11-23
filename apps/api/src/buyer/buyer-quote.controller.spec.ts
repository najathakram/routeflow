/**
 * B304 / SA-1172: POST /buyer/cart/quote carries POST /buyer/orders' guard set plus the tighter throttle, refuses a
 * contradictory split first, and passes exactly the cart (items, fulfillPath) to the quote. Test 8, 14, 19 of the ruling.
 */
import { BadRequestException } from "@nestjs/common";
import { GUARDS_METADATA, INTERCEPTORS_METADATA } from "@nestjs/common/constants";
import { createMockPrisma } from "../testing/prisma-mock";
import { BuyerQuoteController } from "./buyer-quote.controller";
import { BuyerController } from "./buyer.controller";
import { BuyerTenantInterceptor } from "./buyer-tenant.interceptor";
import { BuyerJwtAuthGuard } from "./guards/buyer-jwt-auth.guard";
import { BuyerSellerContextGuard } from "./guards/buyer-seller-context.guard";

const CTX = {
  customerId: "cust-1",
  tenantId: "tenant-xyz",
  userId: "u1",
  customer: { id: "cust-1" },
};

describe("BuyerQuoteController", () => {
  let ctrl: BuyerQuoteController;
  let orders: { create: jest.Mock };
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    orders = {
      create: jest.fn(async (_dto: unknown, _u: unknown, o: any) => {
        o.beforeWrite({
          total: 69.77,
          subtotal: 31.2,
          tax: 2.57,
          categoryTax: 36,
          isTaxExempt: false,
        });
      }),
    };
    prisma = createMockPrisma();
    prisma.forTenant().product.findMany.mockResolvedValue([
      { id: "plain", unitsPerBox: null },
      { id: "boxed", unitsPerBox: 12 },
    ]);
    ctrl = new BuyerQuoteController(orders as never, prisma as never);
  });

  it("1: returns create's figures (tax and levy included)", async () => {
    await expect(
      ctrl.quote({ items: [{ productId: "plain", qty: 2 }] } as never, CTX),
    ).resolves.toEqual({ subtotal: 31.2, tax: 2.57, levy: 36, total: 69.77, taxExempt: false });
  });

  it("14: every line the cart sends is in the quote, an unresolved one included, with the fulfil path", async () => {
    const items = [
      { productId: "plain", qty: 2 },
      { productId: "unpriced", qty: 1 },
    ];
    await ctrl.quote({ items, fulfillPath: "PICKUP" } as never, CTX);
    const [dto, , opts] = orders.create.mock.calls[0];
    expect(dto.items).toEqual(items);
    expect(dto.fulfillPath).toBe("PICKUP");
    expect(opts).toMatchObject({ quote: true, skipAutoMerge: true });
  });

  it("19 (body): notes, forceNew and a smuggled quote flag never reach create()", async () => {
    await ctrl.quote(
      {
        items: [{ productId: "plain", qty: 2 }],
        notes: "x",
        forceNew: true,
        quote: false,
        priceOnly: true,
      } as never,
      CTX,
    );
    const [dto] = orders.create.mock.calls[0];
    expect(Object.keys(dto).sort()).toEqual(["fulfillPath", "items", "status"]);
  });

  it("a contradictory split is the coded 400 before anything is priced", async () => {
    await expect(
      ctrl.quote({ items: [{ productId: "boxed", qty: 3, boxes: 2, pieces: 0 }] } as never, CTX),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(orders.create).not.toHaveBeenCalled();
  });

  it("8: the route carries POST /buyer/orders' guard set and the 60/min throttle", () => {
    const handler = BuyerQuoteController.prototype.quote;
    expect(Reflect.getMetadata(GUARDS_METADATA, BuyerQuoteController)).toContain(BuyerJwtAuthGuard);
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toContain(BuyerSellerContextGuard);
    expect(Reflect.getMetadata(INTERCEPTORS_METADATA, handler)).toContain(BuyerTenantInterceptor);
    const orderHandler = BuyerController.prototype.createOrder;
    expect(Reflect.getMetadata(GUARDS_METADATA, orderHandler)).toEqual(
      Reflect.getMetadata(GUARDS_METADATA, handler),
    );
    expect(Reflect.getMetadata("THROTTLER:LIMITdefault", handler)).toBe(60);
    expect(Reflect.getMetadata("THROTTLER:TTLdefault", handler)).toBe(60_000);
  });
});
