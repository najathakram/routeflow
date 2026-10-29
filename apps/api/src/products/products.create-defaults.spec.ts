import { Test } from "@nestjs/testing";
import { ProductsService } from "./products.service";
import { ProductFamiliesService } from "./product-families.service";
import { UNITS_PRICES_V2_FLAG } from "./new-product-tiers";
import { ACTOR, T, makeTx, product } from "./product-code-release.fake-tx";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { AddonService } from "../billing/addon.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { FeatureOverrideService } from "../billing/feature-override.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";

/**
 * S4 (units-and-pricing): data rules under flag.units_prices_v2, mocked transaction.
 * Flag ON  -> no invented SKU, an unpriced tier is 0 (create / importFromZoho / families).
 * Flag OFF -> master's behaviour exactly (SKU invented, tiers copy the Retail price).
 * The real-Postgres twin is products.create-defaults.db.spec.ts.
 */
const TIERS = ["priceTier2", "priceTier3", "priceTier4", "priceTier5"] as const;

describe("products.create-defaults — ProductsService", () => {
  let service: ProductsService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let hasFlag: jest.Mock;
  let flagOn: boolean;

  const build = async () => {
    prisma = createMockPrisma();
    hasFlag = jest.fn(async (_t: string, k: string) => flagOn && k === UNITS_PRICES_V2_FLAG);
    const module = await Test.createTestingModule({
      providers: [
        ProductsService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: StorageService,
          useValue: {
            presignedUrl: jest.fn().mockResolvedValue("http://mock-url"),
            presignedUrls: jest.fn().mockResolvedValue([]),
            upload: jest.fn(),
            delete: jest.fn(),
          },
        },
        { provide: AddonService, useValue: { hasAddon: jest.fn().mockResolvedValue(false) } },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        { provide: EntitlementAuthority, useValue: { can: jest.fn().mockResolvedValue(false) } },
        { provide: FeatureOverrideService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        { provide: EntitlementsService, useValue: { hasFlag } },
        {
          provide: PlanCatalogService,
          useValue: { upgradeTargetForFlag: jest.fn().mockResolvedValue(null) },
        },
        { provide: RouteFlowGateway, useValue: { emitProductUpdated: jest.fn() } },
      ],
    }).compile();
    service = module.get(ProductsService);
    prisma.product.findFirst.mockResolvedValue(null);
    prisma.product.create.mockImplementation(() => Promise.resolve({ id: "new-1" } as never));
  };

  const dataOfCreate = (n = 0) => (prisma.product.create.mock.calls[n][0] as any).data;

  describe("create — flag ON", () => {
    beforeEach(async () => {
      flagOn = true;
      await build();
    });

    it("T13: no tiers and no parent stores 0 in every tier column (Retail stays as typed)", async () => {
      await service.create({ name: "Plain", unit: "each", pricePerUnit: "12.50" } as any);
      const data = dataOfCreate();
      expect(data.pricePerUnit).toBe("12.50");
      for (const c of TIERS) expect(data[c]).toBe("0");
    });

    it("a blank SKU stays empty (nothing is invented)", async () => {
      await service.create({ name: "Plain", unit: "each", pricePerUnit: "1" } as any);
      expect(dataOfCreate().sku).toBeUndefined();
      await service.create({ name: "Plain2", unit: "each", pricePerUnit: "1", sku: "" } as any);
      expect(dataOfCreate(1).sku).toBeUndefined();
    });

    it("an explicit SKU and explicit tiers still win", async () => {
      await service.create({
        name: "Typed",
        unit: "each",
        pricePerUnit: "10",
        sku: "TYP-1",
        priceTier2: "9",
        priceTier3: "8",
      } as any);
      const data = dataOfCreate();
      expect(data.sku).toBe("TYP-1");
      expect([data.priceTier2, data.priceTier3, data.priceTier4, data.priceTier5]).toEqual([
        "9",
        "8",
        "0",
        "0",
      ]);
    });

    it("a variant of a parent with 0 tiers inherits 0 (in both modes)", async () => {
      const parent = {
        id: "parent-1",
        isActive: true,
        kind: "STANDARD",
        parentProductId: null,
        priceTier2: 0,
        priceTier3: 0,
        priceTier4: 0,
        priceTier5: 0,
        category: null,
        unitsPerBox: null,
        costingMethod: "AVCO",
        standardCost: null,
        isTobacco: false,
      };
      prisma.product.findFirst.mockImplementation(({ where }: any) =>
        Promise.resolve(where?.id === "parent-1" ? parent : null),
      );
      await service.create(
        {
          name: "Kid",
          unit: "each",
          pricePerUnit: "7",
          parentProductId: "parent-1",
        } as any,
        { reparentVia: "editor" },
      );
      for (const c of TIERS) expect(dataOfCreate()[c]).toBe("0");
    });

    it("a variant of a parent with REAL tiers inherits exactly those, not 0", async () => {
      const parent = {
        id: "parent-2",
        isActive: true,
        kind: "STANDARD",
        parentProductId: null,
        priceTier2: 9,
        priceTier3: 8,
        priceTier4: 7,
        priceTier5: 6,
        category: null,
        unitsPerBox: null,
        costingMethod: "AVCO",
        standardCost: null,
        isTobacco: false,
      };
      prisma.product.findFirst.mockImplementation(({ where }: any) =>
        Promise.resolve(where?.id === "parent-2" ? parent : null),
      );
      await service.create(
        {
          name: "Kid",
          unit: "each",
          pricePerUnit: "10",
          parentProductId: "parent-2",
        } as any,
        { reparentVia: "editor" },
      );
      const data = dataOfCreate();
      expect([data.priceTier2, data.priceTier3, data.priceTier4, data.priceTier5]).toEqual([
        "9",
        "8",
        "7",
        "6",
      ]);
    });

    it("reads the flag once, BEFORE the transaction opens, and caches it for the next create", async () => {
      await service.create({ name: "A", unit: "each", pricePerUnit: "1" } as any);
      await service.create({ name: "B", unit: "each", pricePerUnit: "1" } as any);
      const flagCalls = hasFlag.mock.calls.filter(([, k]) => k === UNITS_PRICES_V2_FLAG);
      expect(flagCalls).toHaveLength(1);
      const readAt =
        hasFlag.mock.invocationCallOrder[
          hasFlag.mock.calls.findIndex(([, k]) => k === UNITS_PRICES_V2_FLAG)
        ];
      expect(readAt).toBeLessThan(prisma.tenantTransaction.mock.invocationCallOrder[0]);
    });
  });

  describe("create — flag OFF (master's values)", () => {
    beforeEach(async () => {
      flagOn = false;
      await build();
    });

    it("copies the Retail price into every unpriced tier", async () => {
      await service.create({ name: "Plain", unit: "each", pricePerUnit: "12.50" } as any);
      for (const c of TIERS) expect(dataOfCreate()[c]).toBe("12.50");
    });

    it("invents a SKU from the name", async () => {
      await service.create({ name: "Plain", unit: "each", pricePerUnit: "1" } as any);
      expect(dataOfCreate().sku).toMatch(/^PLA-[0-9A-F]{4}$/);
    });
  });

  describe("importFromZoho", () => {
    const items = [
      { name: "Item A", unit: "each", pricePerUnit: "3.00" },
      { name: "Item B", unit: "each", pricePerUnit: "4.00" },
    ];

    it("flag ON: tiers are 0, Retail is the row's price, and the flag is read once before the loop", async () => {
      flagOn = true;
      await build();
      const out = await service.importFromZoho({ items } as any);
      expect(out.created).toBe(2);
      expect(dataOfCreate(0)).toMatchObject({ pricePerUnit: "3.00" });
      for (const n of [0, 1]) for (const c of TIERS) expect(dataOfCreate(n)[c]).toBe("0");
      expect(hasFlag.mock.calls.filter(([, k]) => k === UNITS_PRICES_V2_FLAG)).toHaveLength(1);
    });

    it("flag OFF: master copies the row's price into every tier", async () => {
      flagOn = false;
      await build();
      await service.importFromZoho({ items } as any);
      for (const c of TIERS) expect(dataOfCreate(0)[c]).toBe("3.00");
    });
  });
});

describe("products.create-defaults — ProductFamiliesService", () => {
  const build = (flagOn: boolean, seed: Parameters<typeof makeTx>[0] = { products: [] }) => {
    const tx = makeTx(seed);
    const hasFlag = jest.fn(async (_t: string, k: string) => flagOn && k === UNITS_PRICES_V2_FLAG);
    const prisma = {
      getTenantId: () => T,
      tenantTransaction: jest.fn((fn: (t: unknown) => unknown) => fn(tx)),
      forTenant: () => tx,
    };
    const service = new ProductFamiliesService(
      prisma as never,
      { emitProductUpdated: jest.fn() } as never,
      { log: jest.fn().mockResolvedValue(undefined) } as never,
      { getEffectiveMode: jest.fn().mockResolvedValue("off") } as never,
      { hasFlag } as never,
    );
    return { service, tx, hasFlag, prisma };
  };
  const kidsOf = (tx: ReturnType<typeof makeTx>, familyId: string) =>
    tx.products.filter((p) => (p as Record<string, unknown>).parentProductId === familyId) as Array<
      Record<string, unknown>
    >;
  const dto = (extra: Record<string, unknown> = {}) =>
    ({
      family: { pricePerUnit: "1.00", name: "Soda" },
      variants: [{ name: "Cola", pricePerUnit: "2.50" }],
      ...extra,
    }) as never;

  it("createFamily flag ON: a plain variant price stores 0 in the tier columns", async () => {
    const { service, tx, hasFlag, prisma } = build(true);
    const out = await service.createFamily(dto(), ACTOR);
    const [kid] = kidsOf(tx, out.family.id);
    expect(kid.pricePerUnit).toBe("2.50");
    for (const c of TIERS) expect(kid[c]).toBe("0");
    expect(hasFlag.mock.calls.filter(([, k]) => k === UNITS_PRICES_V2_FLAG)).toHaveLength(1);
    expect(hasFlag.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.tenantTransaction.mock.invocationCallOrder[0],
    );
  });

  it("createFamily flag OFF: master copies the plain price into the tier columns", async () => {
    const { service, tx } = build(false);
    const out = await service.createFamily(dto(), ACTOR);
    const [kid] = kidsOf(tx, out.family.id);
    for (const c of TIERS) expect(kid[c]).toBe("2.50");
  });

  it("createFamily flag ON + copyFamilyPrice: the variant gets the family Retail and 0 in the tiers", async () => {
    const { service, tx } = build(true);
    const out = await service.createFamily(dto({ copyFamilyPrice: true }), ACTOR);
    const [kid] = kidsOf(tx, out.family.id);
    expect(Number(kid.pricePerUnit)).toBe(1);
    for (const c of TIERS) expect(kid[c]).toBe("0");
  });

  it("createFamily flag OFF + copyFamilyPrice: master copies the family Retail into the tiers", async () => {
    const { service, tx } = build(false);
    const out = await service.createFamily(dto({ copyFamilyPrice: true }), ACTOR);
    const [kid] = kidsOf(tx, out.family.id);
    expect(Number(kid.pricePerUnit)).toBe(1);
    for (const c of TIERS) expect(Number(kid[c])).toBe(1);
  });

  it("updateVariants flag ON: an added variant gets 0 tiers; flag OFF copies", async () => {
    const fam = { ...product({ id: "fam", name: "Soda" }), kind: "FAMILY" };
    for (const [flagOn, expected] of [
      [true, "0"],
      [false, "3.10"],
    ] as const) {
      const { service, tx } = build(flagOn, { products: [{ ...fam }] });
      await service.updateVariants(
        "fam",
        { add: [{ name: "Lime", pricePerUnit: "3.10" }] } as never,
        ACTOR,
      );
      const [kid] = kidsOf(tx, "fam");
      expect(kid.pricePerUnit).toBe("3.10");
      for (const c of TIERS) expect(kid[c]).toBe(expected);
    }
  });
});
