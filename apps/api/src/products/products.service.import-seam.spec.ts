/**
 * B858 — the ProductsService surface the CSV importer depends on:
 *   R1: create() writes reorderPoint/reorderQty in its ONE create write (a first import used to
 *       plan them and store NULL, so every re-import planned null → n forever).
 *   W3: assertIdentityAvailable() is the read-only half of create()/update() — the importer's
 *       preview calls it — and throws exactly what those writes throw.
 */
import { BadRequestException, ConflictException, ForbiddenException } from "@nestjs/common";
import { buildPlanGateBody } from "../billing/plan-gate";
import { Test, TestingModule } from "@nestjs/testing";
import { ProductsService } from "./products.service";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { FeatureOverrideService } from "../billing/feature-override.service";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { AddonService } from "../billing/addon.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { createMockPrisma } from "../testing/prisma-mock";

const UPGRADE = {
  planKey: "PRO",
  planMonthlyPrice: "99",
  addonSku: null,
  addonMonthlyPrice: null,
};

/** The 403 PlanFlagGuard throws for PATCH /inventory/products/:id/reorder-settings. */
const inventoryRouteDenial = () =>
  new ForbiddenException(buildPlanGateBody("flag.forecasting", UPGRADE)).getResponse();

describe("ProductsService — importer seam (B858)", () => {
  let service: ProductsService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let authority: { can: jest.Mock };
  let featureOverrides: { get: jest.Mock };
  let entitlements: { hasFlag: jest.Mock; resolve: jest.Mock };
  let planCatalog: { upgradeTargetForFlag: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrisma();
    authority = { can: jest.fn().mockResolvedValue(true) };
    featureOverrides = { get: jest.fn().mockResolvedValue(null) };
    entitlements = {
      hasFlag: jest.fn(async (_t: string, k: string) => k !== "flag.units_prices_v2"),
      resolve: jest.fn().mockResolvedValue({ planKey: "LITE", flags: [] }),
    };
    planCatalog = { upgradeTargetForFlag: jest.fn().mockResolvedValue(UPGRADE) };
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        ProductsService,
        // flag.forecasting gate for reorder writes (assertReorderAllowed) — permitted here.
        { provide: EntitlementAuthority, useValue: authority },
        { provide: FeatureOverrideService, useValue: featureOverrides },
        { provide: PrismaService, useValue: prisma },
        { provide: StorageService, useValue: { presignedUrls: jest.fn().mockResolvedValue([]) } },
        { provide: AddonService, useValue: { hasAddon: jest.fn().mockResolvedValue(false) } },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        { provide: EntitlementsService, useValue: entitlements },
        { provide: PlanCatalogService, useValue: planCatalog },
        { provide: RouteFlowGateway, useValue: { emitProductUpdated: jest.fn() } },
      ],
    }).compile();
    service = mod.get(ProductsService);
    prisma.product.findFirst.mockResolvedValue(null);
    prisma.product.create.mockResolvedValue({ id: "prod-new" });
  });

  it("R1: create() stores reorderPoint and reorderQty in the one create write", async () => {
    await service.create(
      {
        name: "Widget",
        sku: "W-1",
        unit: "case",
        pricePerUnit: "10",
        reorderPoint: 4,
        reorderQty: 48,
      },
      { suppressEmit: true },
    );

    expect(prisma.product.create).toHaveBeenCalledTimes(1);
    expect(prisma.product.create.mock.calls[0][0].data).toMatchObject({
      reorderPoint: 4,
      reorderQty: 48,
    });
    expect(prisma.product.update).not.toHaveBeenCalled();
  });

  it("R1: create() without reorder values leaves them unset (never 0)", async () => {
    await service.create({ name: "Widget", sku: "W-1", unit: "case", pricePerUnit: "10" });

    const data = prisma.product.create.mock.calls[0][0].data;
    expect(data.reorderPoint).toBeUndefined();
    expect(data.reorderQty).toBeUndefined();
  });

  it("W3: a standalone name already taken throws the create() conflict", async () => {
    prisma.product.findFirst.mockResolvedValueOnce({ id: "prod-other" });

    await expect(
      service.assertIdentityAvailable({ name: "Widget", parentProductId: null }),
    ).rejects.toThrow(new ConflictException('A product named "Widget" already exists'));
    expect(prisma.product.findFirst.mock.calls[0][0].where).toEqual({
      name: { equals: "Widget", mode: "insensitive" },
      isActive: true,
      parentProductId: null,
    });
  });

  it("W3: a sku colliding with another product's unit code throws, excluding the product itself", async () => {
    prisma.product.findFirst.mockResolvedValueOnce({ id: "prod-other" });

    await expect(service.assertIdentityAvailable({ sku: "W-1" }, "prod-self")).rejects.toThrow(
      new BadRequestException("SKU already exists"),
    );
    expect(prisma.product.findFirst.mock.calls[0][0].where).toEqual({
      OR: [{ sku: "W-1" }, { unitSku: "W-1" }],
      isActive: true,
      id: { not: "prod-self" },
    });
  });

  it("W3: nothing to check asks nothing and writes nothing", async () => {
    await service.assertIdentityAvailable({});

    expect(prisma.product.findFirst).not.toHaveBeenCalled();
    expect(prisma.product.create).not.toHaveBeenCalled();
    expect(prisma.product.update).not.toHaveBeenCalled();
  });

  it("W3: create() still refuses a taken name through the shared check", async () => {
    prisma.product.findFirst.mockResolvedValueOnce({ id: "prod-other" });

    await expect(
      service.create({ name: "Widget", sku: "W-1", unit: "case", pricePerUnit: "10" }),
    ).rejects.toThrow(ConflictException);
    expect(prisma.product.create).not.toHaveBeenCalled();
  });

  it("R1: update() writes reorderPoint and reorderQty from its DTO", async () => {
    prisma.product.findUnique.mockResolvedValue({
      id: "prod-1",
      name: "Widget",
      sku: "W-1",
      parentProductId: null,
      trackedCategoryId: null,
      trackedSubcategoryId: null,
      imageKeys: [],
    });
    prisma.product.update.mockResolvedValue({ id: "prod-1" });

    await service.update("prod-1", { reorderPoint: 4, reorderQty: 48 }, { suppressEmit: true });

    const writes = prisma.product.update.mock.calls.map((c: any) => c[0].data);
    expect(writes).toContainEqual(expect.objectContaining({ reorderPoint: 4, reorderQty: 48 }));
  });

  // ── SA-322: reorder settings are a flag.forecasting feature on EVERY writer ──────────────────
  describe("SA-322 reorder gate", () => {
    const EXISTING = {
      id: "prod-1",
      name: "Widget",
      sku: "W-1",
      parentProductId: null,
      trackedCategoryId: null,
      trackedSubcategoryId: null,
      imageKeys: [],
    };

    it("PATCH (update) with reorderPoint alone asks flag.forecasting", async () => {
      prisma.product.findUnique.mockResolvedValue(EXISTING);
      prisma.product.update.mockResolvedValue({ id: "prod-1" });

      await service.update("prod-1", { reorderPoint: 4 });

      expect(authority.can).toHaveBeenCalledWith("test-tenant", "flag.forecasting");
    });

    it("a flagless tenant gets the inventory endpoint's 403 on update, and nothing is written", async () => {
      authority.can.mockResolvedValue(false);
      prisma.product.findUnique.mockResolvedValue(EXISTING);

      const err = await service.update("prod-1", { reorderQty: 48 }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as ForbiddenException).getResponse()).toEqual(inventoryRouteDenial());
      expect(prisma.product.update).not.toHaveBeenCalled();
    });

    it("a flagless tenant gets the same 403 on create, and nothing is written", async () => {
      authority.can.mockResolvedValue(false);

      const err = await service
        .create({ name: "Widget", sku: "W-1", unit: "case", pricePerUnit: "10", reorderPoint: 4 })
        .catch((e: unknown) => e);

      expect((err as ForbiddenException).getResponse()).toEqual(inventoryRouteDenial());
      expect(prisma.product.create).not.toHaveBeenCalled();
    });

    it("an ordinary edit without reorder fields never asks the gate", async () => {
      prisma.product.findUnique.mockResolvedValue(EXISTING);
      prisma.product.update.mockResolvedValue({ id: "prod-1" });

      await service.update("prod-1", { description: "x" });
      await service.create({ name: "Other", sku: "O-1", unit: "case", pricePerUnit: "1" });

      expect(authority.can).not.toHaveBeenCalled();
    });

    it("the bulk product import refuses a batch carrying a reorder point before any write", async () => {
      authority.can.mockResolvedValue(false);

      await expect(
        service.importFromZoho({
          items: [
            { name: "Widget", unit: "case", pricePerUnit: "10" },
            { name: "Gadget", unit: "case", pricePerUnit: "10", reorderPoint: 5 },
          ],
        } as any),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.product.create).not.toHaveBeenCalled();
      expect(prisma.tenantTransaction).not.toHaveBeenCalled();
    });

    // SA-329 N1: the denial BODY is the guard's, from the one shared builder.
    it("an admin override DENY returns PLAN_GATE with NO upgrade target, as the guard does", async () => {
      authority.can.mockResolvedValue(false);
      featureOverrides.get.mockResolvedValue("DENY");

      const err = await service.assertReorderAllowed().catch((e: unknown) => e);

      expect((err as ForbiddenException).getResponse()).toEqual(
        new ForbiddenException(
          buildPlanGateBody("flag.forecasting", {
            planKey: null,
            planMonthlyPrice: null,
            addonSku: null,
            addonMonthlyPrice: null,
          }),
        ).getResponse(),
      );
      expect(planCatalog.upgradeTargetForFlag).not.toHaveBeenCalled();
    });

    it("unresolvable entitlements after a deny return PLAN_GATE_UNAVAILABLE, as the guard does", async () => {
      authority.can.mockResolvedValue(false);
      entitlements.resolve.mockRejectedValue(new Error("db down"));

      const err = await service.assertReorderAllowed().catch((e: unknown) => e);

      expect((err as ForbiddenException).getResponse()).toEqual({
        code: "PLAN_GATE_UNAVAILABLE",
        message: "Entitlements are temporarily unavailable. Please retry.",
      });
      expect(planCatalog.upgradeTargetForFlag).not.toHaveBeenCalled();
    });

    it("SA-329 N3: no tenant context (SUPER_ADMIN) is never gated and asks nothing", async () => {
      prisma.getTenantId.mockReturnValue(null);
      authority.can.mockResolvedValue(false);

      await expect(service.assertReorderAllowed()).resolves.toBeUndefined();
      expect(authority.can).not.toHaveBeenCalled();
      expect(featureOverrides.get).not.toHaveBeenCalled();
    });
  });
});
