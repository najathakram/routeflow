import { Test } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { BuyerCatalogService } from "./buyer-catalog.service";
import { RegulatedVisibilityService } from "./regulated-visibility.service";
import { PrismaService } from "../prisma/prisma.service";
import { ProductsService } from "../products/products.service";
import { StorageService } from "../storage/storage.service";
import { createMockPrisma } from "../testing/prisma-mock";

describe("BuyerCatalogService — W7 visibility gate", () => {
  let service: BuyerCatalogService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let products: { findAll: jest.Mock; findOne: jest.Mock };

  const future = new Date(Date.now() + 365 * 864e5);
  const past = new Date(Date.now() - 864e5);

  beforeEach(async () => {
    prisma = createMockPrisma();
    products = {
      findAll: jest.fn().mockResolvedValue({ data: [], meta: { total: 0 } }),
      findOne: jest.fn(),
    };
    const mod = await Test.createTestingModule({
      providers: [
        BuyerCatalogService,
        RegulatedVisibilityService,
        { provide: PrismaService, useValue: prisma },
        { provide: ProductsService, useValue: products },
        { provide: StorageService, useValue: { presignedUrl: jest.fn() } },
      ],
    }).compile();
    service = mod.get(BuyerCatalogService);
    prisma.customer.findUnique.mockResolvedValue({ pricingTier: 1 });
  });

  const gated = (rows: Array<{ id: string; name: string }>) =>
    prisma.trackedCategory.findMany.mockResolvedValue(rows);
  const auths = (rows: unknown[]) => prisma.customerAuthorization.findMany.mockResolvedValue(rows);

  it("hides an unlicensed requiresLicense category (excludes it from the query + lists it locked)", async () => {
    gated([{ id: "cat-alc", name: "Alcohol" }]);
    auths([]); // buyer has no authorization
    const res = (await service.getCatalog({}, "c1")) as any;
    expect(products.findAll).toHaveBeenCalledWith(expect.anything(), {
      excludeTrackedCategoryIds: ["cat-alc"],
    });
    expect(res.hiddenCategories).toEqual([{ id: "cat-alc", name: "Alcohol", status: "NONE" }]);
  });

  it("shows a category the buyer is VERIFIED (non-expired) for — no exclusion", async () => {
    gated([{ id: "cat-alc", name: "Alcohol" }]);
    auths([{ trackedCategoryId: "cat-alc", status: "VERIFIED", expiresAt: future }]);
    const res = (await service.getCatalog({}, "c1")) as any;
    expect(products.findAll).toHaveBeenCalledWith(expect.anything(), undefined);
    expect(res.hiddenCategories).toEqual([]);
  });

  it("re-locks an EXPIRED authorization (VERIFIED but past expiresAt)", async () => {
    gated([{ id: "cat-alc", name: "Alcohol" }]);
    auths([{ trackedCategoryId: "cat-alc", status: "VERIFIED", expiresAt: past }]);
    const res = (await service.getCatalog({}, "c1")) as any;
    expect(res.hiddenCategories).toEqual([{ id: "cat-alc", name: "Alcohol", status: "EXPIRED" }]);
  });

  it("reports a PENDING_REVIEW authorization as a locked category (awaiting review)", async () => {
    gated([{ id: "cat-alc", name: "Alcohol" }]);
    auths([{ trackedCategoryId: "cat-alc", status: "PENDING_REVIEW", expiresAt: null }]);
    const res = (await service.getCatalog({}, "c1")) as any;
    expect(res.hiddenCategories).toEqual([
      { id: "cat-alc", name: "Alcohol", status: "PENDING_REVIEW" },
    ]);
  });

  it("never gates when the tenant has no requiresLicense categories (fast path, zero auth query)", async () => {
    gated([]); // no regulated program
    const res = (await service.getCatalog({}, "c1")) as any;
    expect(prisma.customerAuthorization.findMany).not.toHaveBeenCalled();
    expect(products.findAll).toHaveBeenCalledWith(expect.anything(), undefined);
    expect(res.hiddenCategories).toEqual([]);
  });

  it("getProductDetail 404s a product in a locked category", async () => {
    gated([{ id: "cat-alc", name: "Alcohol" }]);
    auths([]);
    products.findOne.mockResolvedValue({ id: "p1", isActive: true, trackedCategoryId: "cat-alc" });
    await expect(service.getProductDetail("p1", "c1")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("getFavorites filters out products in a locked category", async () => {
    gated([{ id: "cat-alc", name: "Alcohol" }]);
    auths([]);
    prisma.buyerFavorite.findMany.mockResolvedValue([
      { id: "f1", productId: "p1", product: { isActive: true, trackedCategoryId: "cat-alc" } },
      {
        id: "f2",
        productId: "p2",
        product: { isActive: true, trackedCategoryId: null, imageKeys: [] },
      },
    ]);
    prisma.customerPrice.findMany.mockResolvedValue([]);
    const res = await service.getFavorites("ba1", "c1");
    expect(res.map((f) => f.id)).toEqual(["f2"]); // the regulated favorite is hidden
  });

  it("batches the gate into at most two queries (no N+1)", async () => {
    gated([{ id: "cat-alc", name: "Alcohol" }]);
    auths([]);
    await service.getCatalog({}, "c1");
    expect(prisma.trackedCategory.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.customerAuthorization.findMany).toHaveBeenCalledTimes(1);
  });
});
