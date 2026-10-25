import { Test, TestingModule } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
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

const PRODUCT = {
  id: "prod-1",
  name: "Cherry Tomatoes",
  sku: "TOM-001",
  unit: "punnet",
  pricePerUnit: 4.99,
  category: "Produce",
  isActive: true,
  imageKeys: [] as string[],
  trackedCategoryId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

/** What a tenant-scoped read does: only this tenant's own rows come back for an id list. */
const ownRows = (owned: string[]) => async (args: { where: { id: { in: string[] } } }) =>
  args.where.id.in.filter((id) => owned.includes(id)).map((id) => ({ id }));

// 681 (R5-5) site 16: Product.trackedCategoryId is a bare column. A client-sent id must resolve in the caller's
// tenant BEFORE the write transaction; a server-derived id (the Tobacco type) is already the tenant's own.
describe("ProductsService — tracked category ref (681 site 16)", () => {
  let service: ProductsService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    prisma.trackedCategory.findMany.mockImplementation(ownRows(["cat-a"]));
    prisma.trackedCategory.findFirst.mockResolvedValue({ id: "cat-a", name: "Produce" });
    prisma.product.findFirst.mockResolvedValue(null);
    prisma.product.findUnique.mockResolvedValue(PRODUCT);
    prisma.product.create.mockResolvedValue(PRODUCT);
    prisma.product.update.mockResolvedValue(PRODUCT);
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
        { provide: AddonService, useValue: { hasAddon: jest.fn().mockResolvedValue(true) } },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        { provide: EntitlementAuthority, useValue: { can: jest.fn().mockResolvedValue(false) } },
        { provide: FeatureOverrideService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        {
          provide: PlanCatalogService,
          useValue: { upgradeTargetForFlag: jest.fn().mockResolvedValue(null) },
        },
        { provide: RouteFlowGateway, useValue: { emitProductUpdated: jest.fn() } },
      ],
    }).compile();
    service = module.get(ProductsService);
  });

  const newProduct = (trackedCategoryId?: string | null) =>
    ({
      name: "Cherry Tomatoes",
      sku: "TOM-001",
      unit: "punnet",
      pricePerUnit: 4.99,
      category: "Produce",
      ...(trackedCategoryId === undefined ? {} : { trackedCategoryId }),
    }) as any;

  describe("create", () => {
    it("another tenant's tracked category is a 404 and no product or transaction is written", async () => {
      const err = await service.create(newProduct("cat-b")).catch((e) => e);
      expect(prisma.product.create).not.toHaveBeenCalled();
      expect(prisma.tenantTransaction).not.toHaveBeenCalled();
      expect(err).toBeInstanceOf(NotFoundException);
      expect(err.message).toBe("Tracked category not found");
    });

    it("control: this tenant's tracked category creates the product", async () => {
      await service.create(newProduct("cat-a"));
      expect(prisma.product.create).toHaveBeenCalledTimes(1);
    });

    it("no category sent proves nothing", async () => {
      await service.create(newProduct());
      expect(prisma.trackedCategory.findMany).not.toHaveBeenCalled();
      expect(prisma.product.create).toHaveBeenCalledTimes(1);
    });
  });

  describe("update", () => {
    it("another tenant's tracked category is a 404 and nothing is written", async () => {
      const err = await service
        .update("prod-1", { trackedCategoryId: "cat-b" } as any, { packPrecondition: "internal" })
        .catch((e) => e);
      expect(prisma.product.update).not.toHaveBeenCalled();
      expect(prisma.tenantTransaction).not.toHaveBeenCalled();
      expect(err).toBeInstanceOf(NotFoundException);
      expect(err.message).toBe("Tracked category not found");
    });

    it("control: this tenant's tracked category updates the product", async () => {
      await service.update("prod-1", { trackedCategoryId: "cat-a" } as any, {
        packPrecondition: "internal",
      });
      expect(prisma.product.update).toHaveBeenCalledTimes(1);
    });

    it("clearing the category (null) proves nothing", async () => {
      await service.update("prod-1", { trackedCategoryId: null } as any, {
        packPrecondition: "internal",
      });
      expect(prisma.trackedCategory.findMany).not.toHaveBeenCalled();
    });
  });
});
