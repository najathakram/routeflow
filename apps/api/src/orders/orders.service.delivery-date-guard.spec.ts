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

/**
 * Row 735(c) — an Idempotency-Key replay is judged BEFORE the past-date guard: a retry of an order that already
 * landed returns the original, even when the date it carried (yesterday's, when it was created) has since passed on
 * the tenant's calendar. The guard still binds a request that is not a replay.
 */
describe("row 735(c) — a replay of a past-dated order replays, it does not 400", () => {
  const ORIGINAL = {
    id: "ord-old",
    customerId: "cust-1",
    status: "PENDING" as const,
    lineItems: [{ productId: "prod-1", qty: 1, status: "PENDING" }],
  };
  const keyed = (day: string) => ({ ...dto(day), idempotencyKey: "k-735" });
  const replayOf = (h: Awaited<ReturnType<typeof build>>, found: unknown) =>
    jest.spyOn(h.service as never, "findReplayCandidateByKey").mockResolvedValue(found as never);

  it("create(): yesterday's date, replayed today, returns the original and writes nothing", async () => {
    at("2026-10-22T15:00:00Z"); // today in New York; the order was created on the 21st with the 21st
    const h = await build();
    replayOf(h, ORIGINAL);
    const onReplay = jest.fn();
    await expect(
      h.service.create(keyed("2026-10-21") as never, operatorPayload as never, { onReplay }),
    ).resolves.toBe(ORIGINAL);
    expect(onReplay).toHaveBeenCalledTimes(1);
    expect(h.prisma.order.create).not.toHaveBeenCalled();
  });

  it("create(): the same past date with NO original behind the key is still refused", async () => {
    at("2026-10-22T15:00:00Z");
    const h = await build();
    replayOf(h, null);
    await expect(
      h.service.create(keyed("2026-10-21") as never, operatorPayload as never),
    ).rejects.toMatchObject({ response: { code: CODE } });
    expect(h.prisma.order.create).not.toHaveBeenCalled();
  });

  it("create(), a UTC-10 tenant (Pacific/Honolulu): the replay of the tenant's yesterday replays", async () => {
    at("2026-10-23T05:00:00Z"); // 19:00 on the 22nd in Honolulu; the order carried the 21st
    const h = await build("Pacific/Honolulu");
    replayOf(h, ORIGINAL);
    await expect(
      h.service.create(keyed("2026-10-21") as never, operatorPayload as never),
    ).resolves.toBe(ORIGINAL);
    expect(h.prisma.order.create).not.toHaveBeenCalled();
  });

  it("createSale: a requested delivery date of yesterday, replayed today, resumes the original sale", async () => {
    at("2026-10-22T15:00:00Z");
    const h = await build();
    replayOf(h, ORIGINAL);
    await expect(
      h.service.createSale(
        { ...keyed("2026-10-21"), deliveredNow: false } as never,
        operatorPayload as never,
      ),
    ).resolves.toBeDefined();
    expect(h.prisma.order.create).not.toHaveBeenCalled();
  });

  it("createSale: a deliveredOn of yesterday (a backdated delivered sale), replayed today, replays too", async () => {
    at("2026-10-22T15:00:00Z");
    const h = await build();
    replayOf(h, { ...ORIGINAL, status: "DELIVERED" });
    await expect(
      h.service.createSale(
        {
          customerId: "cust-1",
          items: dto().items,
          deliveredNow: false,
          deliveredOn: "2026-10-21",
          idempotencyKey: "k-735",
        } as never,
        operatorPayload as never,
      ),
    ).resolves.toBeDefined();
    expect(h.prisma.order.create).not.toHaveBeenCalled();
  });

  it("createSale, a UTC-10 tenant: a deliveredOn the UTC clock calls today but the tenant calls tomorrow is scheduled (zone read from TenantConfig)", async () => {
    at("2026-10-22T05:00:00Z"); // 19:00 on the 21st in Honolulu, already the 22nd in UTC
    const h = await build("Pacific/Honolulu");
    const create = jest
      .spyOn(h.service as never, "create")
      .mockResolvedValue({ id: "ord-1", status: "PENDING" } as never);
    await h.service.createSale(
      {
        customerId: "cust-1",
        items: dto().items,
        deliveredNow: true,
        deliveredOn: "2026-10-22",
      } as never,
      operatorPayload as never,
    );
    // scheduled: the order carries the day as its requested delivery date and is not marked delivered
    expect((create.mock.calls[0] as unknown[])[0]).toMatchObject({
      requestedDeliveryDate: "2026-10-22",
    });
    expect(h.prisma.order.update).not.toHaveBeenCalled();
  });
});

describe("row 735 — DST: the tenant's day across a 25-hour fall-back day (America/Chicago, 2026-11-01)", () => {
  it("23:30 CST on the 1st (05:30Z on the 2nd): the 1st is still today, the guard lets it through", async () => {
    at("2026-11-02T05:30:00Z"); // a fixed CDT (-5) reading would call this 00:30 on the 2nd
    const h = await build("America/Chicago");
    await h.service.create(dto("2026-11-01") as never, operatorPayload as never);
    expect(h.prisma.order.create).toHaveBeenCalledTimes(1);
  });

  it("00:30 CST on the 2nd (06:30Z): the 1st has passed", async () => {
    at("2026-11-02T06:30:00Z");
    const h = await build("America/Chicago");
    await expect(
      h.service.create(dto("2026-11-01") as never, operatorPayload as never),
    ).rejects.toMatchObject({ response: { code: CODE, today: "2026-11-02" } });
  });

  it("the repeated hour (01:30 CDT 06:30Z and 01:30 CST 07:30Z) is the 1st both times", async () => {
    for (const iso of ["2026-11-01T06:30:00Z", "2026-11-01T07:30:00Z"]) {
      at(iso);
      const h = await build("America/Chicago");
      await h.service.create(dto("2026-11-01") as never, operatorPayload as never);
      expect(h.prisma.order.create).toHaveBeenCalledTimes(1);
      await expect(
        h.service.create(dto("2026-10-31") as never, operatorPayload as never),
      ).rejects.toMatchObject({ response: { code: CODE, today: "2026-11-01" } });
    }
  });
});
