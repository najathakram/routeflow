import { Test, TestingModule } from "@nestjs/testing";
import {
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from "@nestjs/common";
import { ProductsService } from "./products.service";
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

describe("ProductsService name guards (B964-2)", () => {
  let service: ProductsService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let addonService: { hasAddon: jest.Mock };
  let systemConfig: { get: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrisma();

    const module: TestingModule = await Test.createTestingModule({
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
        {
          provide: AddonService,
          useValue: { hasAddon: jest.fn().mockResolvedValue(false) },
        },
        {
          provide: SystemConfigService,
          useValue: { get: jest.fn().mockResolvedValue(null) },
        },
        // MSRP gate collaborators — flag.msrp defaults OFF; the pre-MSRP tests
        // never send an msrp key, so assertMsrpAllowed is never even called.
        {
          provide: EntitlementAuthority,
          useValue: { can: jest.fn().mockResolvedValue(false) },
        },
        // #2185: reorder gate deny-body collaborators.
        { provide: FeatureOverrideService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        {
          provide: PlanCatalogService,
          useValue: { upgradeTargetForFlag: jest.fn().mockResolvedValue(null) },
        },
        // ProductsService now emits product.updated on every catalog write;
        // without this provider Nest cannot resolve the service at compile().
        { provide: RouteFlowGateway, useValue: { emitProductUpdated: jest.fn() } },
      ],
    }).compile();

    service = module.get<ProductsService>(ProductsService);
    addonService = module.get(AddonService);
    systemConfig = module.get(SystemConfigService);
  });

  const MSG = "Product name can't start with =, +, -, @ or a tab/line break";
  const refused = async (p: Promise<unknown>, field: string) => {
    const err: any = await p.catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toMatchObject({ code: "TEXT_CELL_FORMULA_LEAD", field });
    return err;
  };

  describe("create", () => {
    it.each([
      ["name", "productName"],
      ["variantName", "variantName"],
    ])("refuses a formula-led %s before any read or write", async (key, field) => {
      await refused(
        service.create({
          name: "Cola",
          unit: "each",
          pricePerUnit: "1.00",
          [key]: "=HYPERLINK(1)",
        } as any),
        field,
      );
      expect(prisma.product.findFirst).not.toHaveBeenCalled();
      expect(prisma.tenantTransaction).not.toHaveBeenCalled();
      expect(prisma.product.create).not.toHaveBeenCalled();
    });
  });

  describe("free-text Product.category (B990)", () => {
    const CAT_MSG = "Category can't start with =, +, -, @ or a tab/line break";

    it("create refuses a formula-led category before any read or write", async () => {
      const err = await refused(
        service.create({
          name: "Cola",
          unit: "each",
          pricePerUnit: "1.00",
          category: "=cmd",
        } as any),
        "category",
      );
      expect(err.getResponse().message).toBe(CAT_MSG);
      expect(prisma.product.findFirst).not.toHaveBeenCalled();
      expect(prisma.tenantTransaction).not.toHaveBeenCalled();
    });

    it("create refuses a formula-led typed category EVEN when a structured subcategory is chosen, or the parent has none (the written value can still be the typed one)", async () => {
      for (const extra of [{ trackedSubcategoryId: "sub-1" }, { parentProductId: "parent-1" }]) {
        prisma.tenantTransaction.mockClear();
        await refused(
          service.create({
            name: "Cola",
            unit: "each",
            pricePerUnit: "1.00",
            category: "=cmd",
            ...extra,
          } as any),
          "category",
        );
        expect(prisma.tenantTransaction).not.toHaveBeenCalled();
      }
    });

    const stored = (over: Record<string, unknown> = {}) => ({
      id: "prod-1",
      name: "Cola",
      variantName: null,
      category: "Drinks",
      trackedSubcategoryId: null,
      trackedSubcategory: null,
      parentProductId: null,
      imageKeys: [],
      ...over,
    });

    it("update refuses a CHANGED formula-led category and writes nothing", async () => {
      prisma.product.findUnique.mockResolvedValue(stored());
      await refused(
        service.update("prod-1", { category: "@evil" } as any, { packPrecondition: "internal" }),
        "category",
      );
      expect(prisma.product.update).not.toHaveBeenCalled();
    });

    it("update lets a LEGACY formula-led category echoed back unchanged through", async () => {
      prisma.product.findUnique.mockResolvedValue(stored({ category: "=LEGACY" }));
      prisma.product.findFirst.mockResolvedValue(null);
      prisma.product.update.mockResolvedValue(stored({ category: "=LEGACY" }));
      await expect(
        service.update("prod-1", { category: "=LEGACY", description: "x" } as any, {
          packPrecondition: "internal",
        }),
      ).resolves.toBeDefined();
    });

    it("update refuses a changed formula-led category BEFORE any Tobacco section is resolved or created (no orphan type)", async () => {
      addonService.hasAddon.mockResolvedValue(true); // the tobacco add-on is granted: the flag path would otherwise create the type
      prisma.product.findUnique.mockResolvedValue(stored());
      const created = jest.spyOn(service as any, "resolveOrCreateTobaccoCategory");
      await refused(
        service.update("prod-1", { category: "=evil", isTobacco: true } as any, {
          packPrecondition: "internal",
        }),
        "category",
      );
      expect(created).not.toHaveBeenCalled();
      expect(prisma.trackedCategory.create).not.toHaveBeenCalled();
      expect(prisma.product.update).not.toHaveBeenCalled();
    });
  });

  describe("update", () => {
    const stored = (over: Record<string, unknown> = {}) => ({
      id: "prod-1",
      name: "Cola",
      variantName: null,
      parentProductId: null,
      imageKeys: [],
      ...over,
    });

    it("refuses a CHANGED formula-led name and writes nothing", async () => {
      prisma.product.findUnique.mockResolvedValue(stored());
      await refused(
        service.update("prod-1", { name: "@evil" } as any, { packPrecondition: "internal" }),
        "productName",
      );
      expect(prisma.product.update).not.toHaveBeenCalled();
    });

    it("refuses a CHANGED formula-led variantName", async () => {
      prisma.product.findUnique.mockResolvedValue(stored({ variantName: "Cherry" }));
      await refused(
        service.update("prod-1", { variantName: "-2+3" } as any, { packPrecondition: "internal" }),
        "variantName",
      );
      expect(prisma.product.update).not.toHaveBeenCalled();
    });

    it("a LEGACY formula-led name echoed back unchanged does not block an unrelated edit, with no extra read", async () => {
      prisma.product.findUnique.mockResolvedValue(stored({ name: "=LEGACY" }));
      prisma.product.findFirst.mockResolvedValue(null);
      prisma.product.update.mockResolvedValue(stored({ name: "=LEGACY" }));
      await expect(
        service.update("prod-1", { name: "=LEGACY", description: "x" } as any, {
          packPrecondition: "internal",
        }),
      ).resolves.toBeDefined();
      expect(prisma.product.findUnique).toHaveBeenCalledTimes(1); // the ONE read update() already makes
    });
  });

  describe("bulkAssignParent", () => {
    it("rejects the WHOLE request with a CODED 400 naming the row when one variantName is formula-led: 0 writes", async () => {
      prisma.product.findFirst.mockResolvedValue({
        id: "parent-1",
        isActive: true,
        kind: "FAMILY",
        parentProductId: null,
      });
      const update = jest.spyOn(service, "update").mockResolvedValue({} as any);
      const err = await refused(
        service.bulkAssignParent({
          parentProductId: "parent-1",
          assignments: [
            { id: "prod-a", variantName: "Strawberry" },
            { id: "prod-b", variantName: "=HYPERLINK(1)" },
            { id: "prod-c", variantName: "Apple" },
          ],
        } as any),
        "variantName",
      );
      expect(err.getResponse()).toMatchObject({ index: 1, productId: "prod-b" });
      expect(String(err.getResponse().message)).toBe(
        "Variant name can't start with =, +, -, @ or a tab/line break",
      );
      expect(update).not.toHaveBeenCalled();
    });
  });

  describe("importFromZoho", () => {
    it("rejects ONLY the formula-led row (readable reason) and still imports the good row", async () => {
      prisma.product.findFirst.mockResolvedValue(null);
      prisma.product.create.mockResolvedValue({ id: "new-1" });
      const result = await service.importFromZoho({
        items: [
          { name: "=HYPERLINK(1)", unit: "each", pricePerUnit: 5 },
          { name: "Widget", unit: "each", pricePerUnit: 5 },
        ],
      } as any);
      expect(result.created).toBe(1);
      expect(result.errors).toEqual([{ row: 1, name: "=HYPERLINK(1)", reason: MSG }]);
      expect(prisma.product.create).toHaveBeenCalledTimes(1);
    });

    it("rejects ONLY the row whose category is formula-led (readable reason); the rest imports", async () => {
      prisma.product.findFirst.mockResolvedValue(null);
      prisma.product.create.mockResolvedValue({ id: "new-1" });
      const result = await service.importFromZoho({
        items: [
          { name: "Widget", category: "=HYPERLINK(1)", unit: "each", pricePerUnit: 5 },
          { name: "Gadget", category: "Tools", unit: "each", pricePerUnit: 5 },
        ],
      } as any);
      expect(result.created).toBe(1);
      expect(result.errors).toEqual([
        {
          row: 1,
          name: "Widget",
          reason: "Category can't start with =, +, -, @ or a tab/line break",
        },
      ]);
    });

    it("change-only: a formula-led name that ALREADY matches a stored product is a plain skip (nothing would be written), not an error", async () => {
      prisma.product.findFirst.mockResolvedValue({ id: "existing" }); // the name-taken lookup
      const result = await service.importFromZoho({
        items: [{ name: "=LEGACY", unit: "each", pricePerUnit: 5 }],
      } as any);
      expect(result.skipped).toBe(1);
      expect(result.errors).toEqual([]);
      expect(prisma.product.create).not.toHaveBeenCalled();
    });
  });
});
