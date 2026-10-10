/**
 * POS-5: what an ADMIN's counter price edit stores through create() (`priceEditAllowed: true`). The server keeps ONE net
 * unit price per line: `unitPrice` = the net, `originalPrice` = list, `priceType` DISCOUNTED / MANUAL, `overrideReason`,
 * `overriddenBy` = the caller. The per-line `discount` stays 0 and so does the order's: re-encoding an override as
 * `discount = original - net` would double-count on the invoice (memory feedback_invoice_line_discount_convention).
 * Money is pinned through @routeflow/pricing, never qty x unitPrice.
 */
jest.mock("../common/db-locks", () => ({
  ...jest.requireActual("../common/db-locks"),
  withAdvisoryLock: jest.fn(async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  })),
}));

import { computeLineSubtotal, roundMoney } from "@routeflow/pricing";
import { buildOrdersService, operatorPayload } from "./testing/orders-service-harness";

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
  unitsPerBox: null,
  category: null,
  trackedCategoryId: null,
  trackedSubcategoryId: null,
  isActive: true,
};
const BOXED = { ...PLAIN, id: "prod-box", name: "Boxed Widget", pricePerUnit: 24, unitsPerBox: 12 };

describe("POS-5 an admin's counter price edit is stored as ONE net unit price", () => {
  let h: Awaited<ReturnType<typeof buildOrdersService>>;
  const created = () => h.prisma.order.create.mock.calls[0][0].data;
  const line = (i = 0) => created().lineItems.create[i];

  beforeEach(async () => {
    h = await buildOrdersService();
    h.prisma.customer.findFirst.mockResolvedValue({ id: "cust-1", pricingTier: 1 });
    h.prisma.customer.findUnique.mockResolvedValue({
      id: "cust-1",
      pricingTier: 1,
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
  });

  const ring = (items: unknown[]) =>
    h.service.create({ customerId: "cust-1", items } as never, admin, { priceEditAllowed: true });

  it("unitPrice 9 on a 10.00 tier price with a reason: net 9 stored, list as originalPrice, DISCOUNTED, reason and caller recorded, discount 0", async () => {
    await ring([{ productId: "prod-1", qty: 2, unitPrice: 9, overrideReason: "Damaged box" }]);
    expect(line()).toMatchObject({
      unitPrice: 9,
      originalPrice: 10,
      priceType: "DISCOUNTED",
      overrideReason: "Damaged box",
      overriddenBy: "user-admin",
      subtotal: 18,
    });
    expect(Number(line().discount ?? 0)).toBe(0); // never original - net
    expect(Number(created().discountAmount ?? 0)).toBe(0);
    expect(created().subtotal).toBe(18);
  });

  it("an upsell above list is MANUAL, also attributed, and adds nothing negative", async () => {
    await ring([{ productId: "prod-1", qty: 1, unitPrice: 12 }]);
    expect(line()).toMatchObject({
      unitPrice: 12,
      originalPrice: 10,
      priceType: "MANUAL",
      overriddenBy: "user-admin",
      subtotal: 12,
    });
  });

  it("free is allowed (the DTO floor is 0): a 100% edit stores 0.00 and a 0 subtotal", async () => {
    await ring([{ productId: "prod-1", qty: 3, unitPrice: 0 }]);
    expect(line()).toMatchObject({ unitPrice: 0, priceType: "DISCOUNTED", subtotal: 0 });
  });

  it("a boxed line at 21.60 a box: the stored subtotal is computeLineSubtotal, and the order total adds up to the lines", async () => {
    await ring([
      { productId: "prod-box", boxes: 2, pieces: 3, unitPrice: 21.6, overrideReason: "10% off" },
      { productId: "prod-1", qty: 1 },
    ]);
    const boxed = computeLineSubtotal({
      unitPrice: 21.6,
      qty: 27,
      boxes: 2,
      pieces: 3,
      unitsPerBox: 12,
    });
    expect(boxed).toBe(48.6);
    expect(line(0).subtotal).toBe(boxed);
    expect(line(1).subtotal).toBe(10);
    expect(roundMoney(line(0).subtotal + line(1).subtotal)).toBe(created().subtotal);
    expect(Number(created().discountAmount ?? 0)).toBe(0); // so an invoice built from it cannot double-count
  });

  it("only the edited line is attributed: a plain line in the same sale carries no override", async () => {
    await ring([
      { productId: "prod-1", qty: 1, unitPrice: 9 },
      { productId: "prod-box", boxes: 1, pieces: 0 },
    ]);
    expect(line(0).overriddenBy).toBe("user-admin");
    expect(line(1).overriddenBy ?? null).toBeNull();
    expect(line(1)).toMatchObject({ unitPrice: 24, priceType: "STANDARD" });
  });
});
