/**
 * #2696(c) — one staff price-override rule on SPECIAL-priced lines (SA-558 / 558a / 558b).
 *
 * decideStaffOverride / needsOverrideReason (@routeflow/pricing, matrix in staff-override.spec.ts)
 * are the ONE rule; this pins the api WIRING of each act:
 *   A  create + substitute — decideStaffOverride, baseline = the customer's TIER price:
 *      within ½¢ of tier ⇒ not an override (SPECIAL / STANDARD at the clean tier price, no reason);
 *      a real change on a special-tier line with no reason ⇒ 400 naming the product;
 *      otherwise DISCOUNTED (< list) / MANUAL (≥ list), originalPrice = list, rounded, reason +
 *      overriddenBy recorded. Substitute is pinned byte-identical (it already was rule A, B466).
 *   C  add-during-edit — only the REASON GUARD converges (needsOverrideReason, tier baseline): a
 *      typed tier price no longer 400s. Its classification (≠ catalog ⇒ MANUAL) is byte-identical.
 */
jest.mock("../common/db-locks", () => ({
  ...jest.requireActual("../common/db-locks"),
  withAdvisoryLock: jest.fn(async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  })),
}));

import {
  buildOrdersService,
  operatorPayload,
  customerPayload,
} from "./testing/orders-service-harness";

const staff = { ...operatorPayload, tenantId: "t-1" } as never;

/** list 10, tier-3 price 8 — tier 3 is a SPECIAL tier. */
const TIERED = {
  id: "prod-1",
  name: "Tiered Widget",
  unit: "each",
  pricePerUnit: 10,
  priceTier3: 8,
  unitsPerBox: null,
  category: null,
  trackedCategoryId: null,
  trackedSubcategoryId: null,
  isActive: true,
};
/** A 12-pack: case list 24, tier-3 case price 18. */
const BOXED = {
  ...TIERED,
  id: "prod-box",
  name: "Boxed Widget",
  pricePerUnit: 24,
  priceTier3: 18,
  unitsPerBox: 12,
};

describe("#2696(c) staff price override — create (rule A)", () => {
  let h: Awaited<ReturnType<typeof buildOrdersService>>;
  const orderData = () => h.prisma.order.create.mock.calls[0][0].data;
  const line = () => orderData().lineItems.create[0];

  const seed = (tier: number) => {
    h.prisma.customer.findFirst.mockResolvedValue({ id: "cust-1", pricingTier: tier });
    h.prisma.customer.findUnique.mockResolvedValue({
      id: "cust-1",
      pricingTier: tier,
      user: { status: "ACTIVE" },
      deletedAt: null,
    });
    h.prisma.customerPrice.findMany.mockResolvedValue([]);
    h.prisma.product.findMany.mockResolvedValue([TIERED, BOXED]);
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

  beforeEach(async () => {
    h = await buildOrdersService();
  });

  const create = (items: unknown[], user: never = staff) =>
    h.service.create({ customerId: "cust-1", items } as never, user);

  it("A1 red-first: a special line typed AT its tier price is not an override — SPECIAL at tier, no reason needed", async () => {
    seed(3);
    await create([{ productId: "prod-1", qty: 2, unitPrice: 8 }]);
    expect(line()).toMatchObject({
      unitPrice: 8,
      priceType: "SPECIAL",
      originalPrice: 10,
      subtotal: 16,
    });
    expect(line().overrideReason ?? null).toBeNull();
  });

  it("A2 red-first: a near-miss within ½¢ of tier lands on the CLEAN tier price", async () => {
    seed(3);
    await create([{ productId: "prod-1", qty: 1, unitPrice: 8.004 }]);
    expect(line()).toMatchObject({ unitPrice: 8, priceType: "SPECIAL", originalPrice: 10 });
  });

  it("A3 red-first: a real change on a special line with no reason is 400 naming the product; nothing written", async () => {
    seed(3);
    await expect(create([{ productId: "prod-1", qty: 2, unitPrice: 6 }])).rejects.toThrow(
      /reason is required to change Tiered Widget/,
    );
    await expect(create([{ productId: "prod-1", qty: 2, unitPrice: 10 }])).rejects.toThrow(
      /Tiered Widget/,
    );
    expect(h.prisma.order.create).not.toHaveBeenCalled();
  });

  it("A4 red-first: below list WITH a reason ⇒ DISCOUNTED, originalPrice list, reason + overriddenBy recorded", async () => {
    seed(3);
    await create([
      { productId: "prod-1", qty: 2, unitPrice: 6, overrideReason: "  damaged box  " },
    ]);
    expect(line()).toMatchObject({
      unitPrice: 6,
      priceType: "DISCOUNTED",
      originalPrice: 10,
      overrideReason: "damaged box",
      overriddenBy: "user-op",
      subtotal: 12,
    });
  });

  it("A5 red-first: AT list on a special line (off tier) with a reason ⇒ MANUAL at list, originalPrice list", async () => {
    seed(3);
    await create([{ productId: "prod-1", qty: 1, unitPrice: 10, overrideReason: "list today" }]);
    expect(line()).toMatchObject({
      unitPrice: 10,
      priceType: "MANUAL",
      originalPrice: 10,
      overrideReason: "list today",
    });
  });

  it("A6: above list with a reason ⇒ MANUAL (upsell), rounded to cents", async () => {
    seed(3);
    await create([{ productId: "prod-1", qty: 1, unitPrice: 12.456, overrideReason: "rush" }]);
    expect(line()).toMatchObject({ unitPrice: 12.46, priceType: "MANUAL", originalPrice: 10 });
  });

  it("A7: a non-special customer needs no reason — below list ⇒ DISCOUNTED (unchanged), attributed", async () => {
    seed(1);
    await create([{ productId: "prod-1", qty: 2, unitPrice: 6 }]);
    expect(line()).toMatchObject({
      unitPrice: 6,
      priceType: "DISCOUNTED",
      originalPrice: 10,
      overriddenBy: "user-op",
    });
  });

  it("A8 red-first: a non-special near-miss within ½¢ of list is STANDARD at the clean list price", async () => {
    seed(1);
    await create([{ productId: "prod-1", qty: 1, unitPrice: 9.996 }]);
    expect(line()).toMatchObject({ unitPrice: 10, priceType: "STANDARD", originalPrice: null });
  });

  it("A9: a boxed override prices through computeLineSubtotal (1 case + 6 loose at 20/case = 30), never qty × price", async () => {
    seed(3);
    await create([
      { productId: "prod-box", boxes: 1, pieces: 6, unitPrice: 20, overrideReason: "promo case" },
    ]);
    expect(line()).toMatchObject({
      unitPrice: 20,
      priceType: "DISCOUNTED",
      originalPrice: 24,
      boxes: 1,
      pieces: 6,
      subtotal: 30,
    });
  });

  it("A10: no typed price keeps the tier ladder (SPECIAL at tier, unchanged)", async () => {
    seed(3);
    await create([{ productId: "prod-1", qty: 2 }]);
    expect(line()).toMatchObject({ unitPrice: 8, priceType: "SPECIAL", originalPrice: 10 });
  });

  it("A11: a buyer's unitPrice / overrideReason are ignored (B13 — non-staff never set prices)", async () => {
    seed(3);
    await create([{ productId: "prod-1", qty: 2, unitPrice: 1, overrideReason: "x" }], {
      ...customerPayload,
      tenantId: "t-1",
    } as never).catch(() => undefined);
    const calls = h.prisma.order.create.mock.calls;
    if (calls.length > 0) {
      expect(line().unitPrice).not.toBe(1);
      expect(line().overrideReason ?? null).toBeNull();
    }
  });
});

describe("#2696(c) staff price override — updateOrderItems", () => {
  let h: Awaited<ReturnType<typeof buildOrdersService>>;
  const MOCK_ORDER = {
    id: "ord-1",
    customerId: "cust-1",
    orderNumber: "ORD-123",
    status: "DRAFT" as const,
    source: "APP" as const,
    urgent: false,
    subtotal: 10,
    tax: 0,
    total: 10,
    notes: null,
    routeRunId: null,
    routeRunStopId: null,
    customer: { businessName: "Test Business" },
  };
  const orderWithA = {
    ...MOCK_ORDER,
    lineItems: [
      {
        id: "li-A",
        orderId: "ord-1",
        productId: "prod-A",
        qty: 2,
        unitPrice: 5,
        subtotal: 10,
        status: "PENDING",
        boxes: null,
        pieces: null,
      },
    ],
  };

  beforeEach(async () => {
    h = await buildOrdersService();
    h.prisma.customer.findFirst.mockResolvedValue({ pricingTier: 3 }); // operatorTierCtx read
    h.prisma.customerPrice.findMany.mockResolvedValue([]);
    h.prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 16, status: "PENDING" }]);
  });

  describe("C — add a line during edit", () => {
    beforeEach(() => {
      h.prisma.order.findUnique.mockResolvedValue({ ...MOCK_ORDER, lineItems: [] });
      h.prisma.product.findMany.mockResolvedValue([TIERED]);
      h.prisma.product.findUnique.mockResolvedValue(TIERED);
    });
    const add = (item: Record<string, unknown>) =>
      h.service.updateOrderItems(
        "ord-1",
        { items: [{ productId: "prod-1", qty: 2, ...item }], replaceAll: false } as never,
        operatorPayload as never,
      );

    it("C1 red-first (SA-558b(2)): a typed TIER price with no reason is no longer a 400 and is no override (#2716: stays SPECIAL)", async () => {
      await add({ unitPrice: 8 });
      expect(h.prisma.orderItem.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            unitPrice: 8,
            priceType: "SPECIAL",
            originalPrice: 10,
            overrideReason: null,
          }),
        }),
      );
    });

    it("C2: an off-tier price with no reason is still refused", async () => {
      await expect(add({ unitPrice: 6 })).rejects.toThrow(/Tiered Widget/);
      expect(h.prisma.orderItem.create).not.toHaveBeenCalled();
    });

    it("C3 (#2716): off-tier below list with a reason ⇒ DISCOUNTED at the typed price, originalPrice list", async () => {
      await add({ unitPrice: 6, overrideReason: "loyalty" });
      expect(h.prisma.orderItem.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            unitPrice: 6,
            priceType: "DISCOUNTED",
            originalPrice: 10,
            overrideReason: "loyalty",
            overriddenBy: "user-op",
            subtotal: 12,
          }),
        }),
      );
    });

    it("C4 (#2716): a typed price equal to LIST on a special-tier line with a reason ⇒ MANUAL, originalPrice list", async () => {
      await add({ unitPrice: 10, overrideReason: "list today" });
      expect(h.prisma.orderItem.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            unitPrice: 10,
            priceType: "MANUAL",
            originalPrice: 10,
          }),
        }),
      );
    });
  });

  describe("A — substitute (byte-identical to master)", () => {
    beforeEach(() => {
      h.prisma.order.findUnique.mockResolvedValue(orderWithA);
      h.prisma.product.findUniqueOrThrow.mockResolvedValue({
        ...TIERED,
        id: "prod-tob",
        name: "Tiered Sub",
      });
    });
    const sub = (item: Record<string, unknown>) =>
      h.service.updateOrderItems(
        "ord-1",
        {
          items: [{ id: "li-A", substituteProductId: "prod-tob", qty: 2, ...item }],
          replaceAll: false,
        } as never,
        operatorPayload as never,
      );
    const written = () => h.prisma.orderItem.update.mock.calls[0][0].data;

    it.each([
      [
        "no price",
        {},
        {
          unitPrice: 8,
          priceType: "SPECIAL",
          originalPrice: 10,
          overrideReason: null,
          overriddenBy: null,
        },
      ],
      [
        "tier echo",
        { unitPrice: 8 },
        {
          unitPrice: 8,
          priceType: "SPECIAL",
          originalPrice: 10,
          overrideReason: null,
          overriddenBy: null,
        },
      ],
      [
        "in-band 8.004",
        { unitPrice: 8.004 },
        {
          unitPrice: 8,
          priceType: "SPECIAL",
          originalPrice: 10,
          overrideReason: null,
          overriddenBy: null,
        },
      ],
      [
        "in-band 7.996",
        { unitPrice: 7.996 },
        {
          unitPrice: 8,
          priceType: "SPECIAL",
          originalPrice: 10,
          overrideReason: null,
          overriddenBy: null,
        },
      ],
      [
        "below list + reason",
        { unitPrice: 6.456, overrideReason: "bent" },
        {
          unitPrice: 6.46,
          priceType: "DISCOUNTED",
          originalPrice: 10,
          overrideReason: "bent",
          overriddenBy: "user-op",
        },
      ],
      [
        "at list + reason",
        { unitPrice: 10, overrideReason: "list" },
        {
          unitPrice: 10,
          priceType: "MANUAL",
          originalPrice: 10,
          overrideReason: "list",
          overriddenBy: "user-op",
        },
      ],
      [
        "above list + reason",
        { unitPrice: 12, overrideReason: "rush" },
        {
          unitPrice: 12,
          priceType: "MANUAL",
          originalPrice: 10,
          overrideReason: "rush",
          overriddenBy: "user-op",
        },
      ],
    ])("S %s", async (_n, item, expected) => {
      await sub(item);
      expect(written()).toMatchObject({
        productId: "prod-tob",
        ...expected,
        subtotal: expected.unitPrice * 2,
      });
    });

    it("S off-tier without a reason ⇒ 400 naming the product", async () => {
      await expect(sub({ unitPrice: 5 })).rejects.toThrow(/Tiered Sub/);
      expect(h.prisma.orderItem.update).not.toHaveBeenCalled();
    });

    it("S non-special customer: a below-list price needs no reason ⇒ DISCOUNTED", async () => {
      h.prisma.customer.findFirst.mockResolvedValue({ pricingTier: 1 });
      await sub({ unitPrice: 6 });
      expect(written()).toMatchObject({
        unitPrice: 6,
        priceType: "DISCOUNTED",
        originalPrice: 10,
        overrideReason: null,
        overriddenBy: "user-op",
      });
    });
  });
});

describe("#2696(c) SA-558d (i) — the create auto-merge's NEW line is a create", () => {
  const PICK = ["unitPrice", "priceType", "originalPrice", "overrideReason", "overriddenBy"];
  const pick = (d: Record<string, unknown>) =>
    Object.fromEntries(PICK.map((k) => [k, d[k] ?? null]));

  /** The line POST /orders writes for a fresh order. */
  const viaCreate = async (item: Record<string, unknown>) => {
    const h = await buildOrdersService();
    h.prisma.customer.findFirst.mockResolvedValue({ id: "cust-1", pricingTier: 3 });
    h.prisma.customer.findUnique.mockResolvedValue({
      id: "cust-1",
      pricingTier: 3,
      user: { status: "ACTIVE" },
      deletedAt: null,
    });
    h.prisma.customerPrice.findMany.mockResolvedValue([]);
    h.prisma.product.findMany.mockResolvedValue([TIERED]);
    h.prisma.order.create.mockImplementation((args: any) =>
      Promise.resolve({
        id: "o",
        orderNumber: "1",
        createdAt: new Date(),
        customer: { businessName: "Acme" },
        urgent: false,
        ...args.data,
        lineItems: [],
      }),
    );
    await h.service.create(
      { customerId: "cust-1", items: [{ productId: "prod-1", qty: 2, ...item }] } as never,
      staff,
    );
    return pick(h.prisma.order.create.mock.calls[0][0].data.lineItems.create[0]);
  };

  /** The line the same payload writes when it folds into a pending order (isCreateMerge). */
  const viaMerge = async (item: Record<string, unknown>) => {
    const h = await buildOrdersService();
    h.prisma.order.findUnique.mockResolvedValue({
      id: "ord-1",
      customerId: "cust-1",
      status: "PENDING",
      lineItems: [],
      customer: { businessName: "Acme" },
    });
    h.prisma.customer.findFirst.mockResolvedValue({ pricingTier: 3 });
    h.prisma.customerPrice.findMany.mockResolvedValue([]);
    h.prisma.product.findMany.mockResolvedValue([TIERED]);
    h.prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 16, status: "PENDING" }]);
    await h.service.updateOrderItems(
      "ord-1",
      { items: [{ productId: "prod-1", qty: 2, ...item }], replaceAll: true } as never,
      operatorPayload as never,
      { isCreateMerge: true },
    );
    return pick(h.prisma.orderItem.create.mock.calls[0][0].data);
  };

  it.each([
    ["the tier price", { unitPrice: 8 }],
    ["in-band 8.004", { unitPrice: 8.004 }],
    ["below list + reason", { unitPrice: 6, overrideReason: " bent box " }],
    ["at list + reason", { unitPrice: 10, overrideReason: "list" }],
    ["above list + reason, unrounded", { unitPrice: 12.456, overrideReason: "rush" }],
    ["no price", {}],
  ])("parity, %s: a fresh order and a folded one store the same line", async (_n, item) => {
    const fresh = await viaCreate(item);
    expect(await viaMerge(item)).toEqual(fresh);
  });

  it("an off-tier price with no reason is refused on both paths", async () => {
    await expect(viaCreate({ unitPrice: 6 })).rejects.toThrow(/Tiered Widget/);
    await expect(viaMerge({ unitPrice: 6 })).rejects.toThrow(/Tiered Widget/);
  });
});
