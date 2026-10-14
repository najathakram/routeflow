import { Test } from "@nestjs/testing";
import { PrismaService } from "../prisma/prisma.service";
import { ProductLabelsService } from "../product-labels/product-labels.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { SellingRestrictionsService } from "./selling-restrictions.service";
import { judgedAtStore, saleFulfilmentKind } from "./sale-fulfilment";

/**
 * L8 (owner ruling 2026-10-13): a counter sale / pickup is judged on the STORE's state for every customer; a delivery
 * keeps the customer's address. One engine, one `fulfilmentKind` input; an omitted kind is the old behaviour.
 */
const T = "tenant-1";
const NOW = new Date("2026-10-13T12:00:00Z");
const CA_CUSTOMER = {
  isWalkIn: false,
  addresses: [
    { isDefault: true, addressType: "BILLING", stateCode: "CA", stateNeedsReview: false },
  ],
};

describe("selling restrictions: counter / pickup judge the STORE state (L8)", () => {
  let service: SellingRestrictionsService;
  let prisma: any;

  const stateRule = (states: string[]) => ({
    id: "r1",
    categoryId: "cat-thc",
    productId: null,
    jurisdiction: "STATE",
    states,
    surface: "ALL",
    effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    effectiveTo: null,
    liftedAt: null,
    reason: "State ban",
    targets: [], // row 509: a pre-targets rule (legacy-column fallback)
    _count: { targets: 0 },
  });
  const storeIn = (state: string | null) =>
    prisma.tenantConfig.findUnique.mockResolvedValue(state === null ? null : { state });
  const judge = (customerId: string | null, fulfilmentKind?: "COUNTER" | "PICKUP" | "DELIVERY") =>
    service.evaluate(T, customerId, [{ productId: "p1" }], {
      at: NOW,
      channel: "STAFF",
      ...(fulfilmentKind ? { fulfilmentKind } : {}),
    });

  beforeEach(async () => {
    const mock = createMockPrisma();
    mock.getTenantId.mockReturnValue(null);
    prisma = mock.forTenant();
    const model = (rows: unknown[]) => ({ findMany: jest.fn().mockResolvedValue(rows) });
    prisma.sellingRestriction = model([]);
    prisma.productCategory = model([{ id: "cat-thc", name: "THC" }]);
    prisma.systemConfig.findMany.mockResolvedValue([
      { key: "selling_restrictions.enabled", value: "true" },
    ]);
    prisma.systemConfig.findFirst.mockResolvedValue(null);
    prisma.product.findMany.mockResolvedValue([
      {
        id: "p1",
        name: "Gummies",
        parentProductId: null,
        categoryLabels: [{ categoryId: "cat-thc", mode: "INCLUDE" }],
      },
    ]);
    prisma.customer.findFirst.mockResolvedValue(CA_CUSTOMER);
    const mod = await Test.createTestingModule({
      providers: [
        SellingRestrictionsService,
        ProductLabelsService,
        { provide: PrismaService, useValue: mock },
      ],
    }).compile();
    service = mod.get(SellingRestrictionsService);
  });

  describe("(a) a named CA customer at the COUNTER, store in TX", () => {
    it("a CA-only ban does NOT block", async () => {
      prisma.sellingRestriction.findMany.mockResolvedValue([stateRule(["CA"])]);
      storeIn("TX");
      expect((await judge("c-ca", "COUNTER")).outcome).toBe("ALLOW");
    });
    it("a TX ban DOES block", async () => {
      prisma.sellingRestriction.findMany.mockResolvedValue([stateRule(["TX"])]);
      storeIn("TX");
      const res = await judge("c-ca", "COUNTER");
      expect(res.outcome).toBe("BLOCK");
      expect(res.reasons[0]).toMatchObject({ reason: "STATE_BAN", state: "TX" });
    });
  });

  it("(b) the SAME customer on a DELIVERY order is judged on CA", async () => {
    prisma.sellingRestriction.findMany.mockResolvedValue([stateRule(["CA"])]);
    storeIn("TX");
    expect((await judge("c-ca", "DELIVERY")).outcome).toBe("BLOCK");
    prisma.sellingRestriction.findMany.mockResolvedValue([stateRule(["TX"])]);
    expect((await judge("c-ca", "DELIVERY")).outcome).toBe("ALLOW");
  });

  it("(c) PICKUP -> the store state, for a named customer", async () => {
    storeIn("TX");
    prisma.sellingRestriction.findMany.mockResolvedValue([stateRule(["CA"])]);
    expect((await judge("c-ca", "PICKUP")).outcome).toBe("ALLOW");
    prisma.sellingRestriction.findMany.mockResolvedValue([stateRule(["TX"])]);
    expect((await judge("c-ca", "PICKUP")).outcome).toBe("BLOCK");
  });

  it("(d) a walk-in at the counter -> the store state (system walk-in row, and no customer at all)", async () => {
    storeIn("TX");
    prisma.sellingRestriction.findMany.mockResolvedValue([stateRule(["TX"])]);
    prisma.customer.findFirst.mockResolvedValue({ isWalkIn: true, addresses: [] });
    expect((await judge("walk-in", "COUNTER")).outcome).toBe("BLOCK");
    expect((await judge(null, "COUNTER")).outcome).toBe("BLOCK");
    prisma.sellingRestriction.findMany.mockResolvedValue([stateRule(["CA"])]);
    expect((await judge(null, "COUNTER")).outcome).toBe("ALLOW");
  });

  describe("(e) the store state is unset or unreadable: fail CLOSED", () => {
    it.each([null, "ZZ"])(
      "a named customer at the counter is INDETERMINATE (store %p)",
      async (s) => {
        prisma.sellingRestriction.findMany.mockResolvedValue([stateRule(["TX"])]);
        storeIn(s);
        // never the customer's CA address as a stand-in: that would be a guess about where the sale happened
        expect((await judge("c-ca", "COUNTER")).outcome).toBe("INDETERMINATE");
        expect((await judge("c-ca", "PICKUP")).outcome).toBe("INDETERMINATE");
      },
    );
    it("a delivery is unaffected by an unset store", async () => {
      prisma.sellingRestriction.findMany.mockResolvedValue([stateRule(["TX"])]);
      storeIn(null);
      expect((await judge("c-ca", "DELIVERY")).outcome).toBe("ALLOW");
    });
  });

  it("(g) an omitted kind is the old behaviour: customer address, walk-in -> store, none -> INDETERMINATE", async () => {
    storeIn("TX");
    prisma.sellingRestriction.findMany.mockResolvedValue([stateRule(["CA"])]);
    expect((await judge("c-ca")).outcome).toBe("BLOCK");
    expect((await judge(null)).outcome).toBe("INDETERMINATE");
    expect(prisma.tenantConfig.findUnique).not.toHaveBeenCalled();
    prisma.sellingRestriction.findMany.mockResolvedValue([stateRule(["TX"])]);
    prisma.customer.findFirst.mockResolvedValue({ isWalkIn: true, addresses: [] });
    expect((await judge("walk-in")).outcome).toBe("BLOCK");
  });

  it("the store state is read only when a STATE rule is in play", async () => {
    prisma.sellingRestriction.findMany.mockResolvedValue([]);
    storeIn("TX");
    expect((await judge("c-ca", "COUNTER")).outcome).toBe("ALLOW");
    expect(prisma.tenantConfig.findUnique).not.toHaveBeenCalled();
  });

  it("checkLinesSellable / assertLinesSellable thread the kind through", async () => {
    prisma.sellingRestriction.findMany.mockResolvedValue([stateRule(["CA"])]);
    storeIn("TX");
    const base = {
      tenantId: T,
      customerId: "c-ca",
      lines: [{ productId: "p1" }],
      channel: "STAFF" as const,
      at: NOW,
    };
    expect((await service.checkLinesSellable({ ...base, fulfilmentKind: "COUNTER" })).outcome).toBe(
      "ALLOW",
    );
    await expect(service.assertLinesSellable(base)).rejects.toMatchObject({ status: 409 });
    await expect(
      service.assertLinesSellable({ ...base, fulfilmentKind: "PICKUP" }),
    ).resolves.toBeUndefined();
  });
});

describe("sale-fulfilment: the one classifier", () => {
  it("counterSale wins, then PICKUP, else DELIVERY (ROUTE, SHIP, missing, unknown)", () => {
    expect(saleFulfilmentKind({ counterSale: true, fulfillPath: "PICKUP" })).toBe("COUNTER");
    expect(saleFulfilmentKind({ counterSale: true, fulfillPath: "ROUTE" })).toBe("COUNTER");
    expect(saleFulfilmentKind({ counterSale: false, fulfillPath: "PICKUP" })).toBe("PICKUP");
    expect(saleFulfilmentKind({ fulfillPath: "ROUTE" })).toBe("DELIVERY");
    expect(saleFulfilmentKind({ fulfillPath: "SHIP" })).toBe("DELIVERY");
    expect(saleFulfilmentKind(null)).toBe("DELIVERY");
    expect(saleFulfilmentKind({})).toBe("DELIVERY");
  });
  it("only COUNTER / PICKUP are judged at the store", () => {
    expect(judgedAtStore("COUNTER")).toBe(true);
    expect(judgedAtStore("PICKUP")).toBe(true);
    expect(judgedAtStore("DELIVERY")).toBe(false);
    expect(judgedAtStore(undefined)).toBe(false);
  });
});

/**
 * SA ruling 2026-10-14: a store with NO usable state is INDETERMINATE (fail closed) for COUNTER, POS and PICKUP —
 * never "no restriction". POS mode is not a column: a POS hand-over is stored as fulfillPath PICKUP (the server
 * never infers it from the preference), so it is judged exactly like PICKUP.
 */
describe("store state unset: the choke point refuses counter, POS and pickup (L8)", () => {
  let service: SellingRestrictionsService;
  let prisma: any;
  beforeEach(async () => {
    const mock = createMockPrisma();
    mock.getTenantId.mockReturnValue(null);
    prisma = mock.forTenant();
    const model = (rows: unknown[]) => ({ findMany: jest.fn().mockResolvedValue(rows) });
    prisma.sellingRestriction = model([
      {
        id: "r1",
        categoryId: "cat-thc",
        productId: null,
        jurisdiction: "STATE",
        states: ["TX"],
        surface: "ALL",
        effectiveFrom: new Date("2026-01-01T00:00:00Z"),
        effectiveTo: null,
        liftedAt: null,
        reason: "State ban",
        targets: [],
        _count: { targets: 0 },
      },
    ]);
    prisma.productCategory = model([{ id: "cat-thc", name: "THC" }]);
    prisma.systemConfig.findMany.mockResolvedValue([
      { key: "selling_restrictions.enabled", value: "true" },
    ]);
    prisma.systemConfig.findFirst.mockResolvedValue(null);
    prisma.product.findMany.mockResolvedValue([
      {
        id: "p1",
        name: "Gummies",
        parentProductId: null,
        categoryLabels: [{ categoryId: "cat-thc", mode: "INCLUDE" }],
      },
    ]);
    prisma.customer.findFirst.mockResolvedValue(CA_CUSTOMER);
    const mod = await Test.createTestingModule({
      providers: [
        SellingRestrictionsService,
        ProductLabelsService,
        { provide: PrismaService, useValue: mock },
      ],
    }).compile();
    service = mod.get(SellingRestrictionsService);
  });

  it.each([
    ["COUNTER", { counterSale: true, fulfillPath: "PICKUP" }],
    ["POS hand-over (stored as PICKUP)", { fulfillPath: "PICKUP" }],
    ["PICKUP", { counterSale: false, fulfillPath: "PICKUP" }],
  ])(
    "%s with no store state is refused 409, for a named, walk-in and absent customer",
    async (_n, facts) => {
      prisma.tenantConfig.findUnique.mockResolvedValue(null); // no TenantConfig, no legacy settings.state
      for (const customerId of ["c-ca", null]) {
        await expect(
          service.assertLinesSellable({
            tenantId: T,
            customerId,
            lines: [{ productId: "p1" }],
            channel: "STAFF",
            at: NOW,
            fulfilmentKind: saleFulfilmentKind(facts),
          }),
        ).rejects.toMatchObject({ status: 409 });
      }
    },
  );

  it("a blank store state is no state; a readable one lets the same sale through", async () => {
    const sale = () =>
      service.checkLinesSellable({
        tenantId: T,
        customerId: "c-ca",
        lines: [{ productId: "p1" }],
        channel: "STAFF",
        at: NOW,
        fulfilmentKind: "COUNTER",
      });
    prisma.tenantConfig.findUnique.mockResolvedValue({ state: "  " });
    expect((await sale()).outcome).toBe("INDETERMINATE");
    prisma.tenantConfig.findUnique.mockResolvedValue({ state: "FL" });
    expect((await sale()).outcome).toBe("ALLOW");
  });
});
