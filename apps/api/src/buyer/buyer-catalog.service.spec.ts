import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { noRestrictionsProvider } from "../selling-restrictions/testing/no-restrictions-provider";
import { Test } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { BuyerCatalogService } from "./buyer-catalog.service";
import { RegulatedVisibilityService } from "./regulated-visibility.service";
import { ReplenishmentService } from "./replenishment.service";
import { PrismaService } from "../prisma/prisma.service";
import { ProductsService } from "../products/products.service";
import { StorageService } from "../storage/storage.service";
import { OrdersService } from "../orders/orders.service";
import {
  BuyerBackorderViewResolver,
  NO_BACKORDER_VIEW,
  type BuyerBackorderView,
} from "../orders/buyer-backorder-view";
import { PromotionsService } from "../promotions/promotions.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { buyerVisibleProductWhere, noBuyerRestrictions } from "./buyer-product-visibility";

// The one shared buyer-visibility clause getCatalog always appends to findAll's andWhere.
// The mock prisma's tenant ("test-tenant") scopes the parent filters (B1211).
const VIS = buyerVisibleProductWhere(noBuyerRestrictions("test-tenant"));

describe("BuyerCatalogService — W7 visibility gate", () => {
  let service: BuyerCatalogService;
  let restrictions: { restrictedProductIdsFor: jest.Mock };
  let backorderResolve: jest.Mock;
  const viewIs = (v: BuyerBackorderView) => backorderResolve.mockResolvedValue(v);
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
    backorderResolve = jest.fn().mockResolvedValue(NO_BACKORDER_VIEW);
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
        { provide: BuyerBackorderViewResolver, useValue: { resolve: backorderResolve } },
        noRestrictionsProvider,
      ],
    }).compile();
    service = mod.get(BuyerCatalogService);
    restrictions = mod.get(SellingRestrictionsService) as unknown as typeof restrictions;
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
      andWhere: [VIS],
    });
    expect(res.hiddenCategories).toEqual([{ id: "cat-alc", name: "Alcohol", status: "NONE" }]);
  });

  it("shows a category the buyer is VERIFIED (non-expired) for — no exclusion", async () => {
    gated([{ id: "cat-alc", name: "Alcohol" }]);
    auths([{ trackedCategoryId: "cat-alc", status: "VERIFIED", expiresAt: future }]);
    const res = (await service.getCatalog({}, "c1")) as any;
    expect(products.findAll).toHaveBeenCalledWith(expect.anything(), { andWhere: [VIS] });
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
    expect(products.findAll).toHaveBeenCalledWith(expect.anything(), { andWhere: [VIS] });
    expect(res.hiddenCategories).toEqual([]);
  });

  it("getProductDetail 404s a product in a locked category", async () => {
    gated([{ id: "cat-alc", name: "Alcohol" }]);
    auths([]);
    products.findOne.mockResolvedValue({ id: "p1", isActive: true, trackedCategoryId: "cat-alc" });
    await expect(service.getProductDetail("p1", "c1")).rejects.toBeInstanceOf(NotFoundException);
  });

  // The detail payload must carry every field the listing does, or the buyer
  // detail page silently degrades: a boxed Add drops to 1 loose piece and an
  // out-of-stock product reads "In stock" with an enabled Add button.
  it("getProductDetail returns the listing's box/stock/merch fields (tile↔detail parity)", async () => {
    gated([]);
    prisma.customerPrice.findMany.mockResolvedValue([]);
    products.findOne.mockResolvedValue({
      id: "p1",
      tenantId: "test-tenant",
      kind: "STANDARD",
      portalVisible: true,
      parent: null,
      name: "Widget",
      unit: "ea",
      category: "Snacks",
      pricePerUnit: 10,
      unitsPerBox: 24,
      isDeal: true,
      currentStock: 0,
      lowStockThreshold: 5,
      isActive: true,
      trackedCategoryId: null,
      imageKeys: ["a.jpg", "b.jpg"],
      imageUrls: ["https://signed/a.jpg", "https://signed/b.jpg"],
      variants: [
        {
          id: "v1",
          isActive: true,
          kind: "STANDARD",
          portalVisible: true,
          variantName: "Large",
          sku: "V1",
          unit: "ea",
          pricePerUnit: 12,
          category: "Snacks",
          unitsPerBox: 6,
        },
      ],
    });

    const res = (await service.getProductDetail("p1", "c1")) as any;

    expect(res.unitsPerBox).toBe(24); // boxed Add puts 1 box in the cart, not 1 piece
    expect(res.stockStatus).toBe("OUT_OF_STOCK"); // Notify-me reachable
    expect(res.inStock).toBe(false);
    expect(res.stockLeft).toBeNull();
    expect(res.isDeal).toBe(true);
    expect(res.thumbnailUrl).toBe("https://signed/a.jpg");
    // Variant rows carry the promo inputs deriveTilePrice needs
    expect(res.variants[0]).toMatchObject({ category: "Snacks", unitsPerBox: 6 });
  });

  describe("OOS PR2: the detail uses the SAME view as the listing (tile <-> detail parity)", () => {
    const oosProduct = () => ({
      id: "p1",
      tenantId: "test-tenant",
      kind: "STANDARD",
      portalVisible: true,
      parent: null,
      name: "Widget",
      unit: "ea",
      category: "Snacks",
      pricePerUnit: 10,
      unitsPerBox: null,
      currentStock: 0,
      lowStockThreshold: 5,
      isActive: true,
      trackedCategoryId: null,
      imageKeys: [],
      imageUrls: [],
      variants: [],
    });

    it.each([
      [{ canBackorder: true, visibility: "hide" as const }, true, "IN_STOCK", true],
      [{ canBackorder: true, visibility: "show" as const }, false, "OUT_OF_STOCK", true],
      [{ canBackorder: false, visibility: "hide" as const }, false, "OUT_OF_STOCK", false],
    ])(
      "view %j: inStock=%s status=%s canBackorder=%s, resolved once",
      async (view, inStock, status, can) => {
        gated([]);
        prisma.customerPrice.findMany.mockResolvedValue([]);
        products.findOne.mockResolvedValue(oosProduct());
        viewIs(view);
        const res = (await service.getProductDetail("p1", "c1")) as any;
        expect([res.inStock, res.stockStatus, res.stockLeft, res.canBackorder]).toEqual([
          inStock,
          status,
          null,
          can,
        ]);
        expect(backorderResolve).toHaveBeenCalledTimes(1);
      },
    );
  });

  // A variant with its own CustomerPrice row must price off ITS tier, not the
  // parent's — otherwise the parent's Variants list and the variant's own
  // tile/detail page quote two different prices for the same product.
  it("getProductDetail prices each variant off its own tier override", async () => {
    gated([]);
    prisma.customer.findUnique.mockResolvedValue({ pricingTier: 1 });
    prisma.customerPrice.findMany.mockResolvedValue([{ productId: "v1", pricingTier: 3 }]);
    products.findOne.mockResolvedValue({
      id: "p1",
      tenantId: "test-tenant",
      kind: "STANDARD",
      portalVisible: true,
      parent: null,
      name: "Widget",
      unit: "ea",
      pricePerUnit: 20,
      priceTier3: 15,
      isActive: true,
      trackedCategoryId: null,
      variants: [
        {
          id: "v1",
          isActive: true,
          kind: "STANDARD",
          portalVisible: true,
          variantName: "Large",
          sku: "V1",
          unit: "ea",
          pricePerUnit: 10,
          priceTier3: 8,
        },
      ],
    });

    const res = (await service.getProductDetail("p1", "c1")) as any;

    expect(res.buyerPrice).toBe(20); // parent has no override — customer default tier 1
    expect(res.variants[0].buyerPrice).toBe(8); // variant's own tier-3 override
  });

  // A discontinued variant must not be listed with a price: its row links to a
  // detail page that 404s on isActive, so the buyer is quoted a dead end.
  it("getProductDetail omits deactivated variants", async () => {
    gated([]);
    prisma.customer.findUnique.mockResolvedValue({ pricingTier: 1 });
    prisma.customerPrice.findMany.mockResolvedValue([]);
    products.findOne.mockResolvedValue({
      id: "p1",
      tenantId: "test-tenant",
      kind: "STANDARD",
      portalVisible: true,
      parent: null,
      name: "Widget",
      unit: "ea",
      pricePerUnit: 20,
      isActive: true,
      trackedCategoryId: null,
      variants: [
        {
          id: "v1",
          kind: "STANDARD",
          portalVisible: true,
          variantName: "Large",
          unit: "ea",
          pricePerUnit: 10,
          isActive: true,
        },
        {
          id: "v2",
          kind: "STANDARD",
          portalVisible: true,
          variantName: "Discontinued",
          unit: "ea",
          pricePerUnit: 10,
          isActive: false,
        },
      ],
    });

    const res = (await service.getProductDetail("p1", "c1")) as any;

    expect(res.variants.map((v: any) => v.id)).toEqual(["v1"]);
    // The tier-override lookup must not widen to the hidden variant either
    expect(prisma.customerPrice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ productId: { in: ["p1", "v1"] } }),
      }),
    );
  });

  const VISIBLE = {
    id: "p1",
    name: "Widget",
    isActive: true,
    kind: "STANDARD",
    portalVisible: true,
    parent: null,
  };

  it("getFavorites: a favourite the tenant HID is kept as a 'No longer available online' stub, with no price (SA-606 M3)", async () => {
    gated([]);
    auths([]);
    prisma.buyerFavorite.findMany.mockResolvedValue([
      {
        id: "f9",
        productId: "p9",
        createdAt: new Date(),
        product: { ...VISIBLE, id: "p9", name: "Hidden Fave", portalVisible: false },
      },
      {
        id: "f8",
        productId: "p8",
        createdAt: new Date(),
        product: {
          ...VISIBLE,
          id: "p8",
          name: "Under Hidden Parent",
          parent: { portalVisible: false },
        },
      },
    ]);
    prisma.customerPrice.findMany.mockResolvedValue([]);
    const res = (await service.getFavorites("ba1", "c1")) as any[];
    expect(res).toHaveLength(2);
    for (const r of res) {
      expect(r).toMatchObject({ unavailable: true, unavailableText: "No longer available online" });
      expect(r).not.toHaveProperty("buyerPrice");
    }
  });

  it("getFavorites: a favourite a selling restriction hides from this buyer is DROPPED, not stubbed; other hidden reasons keep the stub", async () => {
    gated([]);
    auths([]);
    restrictions.restrictedProductIdsFor.mockResolvedValueOnce(
      new Set(["p-limited", "p-limited-kid"]),
    );
    prisma.buyerFavorite.findMany.mockResolvedValue([
      {
        id: "f1",
        productId: "p-limited",
        createdAt: new Date(),
        product: { ...VISIBLE, id: "p-limited", name: "State Limited" },
      },
      {
        id: "f2",
        productId: "p-limited-kid",
        createdAt: new Date(),
        product: { ...VISIBLE, id: "p-limited-kid", name: "Limited Variant" },
      },
      {
        id: "f3",
        productId: "p-gone",
        createdAt: new Date(),
        product: { ...VISIBLE, id: "p-gone", name: "Curated Out", portalVisible: false },
      },
      {
        id: "f4",
        productId: "p-ok",
        createdAt: new Date(),
        product: { ...VISIBLE, id: "p-ok", name: "Fine", imageKeys: [] },
      },
    ]);
    prisma.customerPrice.findMany.mockResolvedValue([]);
    const res = (await service.getFavorites("ba1", "c1")) as any[];
    expect(res.map((r) => r.id).sort()).toEqual(["f3", "f4"]); // f1 and f2 are gone entirely
    expect(res.find((r) => r.id === "f3")).toMatchObject({
      unavailable: true,
      unavailableText: "No longer available online",
    });
  });

  it("getFavorites filters out products in a locked category", async () => {
    gated([{ id: "cat-alc", name: "Alcohol" }]);
    auths([]);
    prisma.buyerFavorite.findMany.mockResolvedValue([
      { id: "f1", productId: "p1", product: { ...VISIBLE, trackedCategoryId: "cat-alc" } },
      {
        id: "f2",
        productId: "p2",
        createdAt: new Date(),
        product: { ...VISIBLE, id: "p2", trackedCategoryId: null, imageKeys: [] },
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
            imageKeys: ["a-fp50x50.jpg", "b.jpg", "c.jpg", "d.jpg", "e.jpg"].map(
              (k) => `products/p1/${k}`,
            ),
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
        "https://signed/products/p1/a-fp50x50.jpg",
        "https://signed/products/p1/b.jpg",
        "https://signed/products/p1/c.jpg",
        "https://signed/products/p1/d.jpg",
      ]);
      expect(p1.imageUrls.length).toBe(4); // 5th key never presigned
      expect(p1.stockStatus).toBe("LOW");
      expect(p1.stockLeft).toBe(3); // floor(3.5), never 0 while LOW

      expect(p2.stockStatus).toBe("OUT_OF_STOCK");
      expect(p2.stockLeft).toBeNull();

      expect(p3.stockStatus).toBe("IN_STOCK");
      expect(p3.stockLeft).toBeNull();
    });

    describe("OOS PR2: canBackorder + the seller's backorder visibility (R2/R3)", () => {
      const stockOf = (r: any) => r.data.map((p: any) => [p.inStock, p.stockStatus, p.stockLeft]);

      it("R2: the view is resolved ONCE for the whole listing (never per product), for THIS customer", async () => {
        gated([]);
        threeProducts();
        viewIs({ canBackorder: true, visibility: "show" });
        await service.getCatalog({}, "c1");
        expect(backorderResolve).toHaveBeenCalledTimes(1);
        expect(backorderResolve).toHaveBeenCalledWith({
          tenantId: "test-tenant",
          customerId: "c1",
        });
      });

      it("show + can backorder: stock stays truthful and every row says canBackorder", async () => {
        gated([]);
        threeProducts();
        viewIs({ canBackorder: true, visibility: "show" });
        const res = (await service.getCatalog({}, "c1")) as any;
        expect(stockOf(res)).toEqual([
          [true, "LOW", 3],
          [false, "OUT_OF_STOCK", null],
          [true, "IN_STOCK", null],
        ]);
        expect(res.data.map((p: any) => p.canBackorder)).toEqual([true, true, true]);
      });

      it("hide + can backorder: EVERY row looks in stock and no count leaks (list)", async () => {
        gated([]);
        threeProducts();
        viewIs({ canBackorder: true, visibility: "hide" });
        const res = (await service.getCatalog({}, "c1")) as any;
        expect(stockOf(res)).toEqual([
          [true, "IN_STOCK", null],
          [true, "IN_STOCK", null],
          [true, "IN_STOCK", null],
        ]);
      });

      it("a buyer who CANNOT backorder is never masked, whatever the visibility, and canBackorder is false", async () => {
        gated([]);
        threeProducts();
        viewIs({ canBackorder: false, visibility: "hide" });
        const res = (await service.getCatalog({}, "c1")) as any;
        expect(stockOf(res)).toEqual([
          [true, "LOW", 3],
          [false, "OUT_OF_STOCK", null],
          [true, "IN_STOCK", null],
        ]);
        expect(res.data.map((p: any) => p.canBackorder)).toEqual([false, false, false]);
      });
    });

    it("ids filters via andWhere and fetches ALL of them (never a truncated page)", async () => {
      gated([]);
      await service.getCatalog({ ids: ["p9", "p42"], limit: 20 }, "c1");
      expect(products.findAll).toHaveBeenCalledWith(
        // limit 0 = fetch-all: a page boundary would drop cart lines, and the
        // cart prices anything missing at 0.
        expect.objectContaining({ page: 1, limit: 0 }),
        { andWhere: [{ id: { in: ["p9", "p42"] } }, VIS] },
      );
    });

    it("ids composes with the regulated-visibility gate rather than bypassing it", async () => {
      gated([{ id: "cat-alc", name: "Alcohol" }]);
      auths([]);
      await service.getCatalog({ ids: ["p9"] }, "c1");
      expect(products.findAll).toHaveBeenCalledWith(expect.anything(), {
        excludeTrackedCategoryIds: ["cat-alc"],
        andWhere: [{ id: { in: ["p9"] } }, VIS],
      });
    });

    it("collection=new filters via andWhere [{ isNew: true }]", async () => {
      gated([]);
      await service.getCatalog({ collection: "new" }, "c1");
      expect(products.findAll).toHaveBeenCalledWith(expect.anything(), {
        andWhere: [{ isNew: true }, VIS],
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
        andWhere: [
          { OR: [{ isDeal: true }, { category: "Beverages" }, { id: { in: ["p1"] } }] },
          VIS,
        ],
      });
    });

    it("collection=deals matches the entire catalog ({}) when an ALL-scope promo is active", async () => {
      gated([]);
      promotions.activeForCatalog.mockResolvedValue([
        { scope: "ALL", category: null, productIds: [] },
      ]);
      await service.getCatalog({ collection: "deals" }, "c1");
      expect(products.findAll).toHaveBeenCalledWith(expect.anything(), { andWhere: [{}, VIS] });
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
        andWhere: [{ id: { in: ["p1", "p3"] } }, VIS],
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
        andWhere: [{ id: { in: ["p9", "p2"] } }, VIS],
      });
    });

    it("collection=favorites is skipped when buyerAccountId is omitted", async () => {
      gated([]);
      await service.getCatalog({ collection: "favorites" }, "c1");
      expect(prisma.buyerFavorite.findMany).not.toHaveBeenCalled();
      expect(products.findAll).toHaveBeenCalledWith(expect.anything(), { andWhere: [VIS] });
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
        { search: undefined, category: undefined, page: 1, limit: 0 },
        { andWhere: [VIS] },
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
          // deals = { AND: [baseWhere, dealsWhere] }: its first clause is the 4-clause baseWhere (the sellable
          // clause inside a plain baseWhere has an AND of its own, but only 2 clauses)
          if (where.AND?.[0]?.AND?.length >= 4) return 3;
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
          // baseWhere = AND[sellable{AND[isActive, kind]}, portalVisible, parentOR, gate] (4 clauses); the deals
          // count nests it one level down as { AND: [baseWhere, dealsWhere] }. The sellable clause has an AND of
          // its own (2 clauses), so telling the two apart by "has an inner AND" is no longer enough.
          const base = where.AND?.[0]?.AND?.length >= 4 ? where.AND[0] : where;
          const gate = base.AND?.[3]?.OR;
          expect(gate).toEqual(NULL_SAFE_GATE);
          expect(where.trackedCategoryId).toBeUndefined();
        }
        const groupByWhere = (productGroupBy.mock.calls[0] as any[])[0].where;
        expect(groupByWhere.AND[3].OR).toEqual(NULL_SAFE_GATE);
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
