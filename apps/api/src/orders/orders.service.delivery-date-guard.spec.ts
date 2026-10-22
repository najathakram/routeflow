import {
  buildOrdersService,
  buyerPseudoUser,
  customerPayload,
  operatorPayload,
} from "./testing/orders-service-harness";

/**
 * Row 718 — OrdersService.create() (staff POST /orders, driver, buyer new order, and the sale/counter
 * paths that run through it) refuses a requestedDeliveryDate before the TENANT's today with a coded 400,
 * BEFORE any read of the cart or write. Today and later pass; no date is untouched. The tenant's day is
 * its own time zone (TenantConfig.timezone), not the server's or the browser's.
 */

// A literal on purpose: this spec must go red on behaviour, not on a missing constant.
const CODE = "DELIVERY_DATE_IN_PAST";
const ONLY_DATE = [
  "hrtime",
  "nextTick",
  "performance",
  "queueMicrotask",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "requestIdleCallback",
  "cancelIdleCallback",
  "setImmediate",
  "clearImmediate",
  "setInterval",
  "clearInterval",
  "setTimeout",
  "clearTimeout",
] as const;

const PRODUCT = { id: "prod-1", name: "Tomatoes", pricePerUnit: 4.99, unit: "punnet" };
const ORDER = {
  id: "ord-1",
  customerId: "cust-1",
  orderNumber: "ORD-1",
  status: "PENDING" as const,
  source: "APP" as const,
  urgent: false,
  subtotal: 4.99,
  tax: 0,
  total: 4.99,
  notes: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  customer: { businessName: "Test Business" },
};

async function build(timezone: string | null = "America/New_York") {
  const h = await buildOrdersService();
  h.prisma.tenantConfig.findUnique.mockResolvedValue(timezone ? { timezone } : null);
  h.prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
  h.prisma.customer.findUnique.mockResolvedValue({
    id: "cust-1",
    deletedAt: null,
    user: { status: "ACTIVE" },
  });
  h.prisma.product.findMany.mockResolvedValue([PRODUCT]);
  h.prisma.order.create.mockResolvedValue(ORDER);
  return h;
}

const dto = (requestedDeliveryDate?: string) => ({
  customerId: "cust-1",
  items: [{ productId: "prod-1", qty: 1 }],
  ...(requestedDeliveryDate !== undefined ? { requestedDeliveryDate } : {}),
});

afterEach(() => jest.useRealTimers());
const at = (iso: string) => jest.useFakeTimers({ now: new Date(iso), doNotFake: [...ONLY_DATE] });

describe("OrdersService.create — row 718 past delivery date guard", () => {
  it("staff: a past day is refused with 400 DELIVERY_DATE_IN_PAST and nothing is written", async () => {
    at("2026-10-22T15:00:00Z"); // 11:00 on the 22nd in New York
    const h = await build();
    const err = await h.service.create(dto("2026-10-21") as never, operatorPayload as never).then(
      () => null,
      (e) => e,
    );
    expect(err?.getStatus()).toBe(400);
    expect(err.getResponse()).toMatchObject({ code: CODE, today: "2026-10-22" });
    expect(h.prisma.order.create).not.toHaveBeenCalled();
    expect(h.prisma.product.findMany).not.toHaveBeenCalled();
  });

  it("buyer (CUSTOMER role): a past day is refused too", async () => {
    at("2026-10-22T15:00:00Z");
    const h = await build();
    for (const user of [customerPayload, buyerPseudoUser]) {
      await expect(
        h.service.create({ ...dto("2026-10-21"), customerId: undefined } as never, user as never),
      ).rejects.toMatchObject({ response: { code: CODE } });
    }
    expect(h.prisma.order.create).not.toHaveBeenCalled();
  });

  it("staff: today (tenant day) and a later day pass the guard and reach the write", async () => {
    at("2026-10-22T15:00:00Z");
    const h = await build();
    for (const day of ["2026-10-22", "2026-10-23"]) {
      h.prisma.order.create.mockClear();
      await h.service.create(dto(day) as never, operatorPayload as never);
      expect(h.prisma.order.create).toHaveBeenCalledTimes(1);
    }
  });

  it("no requestedDeliveryDate: untouched", async () => {
    at("2026-10-22T15:00:00Z");
    const h = await build();
    await h.service.create(dto() as never, operatorPayload as never);
    expect(h.prisma.order.create).toHaveBeenCalledTimes(1);
  });

  it("UTC is already tomorrow but the tenant is still on the 22nd: the 22nd is accepted, the 21st refused", async () => {
    at("2026-10-23T03:00:00Z"); // 20:00 on the 22nd in Los Angeles
    const h = await build("America/Los_Angeles");
    await h.service.create(dto("2026-10-22") as never, operatorPayload as never);
    expect(h.prisma.order.create).toHaveBeenCalledTimes(1);
    await expect(
      h.service.create(dto("2026-10-21") as never, operatorPayload as never),
    ).rejects.toMatchObject({ response: { code: CODE, today: "2026-10-22" } });
  });

  it("UTC is still on the 22nd but the tenant is already on the 23rd: the 22nd is refused", async () => {
    at("2026-10-22T20:00:00Z"); // 09:00 on the 23rd in Auckland
    const h = await build("Pacific/Auckland");
    await expect(
      h.service.create(dto("2026-10-22") as never, operatorPayload as never),
    ).rejects.toMatchObject({ response: { code: CODE, today: "2026-10-23" } });
    expect(h.prisma.order.create).not.toHaveBeenCalled();
  });

  it("createSale (POST /orders/sell) rides the same guard", async () => {
    at("2026-10-22T15:00:00Z");
    const h = await build();
    await expect(
      h.service.createSale(
        { ...dto("2026-10-21"), deliveredNow: false } as never,
        operatorPayload as never,
      ),
    ).rejects.toMatchObject({ response: { code: CODE } });
    expect(h.prisma.order.create).not.toHaveBeenCalled();
  });

  it("a system create (no requested date: the change-request rollover draft) is not affected", async () => {
    at("2026-10-22T15:00:00Z");
    const h = await build();
    await h.service.create(
      { items: [{ productId: "prod-1", qty: 1 }], status: "DRAFT" } as never,
      buyerPseudoUser as never,
      { internalCustomerDraft: true, allowArchived: true } as never,
    );
    expect(h.prisma.order.create).toHaveBeenCalledTimes(1);
  });
});
