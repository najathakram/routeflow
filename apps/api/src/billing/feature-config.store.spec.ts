import { Test, TestingModule } from "@nestjs/testing";
import { PrismaService } from "../prisma/prisma.service";
import { FeatureConfigStore } from "./feature-config.store";

/**
 * Feature grants v2 brief C (PR-4), oracle 2 — FeatureConfigStore. Prisma-only (no authority
 * dependency: the module test below never provides AddonService/EntitlementsService, proving
 * the constructor-cycle guard for real, not just by code inspection).
 */
describe("FeatureConfigStore", () => {
  let store: FeatureConfigStore;
  let prisma: { tenantFeatureConfig: { findUnique: jest.Mock } };

  beforeEach(async () => {
    prisma = { tenantFeatureConfig: { findUnique: jest.fn() } };

    const module: TestingModule = await Test.createTestingModule({
      providers: [FeatureConfigStore, { provide: PrismaService, useValue: prisma }],
    }).compile();

    store = module.get(FeatureConfigStore);
  });

  it("no row -> {value: 'unset', source: 'REGISTRY_DEFAULT'} for routes_dispatch", async () => {
    prisma.tenantFeatureConfig.findUnique.mockResolvedValue(null);

    const result = await store.getMode("tenant-a", "routes_dispatch");

    expect(result).toEqual({ value: "unset", source: "REGISTRY_DEFAULT" });
  });

  it("a row -> {value: <row.mode>, source: 'TENANT'}", async () => {
    prisma.tenantFeatureConfig.findUnique.mockResolvedValue({ mode: "scheduled" });

    const result = await store.getMode("tenant-a", "routes_dispatch");

    expect(result).toEqual({ value: "scheduled", source: "TENANT" });
    expect(prisma.tenantFeatureConfig.findUnique).toHaveBeenCalledWith({
      where: { tenantId_featureKey: { tenantId: "tenant-a", featureKey: "routes_dispatch" } },
      select: { mode: true },
    });
  });

  it("a DB error falls back to the registry default and never throws", async () => {
    prisma.tenantFeatureConfig.findUnique.mockRejectedValue(new Error("connection reset"));

    await expect(store.getMode("tenant-a", "routes_dispatch")).resolves.toEqual({
      value: "unset",
      source: "REGISTRY_DEFAULT",
    });
  });

  it("caches a result for 30s (only one DB read across two calls within the window)", async () => {
    prisma.tenantFeatureConfig.findUnique.mockResolvedValue({ mode: "adhoc" });

    const first = await store.getMode("tenant-a", "routes_dispatch");
    const second = await store.getMode("tenant-a", "routes_dispatch");

    expect(first).toEqual({ value: "adhoc", source: "TENANT" });
    expect(second).toEqual({ value: "adhoc", source: "TENANT" });
    expect(prisma.tenantFeatureConfig.findUnique).toHaveBeenCalledTimes(1);
  });

  it("invalidate() forces the next read to hit the DB again", async () => {
    prisma.tenantFeatureConfig.findUnique.mockResolvedValueOnce({ mode: "adhoc" });
    await store.getMode("tenant-a", "routes_dispatch");

    store.invalidate("tenant-a", "routes_dispatch");
    prisma.tenantFeatureConfig.findUnique.mockResolvedValueOnce({ mode: "scheduled" });
    const afterInvalidate = await store.getMode("tenant-a", "routes_dispatch");

    expect(afterInvalidate).toEqual({ value: "scheduled", source: "TENANT" });
    expect(prisma.tenantFeatureConfig.findUnique).toHaveBeenCalledTimes(2);
  });

  it("tenant isolation: two tenants' reads never share a cache entry or a query", async () => {
    prisma.tenantFeatureConfig.findUnique.mockImplementation(({ where }: any) =>
      Promise.resolve(
        where.tenantId_featureKey.tenantId === "tenant-a"
          ? { mode: "scheduled" }
          : { mode: "adhoc" },
      ),
    );

    const a = await store.getMode("tenant-a", "routes_dispatch");
    const b = await store.getMode("tenant-b", "routes_dispatch");

    expect(a).toEqual({ value: "scheduled", source: "TENANT" });
    expect(b).toEqual({ value: "adhoc", source: "TENANT" });
  });
});
