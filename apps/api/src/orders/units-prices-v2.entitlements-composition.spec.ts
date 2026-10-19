/**
 * SA-812a G-1 (MUST-1): the units_prices_v2 flag read, through the REAL EntitlementsService composed with the REAL
 * FeatureOverrideService (only Prisma and the plan catalog are mocked).
 *
 * The flag is in no plan, so it is granted only by a per-tenant override. FeatureOverrideService.get() fails open to
 * null on a DB error, and EntitlementsService.hasFlag() then reads "no override" + "not in the plan" as a CLEAN false:
 * a typed-price customer would be billed the tier price. loadUnitsPricesV2 therefore reads the flag strictly, so a
 * failed override read (or a failed plan resolution) is the coded, retryable 503 and nothing is priced or written.
 */
import { ServiceUnavailableException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { EntitlementsService } from "../billing/entitlements.service";
import { FeatureOverrideService } from "../billing/feature-override.service";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { PrismaService } from "../prisma/prisma.service";
import { loadUnitsPricesV2, UNITS_PRICES_V2_FLAG } from "./units-prices-v2";

const catalogVersion = () => ({
  id: "planver_v7",
  status: "PUBLISHED",
  definitions: [
    {
      planKey: "STARTER",
      name: "Starter",
      seatsIncluded: 1,
      routesConcurrent: 1,
      scansIncluded: 20,
      msgsIncluded: 200,
      customersIncluded: 100,
      featureFlags: ["addon.ocr"], // the units flag is deliberately in NO plan
    },
  ],
  addonSkus: [],
});

const tenantRow = {
  id: "t1",
  status: "ACTIVE",
  plan: "STARTER",
  planVersionId: "planver_v7",
  trialEndsAt: null,
  subscription: null,
  addons: [],
};

async function build() {
  const prisma = {
    tenantFeatureOverride: { findMany: jest.fn().mockResolvedValue([]) },
    tenant: { findUnique: jest.fn().mockResolvedValue(tenantRow) },
  };
  const catalog = {
    getVersionForTenant: jest.fn().mockResolvedValue(catalogVersion()),
    getPublishedVersion: jest.fn().mockResolvedValue(catalogVersion()),
  };
  const moduleRef = await Test.createTestingModule({
    providers: [
      EntitlementsService,
      FeatureOverrideService,
      { provide: PrismaService, useValue: prisma },
      { provide: PlanCatalogService, useValue: catalog },
    ],
  }).compile();
  const entitlements = moduleRef.get(EntitlementsService);
  const overrides = moduleRef.get(FeatureOverrideService);
  const db = {
    customerUnitPrice: {
      findMany: jest.fn().mockResolvedValue([{ productId: "p1", unitRef: "pack", price: "33" }]),
    },
    productUnit: { findMany: jest.fn().mockResolvedValue([]) },
    productTierUnit: { findMany: jest.fn().mockResolvedValue([]) },
  };
  return { prisma, entitlements, overrides, db, deps: { entitlements, db, tenantId: "t1" } };
}

const fail503 = async (p: Promise<unknown>) => {
  const err = await p.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ServiceUnavailableException);
  expect((err as ServiceUnavailableException).getStatus()).toBe(503);
  expect((err as ServiceUnavailableException).getResponse()).toMatchObject({
    code: API_ERROR_CODES.CUSTOMER_PRICES_UNAVAILABLE,
  });
};

describe("units_prices_v2 flag read: real EntitlementsService + FeatureOverrideService (G-1 MUST-1)", () => {
  it("a REJECTED override read + typed rows is the coded 503, never a clean false (never tier price)", async () => {
    const h = await build();
    h.prisma.tenantFeatureOverride.findMany.mockRejectedValue(new Error("db down"));
    await fail503(loadUnitsPricesV2(h.deps as never, "c1", ["p1"]));
    // it fails before the ladder is read: nothing downstream ran
    expect(h.db.productUnit.findMany).not.toHaveBeenCalled();
  });

  it("the plain hasFlag() still reads that same failure as false (the lenient callers are unchanged)", async () => {
    const h = await build();
    h.prisma.tenantFeatureOverride.findMany.mockRejectedValue(new Error("db down"));
    await expect(h.entitlements.hasFlag("t1", UNITS_PRICES_V2_FLAG)).resolves.toBe(false);
    await expect(h.overrides.get("t1", UNITS_PRICES_V2_FLAG)).resolves.toBeNull();
  });

  it("hasFlagStrict / get({strict}) propagate the override error", async () => {
    const h = await build();
    h.prisma.tenantFeatureOverride.findMany.mockRejectedValue(new Error("db down"));
    await expect(h.entitlements.hasFlagStrict("t1", UNITS_PRICES_V2_FLAG)).rejects.toThrow(
      "db down",
    );
    await expect(h.overrides.get("t1", UNITS_PRICES_V2_FLAG, { strict: true })).rejects.toThrow(
      "db down",
    );
  });

  it("a healthy override read with no override and the flag in no plan is a clean false: master's chain (null)", async () => {
    const h = await build();
    await expect(loadUnitsPricesV2(h.deps as never, "c1", ["p1"])).resolves.toBeNull();
  });

  it("a healthy DENY override is a clean false: master's chain (null), even with typed rows", async () => {
    const h = await build();
    h.prisma.tenantFeatureOverride.findMany.mockResolvedValue([
      { featureKey: UNITS_PRICES_V2_FLAG, effect: "DENY", expiresAt: null },
    ]);
    await expect(loadUnitsPricesV2(h.deps as never, "c1", ["p1"])).resolves.toBeNull();
  });

  it("a healthy GRANT override turns the typed-price context on", async () => {
    const h = await build();
    h.prisma.tenantFeatureOverride.findMany.mockResolvedValue([
      { featureKey: UNITS_PRICES_V2_FLAG, effect: "GRANT", expiresAt: null },
    ]);
    await expect(loadUnitsPricesV2(h.deps as never, "c1", ["p1"])).resolves.not.toBeNull();
  });

  it("a failed plan resolution (override read fine, no row) is also the coded 503", async () => {
    const h = await build();
    h.prisma.tenant.findUnique.mockRejectedValue(new Error("db down"));
    await fail503(loadUnitsPricesV2(h.deps as never, "c1", ["p1"]));
  });

  it("no typed rows (only an odd tier) + a failed override read keeps the master fallback", async () => {
    const h = await build();
    h.db.customerUnitPrice.findMany.mockResolvedValue([]);
    h.prisma.tenantFeatureOverride.findMany.mockRejectedValue(new Error("db down"));
    await expect(loadUnitsPricesV2(h.deps as never, "c1", ["p1"], [9])).resolves.toBeNull();
  });
});
