import { Test } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { BuyerCatalogService } from "./buyer-catalog.service";
import { RegulatedVisibilityService } from "./regulated-visibility.service";
import { ReplenishmentService } from "./replenishment.service";
import { PrismaService } from "../prisma/prisma.service";
import { ProductsService } from "../products/products.service";
import { StorageService } from "../storage/storage.service";
import { OrdersService } from "../orders/orders.service";
import { PromotionsService } from "../promotions/promotions.service";
import { createMockPrisma } from "../testing/prisma-mock";

describe("BuyerCatalogService — W7 visibility gate", () => {
  let service: BuyerCatalogService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let products: { findAll: jest.Mock; findOne: jest.Mock };
  let ordersService: { getCustomerPriceHistory: jest.Mock };
  let storage: { presignedUrl: jest.Mock; presignedUrls: jest.Mock };
  let replenishment: { estimates: jest.Mock };
  let promotions: { activeForCatalog: jest.Mock };

  const future = new Date(Date.now() + 365 * 864e5);
  const past = new Date(Date.now() - 864e5);

  beforeEach(async () => {
    prisma = createMockPrisma();
    products = {
      findAll: jest.fn().mockResolvedValue({ data: [], meta: { total: 0 } }),
      findOne: jest.fn(),
    };
    ordersService = { getCustomerPriceHistory: jest.fn().mockResolvedValue({}) };
    storage = { presignedUrl: jest.fn(), presignedUrls: jest.fn().mockResolvedValue([]) };
    replenishment = { estimates: jest.fn().mockResolvedValue([]) };
    promotions = { activeForCatalog: jest.fn().mockResolvedValue([]) };
    const mod = await Test.createTestingModule({
      providers: [
        BuyerCatalogService,
        RegulatedVisibilityService,
        { provide: PrismaService, useValue: prisma },
        { provide: ProductsService, useValue: products },
        { provide: StorageService, useValue: storage },
        { provide: OrdersService, useValue: ordersService },
        { provide: ReplenishmentService, useValue: replenishment },
        { provide: PromotionsService, useValue: promotions },
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

  // Sticky upsell in the catalog (the "hide the base in the catalog" requirement).
  describe("sticky upsell pricing", () => {
    const oneProduct = () =>
      products.findAll.mockResolvedValue({
        data: [{ id: "p1", name: "Widget", unit: "ea", pricePerUnit: 10, currentStock: 5 }],
        meta: { total: 1 },
      });

    it("makes a remembered UPSELL the effective catalog price (hides the lower base)", async () => {
      gated([]);
      oneProduct();
      prisma.customerPrice.findMany.mockResolvedValue([]);
      ordersService.getCustomerPriceHistory.mockResolvedValue({
        p1: { lastPrice: 12, listPriceAtTime: 10 }, // upsold to 12 above list 10
      });
      const res = (await service.getCatalog({}, "c1")) as any;
      expect(res.data[0].buyerPrice).toBe(12); // sticky upsell, never the list 10
    });

    it("does NOT stick a remembered discount below list (keeps the tier price)", async () => {
      gated([]);
      oneProduct();
      prisma.customerPrice.findMany.mockResolvedValue([]);
      ordersService.getCustomerPriceHistory.mockResolvedValue({
        p1: { lastPrice: 8, listPriceAtTime: 10 }, // a one-time discount
      });
      const res = (await service.getCatalog({}, "c1")) as any;
      expect(res.data[0].buyerPrice).toBe(10); // tier-1 list; a discount never sticks
    });
  });

  // P5-02: catalogue v2 — new fields, smart collections, best-for-you sort, rail counts.
  describe("catalogue v2 (P5-02)", () => {
    const threeProducts = () =>
      products.findAll.mockResolvedValue({
        data: [
          {
            id: "p1",
            name: "A",
            unit: "ea",
            pricePerUnit: 10,
            currentStock: 3.5,
            lowStockThreshold: 5,
            imageKeys: ["a-fp50x50.jpg", "b.jpg", "c.jpg", "d.jpg", "e.jpg"],
            isNew: true,
            isDeal: true,
          },
          { id: "p2", name: "B", unit: "ea", pricePerUnit: 10, currentStock: 0 },
          { id: "p3", name: "C", unit: "ea", pricePerUnit: 10, currentStock: 50 },
        ],
        meta: { total: 3, page: 1, limit: 20, totalPages: 1 },
      });

    it("exposes isNew/isDeal/imageUrls (capped at 4) and stock-aware stockLeft", async () => {
      gated([]);
      threeProducts();
      storage.presignedUrls.mockImplementation((keys: string[]) =>
        Promise.resolve(keys.map((k) => "https://signed/" + k)),
      );

      const res = (await service.getCatalog({}, "c1")) as any;
      const [p1, p2, p3] = res.data;

      expect(p1.isNew).toBe(true);
      expect(p1.isDeal).toBe(true);
      expect(p1.imageUrls).toEqual([
        "https://signed/a-fp50x50.jpg",
        "https://signed/b.jpg",
        "https://signed/c.jpg",
        "https://signed/d.jpg",
      ]);
      expect(p1.imageUrls.length).toBe(4); // 5th key never presigned
      expect(p1.stockStatus).toBe("LOW");
      expect(p1.stockLeft).toBe(3); // floor(3.5), never 0 while LOW

      expect(p2.stockStatus).toBe("OUT_OF_STOCK");
      expect(p2.stockLeft).toBeNull();

      expect(p3.stockStatus).toBe("IN_STOCK");
      expect(p3.stockLeft).toBeNull();
    });

    it("collection=new filters via andWhere [{ isNew: true }]", async () => {
      gated([]);
      await service.getCatalog({ collection: "new" }, "c1");
      expect(products.findAll).toHaveBeenCalledWith(expect.anything(), {
        andWhere: [{ isNew: true }],
      });
    });

    it("collection=deals composes the shared dealsWhere from active promotions (PRODUCTS + CATEGORY scope)", async () => {
      gated([]);
      // Ordered CATEGORY-then-PRODUCTS so the resulting OR clause matches
      // dealsWhere's iteration order exactly.
      promotions.activeForCatalog.mockResolvedValue([
        { scope: "CATEGORY", category: "Beverages", productIds: [] },
        { scope: "PRODUCTS", category: null, productIds: ["p1"] },
      ]);
      await service.getCatalog({ collection: "deals" }, "c1");
      expect(products.findAll).toHaveBeenCalledWith(expect.anything(), {
        andWhere: [{ OR: [{ isDeal: true }, { category: "Beverages" }, { id: { in: ["p1"] } }] }],
      });
    });

    it("collection=deals matches the entire catalog ({}) when an ALL-scope promo is active", async () => {
      gated([]);
      promotions.activeForCatalog.mockResolvedValue([
        { scope: "ALL", category: null, productIds: [] },
      ]);
      await service.getCatalog({ collection: "deals" }, "c1");
      expect(products.findAll).toHaveBeenCalledWith(expect.anything(), { andWhere: [{}] });
    });

    it("collection=usuals filters to ids with replenishment orderCount >= 2", async () => {
      gated([]);
      replenishment.estimates.mockResolvedValue([
        { productId: "p1", orderCount: 3 },
        { productId: "p2", orderCount: 1 },
        { productId: "p3", orderCount: 2 },
      ]);
      await service.getCatalog({ collection: "usuals" }, "c1");
      expect(products.findAll).toHaveBeenCalledWith(expect.anything(), {
        andWhere: [{ id: { in: ["p1", "p3"] } }],
      });
    });

    it("collection=favorites filters to the buyer's favorited product ids", async () => {
      gated([]);
      prisma.buyerFavorite.findMany.mockResolvedValue([{ productId: "p9" }, { productId: "p2" }]);
      await service.getCatalog({ collection: "favorites" }, "c1", "ba1");
      expect(prisma.buyerFavorite.findMany).toHaveBeenCalledWith({
        where: { buyerAccountId: "ba1", customerId: "c1" },
        select: { productId: true },
      });
      expect(products.findAll).toHaveBeenCalledWith(expect.anything(), {
        andWhere: [{ id: { in: ["p9", "p2"] } }],
      });
    });

    it("collection=favorites is skipped when buyerAccountId is omitted", async () => {
      gated([]);
      await service.getCatalog({ collection: "favorites" }, "c1");
      expect(prisma.buyerFavorite.findMany).not.toHaveBeenCalled();
      expect(products.findAll).toHaveBeenCalledWith(expect.anything(), undefined);
    });

    it("sort=best orders by replenishment orderCount desc, then estDaysLeft asc, no-history last; fetches all + paginates manually", async () => {
      gated([]);
      products.findAll.mockResolvedValue({
        data: [
          { id: "p1", name: "Alpha", unit: "ea", pricePerUnit: 10, currentStock: 20 },
          { id: "p2", name: "Bravo", unit: "ea", pricePerUnit: 10, currentStock: 20 },
          { id: "p3", name: "Charlie", unit: "ea", pricePerUnit: 10, currentStock: 20 },
        ],
        meta: { total: 3, page: 1, limit: 0, totalPages: 1 },
      });
      replenishment.estimates.mockResolvedValue([
        { productId: "p2", orderCount: 5, estDaysLeft: 2 },
        { productId: "p1", orderCount: 2, estDaysLeft: 1 },
      ]);

      const res = (await service.getCatalog({ sort: "best" }, "c1")) as any;

      expect(products.findAll).toHaveBeenCalledWith(
        { search: undefined, category: undefined, isActive: true, page: 1, limit: 0 },
        undefined,
      );
      expect(res.data.map((p: any) => p.id)).toEqual(["p2", "p1", "p3"]);
      expect(res.meta).toEqual({ total: 3, page: 1, limit: 20, totalPages: 1 });
    });

    describe("getCatalogCounts", () => {
      it("gate-filters every count/groupBy, name-sorts categories, and wires collection counts", async () => {
        gated([{ id: "cat-x", name: "Tobacco" }]);
        auths([]); // no authorization -> locked, status NONE

        const productGroupBy = prisma.product.groupBy as unknown as jest.Mock;
        const productCount = prisma.product.count as unknown as jest.Mock;

        productGroupBy.mockResolvedValue([
          { category: "Bravo", _count: { _all: 3 } },
          { category: "Alpha", _count: { _all: 5 } },
          { category: null, _count: { _all: 2 } }, // uncategorized — excluded from categories
        ]);
        replenishment.estimates.mockResolvedValue([
          { productId: "p1", orderCount: 3 }, // >= 2 -> counted as a usual
          { productId: "p2", orderCount: 1 }, // below threshold — excluded
        ]);
        prisma.buyerFavorite.findMany.mockResolvedValue([{ productId: "p9" }]);

        productCount.mockImplementation(async ({ where }: any) => {
          if (where.isNew === true) return 4; // newCount
          if (where.id?.in) return where.id.in.includes("p1") ? 2 : 1; // usuals : favorites
          if (where.AND) return 3; // deals
          return 9; // total (baseWhere only)
        });

        const res = await service.getCatalogCounts("c1", "ba1");

        // Every count/groupBy where carries the regulated-gate exclusion — in
        // its NULL-SAFE form. This assertion previously pinned the bare
        // `{ notIn: [...] }` shape, which Prisma evaluates as excluding NULL
        // rows too: with one license-gated category, every UNTRACKED product
        // dropped out of all rail counts (and the catalog itself). The gate
        // must always be (trackedCategoryId IS NULL OR notIn hidden).
        const NULL_SAFE_GATE = [
          { trackedCategoryId: null },
          { trackedCategoryId: { notIn: ["cat-x"] } },
        ];
        for (const call of productCount.mock.calls as any[]) {
          const where = call[0].where;
          const gate = where.OR ?? where.AND?.[0]?.OR;
          expect(gate).toEqual(NULL_SAFE_GATE);
          expect(where.trackedCategoryId).toBeUndefined();
        }
        const groupByWhere = (productGroupBy.mock.calls[0] as any[])[0].where;
        expect(groupByWhere.OR).toEqual(NULL_SAFE_GATE);
        expect(groupByWhere.trackedCategoryId).toBeUndefined();

        expect(res.lockedCategories).toEqual([{ id: "cat-x", name: "Tobacco", status: "NONE" }]);
        expect(res.categories).toEqual([
          { name: "Alpha", count: 5 },
          { name: "Bravo", count: 3 },
        ]);
        expect(res.collections).toEqual({ usuals: 2, favorites: 1, new: 4, deals: 3 });
        expect(res.total).toBe(9);
      });
    });
  });
});
