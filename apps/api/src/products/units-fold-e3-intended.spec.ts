import { Test } from "@nestjs/testing";
import { ProductsService } from "./products.service";
import { ProductFamiliesService } from "./product-families.service";
import {
  UNITS_PRICES_V2_FLAG,
  mayInventSku,
  newProductTierFallback,
  variantTierValue,
} from "./new-product-tiers";
import { ACTOR, T, makeTx } from "./product-code-release.fake-tx";
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
 * SA-984 §4 E3 (API half): the EXPECTED differences of the units fold-in, listed in one place so they never read as
 * failures. Each row pins the NEW value (flag.units_prices_v2 ON) beside master's value (OFF), and names the ruling.
 * Not an equality row: a pin that passes on both values is wrong, so every case runs BOTH states.
 *
 *   ruling: SA-795(f) / Q1 (kept in SA-984 Check 12): a NEW product gets no invented SKU, and a tier nobody priced is
 *   stored "0" (Auto) instead of a copy of Retail. Owner 10-25 "one form for everyone" makes it the default for all.
 *
 * One service instance per flag state: UnitsPricesV2FlagCache holds the answer for 30 s per tenant (plan risk R3), so a
 * same-instance flip would return the stale value. The existing pins in products.create-defaults.spec.ts stay where they
 * are; this file is the one ledger that names every intended difference with its ruling.
 */
const TIERS = ["priceTier2", "priceTier3", "priceTier4", "priceTier5"] as const;
const RULING = "SA-795(f)/Q1 + SA-984 §4 E3";

async function productsService(flagOn: boolean) {
  const prisma = createMockPrisma();
  const hasFlag = jest.fn(async (_t: string, k: string) => flagOn && k === UNITS_PRICES_V2_FLAG);
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
  prisma.product.findFirst.mockResolvedValue(null);
  prisma.product.create.mockImplementation(() => Promise.resolve({ id: "new-1" } as never));
  return { service: module.get(ProductsService), prisma, hasFlag };
}

const createdData = async (flagOn: boolean, dto: Record<string, unknown>) => {
  const { service, prisma, hasFlag } = await productsService(flagOn);
  await service.create(dto as never);
  return { data: (prisma.product.create.mock.calls[0][0] as any).data, hasFlag };
};

describe(`E3 intended differences, new product (${RULING})`, () => {
  const dto = { name: "Plain", unit: "each", pricePerUnit: "12.50" };

  it("SKU: flag ON stores none; flag OFF (master) invents PLA-xxxx", async () => {
    const on = await createdData(true, dto);
    const off = await createdData(false, dto);
    expect(on.data.sku).toBeUndefined(); // NEW
    expect(off.data.sku).toMatch(/^PLA-[0-9A-F]{4}$/); // master
  });

  it("tiers: flag ON stores '0' (Auto) in every unpriced tier; flag OFF copies Retail 12.50; Retail itself is the typed value both ways", async () => {
    const on = await createdData(true, dto);
    const off = await createdData(false, dto);
    for (const c of TIERS) {
      expect(on.data[c]).toBe("0"); // NEW
      expect(off.data[c]).toBe("12.50"); // master
    }
    expect(on.data.pricePerUnit).toBe("12.50");
    expect(off.data.pricePerUnit).toBe("12.50");
  });

  it("the flag was read for the NEW value: ON asked flag.units_prices_v2 once; both states asked it (the answer decides)", async () => {
    const on = await createdData(true, dto);
    const off = await createdData(false, dto);
    for (const run of [on, off]) {
      expect(run.hasFlag.mock.calls.filter(([, k]) => k === UNITS_PRICES_V2_FLAG)).toHaveLength(1);
    }
  });

  it("a typed SKU and typed tiers win in both states (the difference is only the unpriced default)", async () => {
    const typed = { ...dto, sku: "TYP-1", priceTier2: "9", priceTier3: "8" };
    for (const flagOn of [true, false]) {
      const { data } = await createdData(flagOn, typed);
      expect(data.sku).toBe("TYP-1");
      expect([data.priceTier2, data.priceTier3]).toEqual(["9", "8"]);
    }
  });
});

describe(`E3 intended differences, the pure rules (${RULING})`, () => {
  it("mayInventSku: ON false, OFF true", () => {
    expect([mayInventSku(true), mayInventSku(false)]).toEqual([false, true]);
  });
  it("newProductTierFallback: ON '0', OFF the Retail string", () => {
    expect([newProductTierFallback(true, "12.50"), newProductTierFallback(false, "12.50")]).toEqual(
      ["0", "12.50"],
    );
  });
  it("variantTierValue: a copied family value wins both ways; with only a plain price ON gives '0', OFF copies it", () => {
    expect(variantTierValue(true, "9.00", "2.50")).toBe("9.00");
    expect(variantTierValue(false, "9.00", "2.50")).toBe("9.00");
    expect(variantTierValue(true, undefined, "2.50")).toBe("0"); // NEW
    expect(variantTierValue(false, undefined, "2.50")).toBe("2.50"); // master
  });
});

describe(`E3 intended differences, a family's variants (${RULING})`, () => {
  const build = (flagOn: boolean) => {
    const tx = makeTx({ products: [] });
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
    return { service, tx };
  };
  const variantAfterCreate = async (flagOn: boolean) => {
    const { service, tx } = build(flagOn);
    const out = await service.createFamily(
      {
        family: { pricePerUnit: "1.00", name: "Soda" },
        variants: [{ name: "Cola", pricePerUnit: "2.50" }],
      } as never,
      ACTOR,
    );
    return tx.products.find(
      (p) => (p as Record<string, unknown>).parentProductId === out.family.id,
    ) as Record<string, unknown>;
  };

  it("createFamily: a plain variant price stores '0' in the tiers ON, copies 2.50 OFF", async () => {
    const on = await variantAfterCreate(true);
    const off = await variantAfterCreate(false);
    expect(on.pricePerUnit).toBe("2.50");
    expect(off.pricePerUnit).toBe("2.50");
    for (const c of TIERS) {
      expect(on[c]).toBe("0"); // NEW
      expect(off[c]).toBe("2.50"); // master
    }
  });
});
