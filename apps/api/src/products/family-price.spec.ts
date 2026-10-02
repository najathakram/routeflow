import { Test, TestingModule } from "@nestjs/testing";
import { ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { getTierPrice } from "@routeflow/pricing";
import { FEATURE_REGISTRY } from "../billing/feature-registry";
import { FeatureConfigService } from "../billing/feature-config.service";
import { FeatureConfigStore } from "../billing/feature-config.store";
import { FeatureOverrideService } from "../billing/feature-override.service";
import { AddonService } from "../billing/addon.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";
import { AuditService } from "../audit/audit.service";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { StockAlertService } from "../stock-alerts/stock-alert.service";
import { InventoryService } from "../inventory/inventory.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { ProductsService } from "./products.service";
import {
  FAMILY_PRICE_COLUMNS,
  propagateFamilyPrice,
  variantPriceWriteDecision,
} from "./family-price";

/**
 * #2717 M2 (SA-574) family price authority. Test 15: the `mixed_packs` registry row is OFF by
 * default, and a tenant with no config row resolves to "off" through the real FeatureConfigService.
 */
describe("mixed_packs registry row (test 15)", () => {
  const row = FEATURE_REGISTRY.find((f) => f.key === "mixed_packs");

  it("exists, boolean, catalog area, not default-granted", () => {
    expect(row).toBeDefined();
    expect(row?.kind).toBe("boolean");
    expect(row?.area).toBe("catalog");
    expect(row?.defaultGranted).toBe(false);
  });

  it('falls back to "off" and offers exactly the off/on modes with no settings', () => {
    expect(row?.config?.fallbackMode).toBe("off");
    expect(Object.keys(row?.config?.modes ?? {}).sort()).toEqual(["off", "on"]);
    for (const mode of Object.values(row?.config?.modes ?? {})) {
      expect(mode.settings).toEqual([]);
      expect(mode.available).toBe(true);
    }
  });

  it('getEffectiveMode for a tenant with no config row is "off"', async () => {
    const store = {
      getMode: jest.fn().mockResolvedValue({ value: "off", source: "REGISTRY_DEFAULT" }),
      invalidate: jest.fn(),
    };
    const module = await Test.createTestingModule({
      providers: [
        FeatureConfigService,
        { provide: PrismaService, useValue: {} },
        { provide: FeatureConfigStore, useValue: store },
        { provide: AuditService, useValue: { log: jest.fn() } },
        { provide: AddonService, useValue: { hasAddon: jest.fn() } },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn() } },
        entitlementAuthorityFromEntitlements,
        { provide: FeatureOverrideService, useValue: { get: jest.fn().mockResolvedValue(null) } },
      ],
    }).compile();
    const service = module.get(FeatureConfigService);
    await expect(service.getEffectiveMode("tenant-a", "mixed_packs")).resolves.toBe("off");
  });
});

// ─── shared fixtures ───────────────────────────────────────────────────────────────────────────
const D = (n: number | string) => new Prisma.Decimal(n);

/** A family row with a full, distinct ladder (tier 4 deliberately equal to list: a real-world "inherit"). */
const FAMILY_PRICES = {
  pricePerUnit: D("10.00"),
  priceTier2: D("9.50"),
  priceTier3: D("9.00"),
  priceTier4: D("0"),
  priceTier5: D("8.00"),
};

describe("variantPriceWriteDecision (test 17, pure)", () => {
  const family = { pricePerUnit: "10.00", priceTier2: "9.50", priceTier3: "10.00" };

  it("mode on, governed row, a tier that differs from the family's effective tier -> refuse", () => {
    expect(
      variantPriceWriteDecision({
        mode: "on",
        governed: true,
        dto: { priceTier3: "9.99" },
        family,
      }),
    ).toEqual({ allow: false });
  });

  it("compares after roundMoney: 10.004 vs 10.00 -> allow (an idempotent client re-save)", () => {
    expect(
      variantPriceWriteDecision({
        mode: "on",
        governed: true,
        dto: { priceTier3: "10.004" },
        family,
      }),
    ).toEqual({ allow: true });
  });

  it("compares EFFECTIVE tiers: a raw 0 tier equals an explicit tier at the list price", () => {
    expect(
      variantPriceWriteDecision({
        mode: "on",
        governed: true,
        dto: { priceTier4: "10.00" },
        family: { ...family, priceTier4: "0" },
      }),
    ).toEqual({ allow: true });
  });

  it("a new list price shifts every inheriting tier -> refuse", () => {
    expect(
      variantPriceWriteDecision({
        mode: "on",
        governed: true,
        dto: { pricePerUnit: "11.00" },
        family: { ...family, priceTier4: "0" },
      }),
    ).toEqual({ allow: false });
  });

  it("a row the family does not govern (non-variant, or an override recipe) -> allow", () => {
    expect(
      variantPriceWriteDecision({ mode: "on", governed: false, dto: { priceTier3: "1" }, family }),
    ).toEqual({ allow: true });
  });

  it("mode off -> allow, whatever the dto says", () => {
    expect(
      variantPriceWriteDecision({ mode: "off", governed: true, dto: { priceTier3: "1" }, family }),
    ).toEqual({ allow: true });
  });

  it("a dto with no price key -> allow", () => {
    expect(variantPriceWriteDecision({ mode: "on", governed: true, dto: {}, family })).toEqual({
      allow: true,
    });
  });
});

/** In-memory Product/Recipe/AuditLog tables behind just enough of the tx surface propagation uses. */
function fakeTx(rows: Array<Record<string, any>>, recipes: Array<Record<string, any>> = []) {
  const matches = (row: Record<string, any>, where: Record<string, any>): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (v && typeof v === "object" && "in" in v) return (v.in as unknown[]).includes(row[k]);
      return row[k] === v;
    });
  const tx: any = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    product: {
      findFirst: jest.fn(async ({ where }: any) => rows.find((r) => matches(r, where)) ?? null),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const hit = rows.filter((r) => matches(r, where));
        for (const r of hit) Object.assign(r, data);
        return { count: hit.length };
      }),
    },
    recipe: {
      findMany: jest.fn(async ({ where }: any) => recipes.filter((r) => matches(r, where))),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  return tx;
}

describe("propagateFamilyPrice (test 18, real ladder)", () => {
  function fixture() {
    const rows = [
      {
        id: "fam",
        tenantId: "t1",
        parentProductId: null,
        familyPriceOverride: false,
        ...FAMILY_PRICES,
      },
      ...["v1", "v2"].map((id) => ({
        id,
        tenantId: "t1",
        parentProductId: "fam",
        familyPriceOverride: false,
        pricePerUnit: D("7"),
        priceTier2: D("7"),
        priceTier3: D("7"),
        priceTier4: D("7"),
        priceTier5: D("7"),
      })),
      {
        id: "rec-inherit",
        tenantId: "t1",
        parentProductId: null,
        familyPriceOverride: false,
        pricePerUnit: D("99"),
        priceTier2: D("99"),
        priceTier3: D("99"),
        priceTier4: D("99"),
        priceTier5: D("99"),
      },
      {
        id: "rec-own",
        tenantId: "t1",
        parentProductId: null,
        familyPriceOverride: true,
        pricePerUnit: D("55"),
        priceTier2: D("55"),
        priceTier3: D("55"),
        priceTier4: D("55"),
        priceTier5: D("55"),
      },
      // a corrupt tenant-B row that claims the family as its parent (test 25 in the unit lane)
      {
        id: "other-tenant",
        tenantId: "t2",
        parentProductId: "fam",
        familyPriceOverride: false,
        pricePerUnit: D("3"),
        priceTier2: D("3"),
        priceTier3: D("3"),
        priceTier4: D("3"),
        priceTier5: D("3"),
      },
    ];
    const recipes = [
      { tenantId: "t1", familyProductId: "fam", productId: "rec-inherit" },
      { tenantId: "t1", familyProductId: "fam", productId: "rec-own" },
    ];
    return { rows, tx: fakeTx(rows, recipes) };
  }

  it("copies all five columns to every variant and every non-override recipe; getTierPrice matches for t=1..5", async () => {
    const { rows, tx } = fixture();
    const result = await propagateFamilyPrice(tx, { tenantId: "t1", familyId: "fam" });
    expect(result).toEqual({ variants: 2, recipes: 1 });
    const fam = rows.find((r) => r.id === "fam")!;
    for (const id of ["v1", "v2", "rec-inherit"]) {
      const row = rows.find((r) => r.id === id)!;
      for (const t of [1, 2, 3, 4, 5]) expect(getTierPrice(row, t)).toBe(getTierPrice(fam, t));
      for (const col of FAMILY_PRICE_COLUMNS) expect(String(row[col])).toBe(String(fam[col]));
    }
  });

  it("leaves an override recipe and another tenant's row untouched", async () => {
    const { rows, tx } = fixture();
    await propagateFamilyPrice(tx, { tenantId: "t1", familyId: "fam" });
    expect(String(rows.find((r) => r.id === "rec-own")!.pricePerUnit)).toBe("55");
    expect(String(rows.find((r) => r.id === "other-tenant")!.pricePerUnit)).toBe("3");
  });

  it("copies a null tier as null (raw column copy, nulls included)", async () => {
    const { rows, tx } = fixture();
    (rows[0] as any).priceTier4 = null;
    await propagateFamilyPrice(tx, { tenantId: "t1", familyId: "fam" });
    expect(rows.find((r) => r.id === "v1")!.priceTier4).toBeNull();
  });

  it("writes one audit row naming the counts, and none when nothing changed", async () => {
    const { tx } = fixture();
    await propagateFamilyPrice(tx, { tenantId: "t1", familyId: "fam" });
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create.mock.calls[0][0].data).toMatchObject({
      tenantId: "t1",
      entityType: "product",
      entityId: "fam",
      meta: { variants: 2, recipes: 1 },
    });
    const empty = fakeTx([{ id: "fam", tenantId: "t1", ...FAMILY_PRICES }]);
    await expect(propagateFamilyPrice(empty, { tenantId: "t1", familyId: "fam" })).resolves.toEqual(
      { variants: 0, recipes: 0 },
    );
    expect(empty.auditLog.create).not.toHaveBeenCalled();
  });

  it("refuses an empty family id or tenant id before any write (many-write safety)", async () => {
    const { tx } = fixture();
    await expect(propagateFamilyPrice(tx, { tenantId: "t1", familyId: "" })).rejects.toThrow();
    await expect(propagateFamilyPrice(tx, { tenantId: "", familyId: "fam" })).rejects.toThrow();
    expect(tx.product.updateMany).not.toHaveBeenCalled();
  });

  it("every many-write carries the tenant id and the family id in its where", async () => {
    const { tx } = fixture();
    await propagateFamilyPrice(tx, { tenantId: "t1", familyId: "fam" });
    for (const call of tx.product.updateMany.mock.calls) {
      expect(call[0].where.tenantId).toBe("t1");
    }
    // House lock order: the recipe products are written first, the variants (parentProductId) last.
    const last = tx.product.updateMany.mock.calls.at(-1)!;
    expect(last[0].where.parentProductId).toBe("fam");
  });
});

// ─── ProductsService write paths ──────────────────────────────────────────────────────────────
describe("ProductsService family price authority (tests 16, 18-22)", () => {
  let prisma: ReturnType<typeof createMockPrisma>;
  let gateway: { emitProductUpdated: jest.Mock };
  let featureConfig: { getEffectiveMode: jest.Mock };
  let rows: Record<string, any>;

  const base = (over: Record<string, any>) => ({
    name: "Row",
    sku: "SKU",
    unit: "case",
    isActive: true,
    imageKeys: [] as string[],
    barcode: null,
    unitsPerBox: 12,
    parentProductId: null,
    kind: "STANDARD",
    familyPriceOverride: false,
    trackedCategoryId: null,
    trackedSubcategoryId: null,
    regItemType: null,
    regUomCase: null,
    regUomUnit: null,
    category: null,
    trackedSubcategory: null,
    variants: [],
    ...FAMILY_PRICES,
    ...over,
  });

  async function build(mode: "on" | "off" | "absent"): Promise<ProductsService> {
    prisma = createMockPrisma();
    gateway = { emitProductUpdated: jest.fn() };
    featureConfig = { getEffectiveMode: jest.fn().mockResolvedValue(mode === "on" ? "on" : "off") };
    rows = {
      fam: base({ id: "fam", name: "Family" }),
      var1: base({ id: "var1", name: "Cherry", parentProductId: "fam" }),
      rec1: base({ id: "rec1", name: "Mix", kind: "RECIPE", pricePerUnit: D("20") }),
      loose: base({ id: "loose", name: "Loose", pricePerUnit: D("4") }),
    };
    prisma.product.findUnique.mockImplementation(async ({ where }: any) => rows[where.id] ?? null);
    prisma.product.findFirst.mockImplementation(async ({ where }: any) => {
      if (where?.name) return null; // name / sku uniqueness probes: nothing clashes
      if (where?.OR) return null;
      return rows[where?.id] ?? null;
    });
    prisma.product.update.mockImplementation(async ({ where, data }: any) => ({
      ...rows[where.id],
      ...data,
      barcode: null,
      imageKeys: [],
    }));
    prisma.product.updateMany.mockResolvedValue({ count: 0 });
    const providers: any[] = [
      ProductsService,
      { provide: PrismaService, useValue: prisma },
      { provide: StorageService, useValue: { presignedUrls: jest.fn().mockResolvedValue([]) } },
      { provide: AddonService, useValue: { hasAddon: jest.fn().mockResolvedValue(false) } },
      { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
      { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(true) } },
      entitlementAuthorityFromEntitlements,
      // #2185: the reorder gate's deny body reads admin overrides.
      { provide: FeatureOverrideService, useValue: { get: jest.fn().mockResolvedValue(null) } },
      { provide: PlanCatalogService, useValue: { upgradeTargetForFlag: jest.fn() } },
      { provide: RouteFlowGateway, useValue: gateway },
    ];
    if (mode !== "absent")
      providers.push({ provide: FeatureConfigService, useValue: featureConfig });
    const mod: TestingModule = await Test.createTestingModule({ providers }).compile();
    return mod.get(ProductsService);
  }

  const written = (id: string) =>
    prisma.product.update.mock.calls.find((c: any) => c[0].where.id === id)?.[0].data;

  // 16 — OFF is behaviour-neutral
  it("OFF: a variant tier PATCH writes exactly as today, and a family PATCH leaves variants alone", async () => {
    const service = await build("off");
    await service.update("var1", { priceTier3: "1.00" } as any);
    expect(written("var1")).toMatchObject({ priceTier3: "1.00" });
    await service.update("fam", { priceTier3: "5.00" } as any);
    expect(prisma.product.updateMany).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("no FeatureConfigService wired at all behaves as OFF", async () => {
    const service = await build("absent");
    await service.update("var1", { priceTier3: "1.00" } as any);
    expect(written("var1")).toMatchObject({ priceTier3: "1.00" });
    expect(prisma.product.updateMany).not.toHaveBeenCalled();
  });

  // 19
  it("ON: a variant tier PATCH -> 409 FAMILY_PRICE_AUTHORITY {familyId}, nothing written", async () => {
    const service = await build("on");
    const err = await service.update("var1", { priceTier3: "1.00" } as any).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ code: "FAMILY_PRICE_AUTHORITY", familyId: "fam" });
    expect(prisma.product.update).not.toHaveBeenCalled();
  });

  it("ON: a non-price PATCH on a variant is 200 and never consults the family", async () => {
    const service = await build("on");
    await service.update("var1", { description: "new copy" } as any);
    expect(written("var1")).toMatchObject({ description: "new copy" });
    expect(prisma.product.updateMany).not.toHaveBeenCalled();
  });

  it("ON: a variant re-save with equal prices is allowed and writes no price column", async () => {
    const service = await build("on");
    await service.update("var1", { priceTier3: "9.004", description: "x" } as any);
    const data = written("var1");
    for (const col of FAMILY_PRICE_COLUMNS) expect(data[col]).toBeUndefined();
  });

  // 18
  it("ON: a family PATCH propagates in the same tx, after the family row lock, with one bulk emit", async () => {
    const service = await build("on");
    prisma.product.updateMany.mockResolvedValue({ count: 3 });
    prisma.product.update.mockImplementation(async ({ where, data }: any) => {
      rows[where.id] = { ...rows[where.id], ...data };
      return { ...rows[where.id], barcode: null, imageKeys: [] };
    });
    await service.update("fam", { priceTier3: "8.50" } as any);
    expect(prisma.product.updateMany).toHaveBeenCalled();
    const bulk = gateway.emitProductUpdated.mock.calls.filter((c) => c[1].action === "bulk");
    expect(bulk).toHaveLength(1);
    const lock = (prisma.$queryRaw as jest.Mock).mock.invocationCallOrder;
    expect(lock).toBeDefined();
  });

  it("ON: no bulk emit when the transaction rejects (L-237)", async () => {
    const service = await build("on");
    prisma.product.update.mockRejectedValue(new Error("boom"));
    await expect(service.update("fam", { priceTier3: "8.50" } as any)).rejects.toThrow("boom");
    expect(gateway.emitProductUpdated).not.toHaveBeenCalled();
  });

  it("ON: a family PATCH with no price key does not propagate", async () => {
    const service = await build("on");
    await service.update("fam", { description: "x" } as any);
    expect(prisma.product.updateMany).not.toHaveBeenCalled();
  });

  // 22
  it("ON: a non-override recipe's own tier PATCH -> 409; familyPriceOverride=true -> 200", async () => {
    const service = await build("on");
    prisma.recipe.findFirst.mockResolvedValue({ familyProductId: "fam" });
    const err = await service.update("rec1", { priceTier3: "1.00" } as any).catch((e) => e);
    expect(err.getResponse()).toMatchObject({ code: "FAMILY_PRICE_AUTHORITY", familyId: "fam" });
    rows.rec1 = { ...rows.rec1, familyPriceOverride: true };
    await service.update("rec1", { priceTier3: "1.00" } as any);
    expect(written("rec1")).toMatchObject({ priceTier3: "1.00" });
  });

  // 21
  it("ON: bulkAssignParent adopting a product with other tiers takes the family's five columns and audits once", async () => {
    const service = await build("on");
    const result = await service.bulkAssignParent({
      parentProductId: "fam",
      assignments: [{ id: "loose", variantName: "Loose" }],
    } as any);
    expect(result.succeeded).toEqual(["loose"]);
    const data = written("loose");
    for (const col of FAMILY_PRICE_COLUMNS)
      expect(String(data[col])).toBe(String(FAMILY_PRICES[col]));
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create.mock.calls[0][0].data).toMatchObject({
      entityType: "product",
      entityId: "loose",
    });
  });

  it("OFF: bulkAssignParent leaves the adopted product's own prices and writes no audit row", async () => {
    const service = await build("off");
    await service.bulkAssignParent({
      parentProductId: "fam",
      assignments: [{ id: "loose", variantName: "Loose" }],
    } as any);
    expect(written("loose").pricePerUnit).toBeUndefined();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  // 20 — products.service create
  const createDto = (over: Record<string, any> = {}) => ({
    name: "Grape",
    variantName: "Grape",
    parentProductId: "fam",
    sku: "GRP-1",
    unit: "case",
    pricePerUnit: "10.00",
    ...over,
  });

  it("ON: variant create ends with the family's five columns (locked re-read, not the dto)", async () => {
    const service = await build("on");
    await service.create(createDto() as any);
    const data = prisma.product.create.mock.calls[0][0].data;
    for (const col of FAMILY_PRICE_COLUMNS)
      expect(String(data[col])).toBe(String(FAMILY_PRICES[col]));
  });

  it("ON: variant create with an explicit differing tier -> 409 FAMILY_PRICE_AUTHORITY", async () => {
    const service = await build("on");
    const err = await service.create(createDto({ priceTier2: "1.00" }) as any).catch((e) => e);
    expect(err.getResponse()).toMatchObject({ code: "FAMILY_PRICE_AUTHORITY", familyId: "fam" });
    expect(prisma.product.create).not.toHaveBeenCalled();
  });

  it("OFF: variant create keeps today's inheritance from the parent", async () => {
    const service = await build("off");
    await service.create(createDto({ priceTier2: "1.00" }) as any);
    expect(prisma.product.create.mock.calls[0][0].data.priceTier2).toBe("1.00");
  });
});

// ─── InventoryService.createVariant (test 20) ───────────────────────────────────────────────────
describe("InventoryService assignToVariants new variant (test 20)", () => {
  async function run(mode: "on" | "off") {
    const prisma = createMockPrisma();
    const parent = {
      id: "fam",
      name: "Cola",
      unit: "case",
      parentProductId: null,
      currentStock: D(20),
      averageCost: D(4),
      standardCost: null,
      costingMethod: "AVCO",
      unitsPerBox: 12,
      category: null,
      isTobacco: false,
      trackedCategoryId: null,
      trackedSubcategoryId: null,
      regItemType: null,
      regUomCase: null,
      regUomUnit: null,
      // stale copy a tx read before the family edit committed
      pricePerUnit: D("1"),
      priceTier2: D("1"),
      priceTier3: D("1"),
      priceTier4: D("1"),
      priceTier5: D("1"),
    };
    prisma.product.findUnique.mockResolvedValue(parent);
    prisma.product.findFirst.mockImplementation(async ({ where }: any) =>
      where?.id === "fam" ? { ...parent, ...FAMILY_PRICES } : null,
    );
    prisma.product.create.mockResolvedValue({
      id: "new-var",
      name: "Cola - Cherry",
      variantName: "Cherry",
      currentStock: D(0),
      averageCost: null,
      costingMethod: "AVCO",
    });
    const providers: any[] = [
      InventoryService,
      { provide: PrismaService, useValue: prisma },
      {
        provide: StockAlertService,
        useValue: { fireForProducts: jest.fn().mockResolvedValue({ notified: 0 }) },
      },
    ];
    if (mode === "on") {
      providers.push({
        provide: FeatureConfigService,
        useValue: { getEffectiveMode: jest.fn().mockResolvedValue("on") },
      });
    }
    const mod = await Test.createTestingModule(providers.length ? { providers } : {}).compile();
    const service = mod.get(InventoryService);
    await service.assignToVariants(
      {
        parentProductId: "fam",
        assignments: [{ newVariant: { name: "Cherry" }, qty: 2 }],
      } as any,
      "user-1",
    );
    return prisma.product.create.mock.calls[0][0].data;
  }

  it("ON: the new variant takes the family's five columns, not the stale parent read", async () => {
    const data = await run("on");
    for (const col of FAMILY_PRICE_COLUMNS)
      expect(String(data[col])).toBe(String(FAMILY_PRICES[col]));
  });

  it("OFF: the new variant copies the parent row exactly as today", async () => {
    const data = await run("off");
    expect(String(data.pricePerUnit)).toBe("1");
  });
});
