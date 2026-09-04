import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { ProductsService } from "../products/products.service";
import { StorageService } from "../storage/storage.service";
import { RegulatedVisibilityService } from "./regulated-visibility.service";
import { effectiveBuyerPrice, getTierPrice } from "@routeflow/pricing";
import { OrdersService } from "../orders/orders.service";
import { ReplenishmentService } from "./replenishment.service";
import { PromotionsService } from "../promotions/promotions.service";

/** Max images presigned per product for the tile's dot-pager (P5-02). */
const MAX_TILE_IMAGES = 4;

export interface BuyerProduct {
  id: string;
  name: string;
  description: string | null;
  sku: string | null;
  barcode: string | null;
  unit: string;
  category: string | null;
  buyerPrice: number;
  unitsPerBox: number | null;
  thumbnailUrl: string | null;
  imageKeys: string[];
  isFeatured: boolean;
  isNew: boolean;
  isDeal: boolean;
  /** Presigned URLs for the first images (max 4) — the tile dot-pager. [] when no images. */
  imageUrls: string[];
  // RF-200: stock availability fields
  inStock: boolean;
  stockStatus: "IN_STOCK" | "LOW" | "OUT_OF_STOCK";
  /** Whole units remaining, exposed ONLY while stockStatus === "LOW" ("Only N left"); else null. */
  stockLeft: number | null;
}

@Injectable()
export class BuyerCatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly productsService: ProductsService,
    private readonly storage: StorageService,
    private readonly visibility: RegulatedVisibilityService,
    private readonly ordersService: OrdersService,
    private readonly replenishment: ReplenishmentService,
    private readonly promotions: PromotionsService,
  ) {}

  /**
   * Where-fragment matching every product that would surface as a deal: the
   * isDeal merch flag OR coverage by an active promotion's scope. An ALL-scope
   * promo makes the whole catalog a deal ({} matches everything). QTY_BREAK
   * promos count as deals even though their struck price only appears at the
   * qty threshold (the tile shows the rule as a chip).
   */
  private dealsWhere(
    promos: Array<{ scope: string; category: string | null; productIds: string[] }>,
  ): Record<string, unknown> {
    const or: Record<string, unknown>[] = [{ isDeal: true }];
    for (const p of promos) {
      if (p.scope === "ALL") return {};
      if (p.scope === "CATEGORY" && p.category) or.push({ category: p.category });
      if (p.scope === "PRODUCTS" && p.productIds.length > 0) or.push({ id: { in: p.productIds } });
    }
    return { OR: or };
  }

  /**
   * The customer's remembered override prices per product (their last agreed
   * operator price). Used to make a sticky UPSELL the effective buyer price so the
   * catalog never reveals the lower base — see {@link effectiveBuyerPrice}.
   */
  private getRememberedPrices(customerId: string) {
    return this.ordersService.getCustomerPriceHistory(customerId);
  }

  /**
   * The availability triple every buyer-facing product carries. Shared by the
   * catalog listing and the single-product detail so a tile and its detail page
   * can never disagree about stock (an OOS tile must stay OOS when opened).
   */
  private deriveStock(p: {
    currentStock?: unknown;
    lowStockThreshold?: unknown;
  }): Pick<BuyerProduct, "inStock" | "stockStatus" | "stockLeft"> {
    const stock = Number(p.currentStock ?? 0);
    const lowThreshold = Number(p.lowStockThreshold ?? 5);
    const stockStatus: BuyerProduct["stockStatus"] =
      stock <= 0 ? "OUT_OF_STOCK" : stock <= lowThreshold ? "LOW" : "IN_STOCK";
    return {
      inStock: stock > 0,
      stockStatus,
      // Whole units only, floor >= 1 so a fractional Decimal never renders
      // "Only 0 left" while status is LOW (stock > 0 by definition here).
      stockLeft: stockStatus === "LOW" ? Math.max(1, Math.floor(stock)) : null,
    };
  }

  /**
   * Get paginated product catalog with buyer-specific pricing.
   * Strips all seller-internal fields (stock, cost, raw tier prices).
   *
   * For price-based sorts, we must fetch ALL matching products, resolve buyer prices,
   * sort in memory, then paginate. For name sorts, the DB handles ordering natively.
   */
  async getCatalog(
    query: {
      search?: string;
      category?: string;
      page?: number;
      limit?: number;
      sort?: string;
      collection?: "usuals" | "favorites" | "new" | "deals";
      ids?: string[];
    },
    customerId: string,
    buyerAccountId?: string,
  ) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const isPriceSort = query.sort === "price_asc" || query.sort === "price_desc";
    const isBestSort = query.sort === "best";
    // An explicit id filter must return EVERY requested product, not a page of
    // them — the cart prices its lines from this response, and a truncated page
    // silently prices the missing lines at 0.
    const byIds = (query.ids?.length ?? 0) > 0;
    // Price + best sorts rank on data resolved in-memory (buyer pricing /
    // replenishment frequency), so fetch ALL matches and paginate after sorting.
    const fetchAll = isPriceSort || isBestSort || byIds;

    // W7 gate: hide products in regulated categories the buyer isn't licensed for.
    const { hiddenIds, locked } = await this.visibility.computeGate(customerId);

    // Smart-collection filter → extra AND clauses (query-level so pagination
    // counts stay correct AND the regulated exclusion composes automatically).
    const andWhere: Record<string, unknown>[] = [];
    // Composes with the regulated-visibility gate below, so an id filter can
    // never surface a product the buyer isn't licensed to see.
    if (byIds) {
      andWhere.push({ id: { in: query.ids } });
    }
    if (query.collection === "new") {
      andWhere.push({ isNew: true });
    } else if (query.collection === "deals") {
      andWhere.push(this.dealsWhere(await this.promotions.activeForCatalog()));
    } else if (query.collection === "usuals") {
      const estimates = await this.replenishment.estimates(customerId);
      const ids = estimates.filter((e) => e.orderCount >= 2).map((e) => e.productId);
      andWhere.push({ id: { in: ids } });
    } else if (query.collection === "favorites" && buyerAccountId) {
      const favs = await this.prisma.forTenant().buyerFavorite.findMany({
        where: { buyerAccountId, customerId },
        select: { productId: true },
      });
      andWhere.push({ id: { in: favs.map((f) => f.productId) } });
    }

    const opts =
      hiddenIds.size > 0 || andWhere.length > 0
        ? {
            ...(hiddenIds.size > 0 ? { excludeTrackedCategoryIds: [...hiddenIds] } : {}),
            ...(andWhere.length > 0 ? { andWhere } : {}),
          }
        : undefined;

    const result = await this.productsService.findAll(
      {
        search: query.search,
        category: query.category,
        isActive: true,
        page: fetchAll ? 1 : page,
        limit: fetchAll ? 0 : limit,
      },
      opts,
    );

    // Load customer's pricing tier
    const customer = await this.prisma
      .forTenant()
      .customer.findFirst({ where: { id: customerId }, select: { pricingTier: true } });
    const defaultTier = customer?.pricingTier ?? 1;

    // Load per-product tier overrides for all products in this page
    const productIds = result.data.map((p: any) => p.id);
    const customerPrices =
      productIds.length > 0
        ? await this.prisma.forTenant().customerPrice.findMany({
            where: { customerId, productId: { in: productIds } },
          })
        : [];
    const cpMap = new Map(customerPrices.map((cp) => [cp.productId, cp.pricingTier]));

    // Sticky upsell: a remembered above-list price becomes the effective catalog
    // price (hides the base; matches what self-serve checkout charges).
    const priceHist = await this.getRememberedPrices(customerId);

    // Map to buyer-safe objects with resolved pricing
    let products: BuyerProduct[] = await Promise.all(
      result.data.map(async (p: any) => {
        const effectiveTier = cpMap.get(p.id) ?? defaultTier;
        const buyerPrice = effectiveBuyerPrice(
          getTierPrice(p, effectiveTier),
          Number(p.pricePerUnit),
          priceHist[p.id]?.lastPrice ?? null,
        );

        // Dot pager: presign up to the first 4 images (HMAC-local, no network).
        // First entry corresponds to thumbnailUrl (same key, first image).
        const imageUrls =
          (p.imageKeys?.length ?? 0) > 0
            ? await this.storage.presignedUrls(p.imageKeys.slice(0, MAX_TILE_IMAGES))
            : [];

        return {
          id: p.id,
          name: p.name,
          description: p.description,
          sku: p.sku,
          barcode: p.barcode,
          unit: p.unit,
          category: p.category,
          buyerPrice,
          unitsPerBox: p.unitsPerBox ?? null,
          isFeatured: p.isFeatured ?? false,
          isNew: p.isNew ?? false,
          isDeal: p.isDeal ?? false,
          thumbnailUrl: p.thumbnailUrl ?? null,
          imageKeys: p.imageKeys ?? [],
          imageUrls,
          ...this.deriveStock(p),
        };
      }),
    );

    // Apply sorting
    if (query.sort === "price_asc") {
      products.sort((a, b) => a.buyerPrice - b.buyerPrice);
    } else if (query.sort === "price_desc") {
      products.sort((a, b) => b.buyerPrice - a.buyerPrice);
    } else if (query.sort === "name_desc") {
      products.sort((a, b) => b.name.localeCompare(a.name));
    } else if (isBestSort) {
      // "Best for you" = the replenishment frequency slice (G10): most-often
      // reordered first, then the one running out soonest, then name.
      const estimates = await this.replenishment.estimates(customerId);
      const freq = new Map(estimates.map((e) => [e.productId, e]));
      products.sort((a, b) => {
        const ea = freq.get(a.id);
        const eb = freq.get(b.id);
        const oa = ea?.orderCount ?? 0;
        const ob = eb?.orderCount ?? 0;
        if (oa !== ob) return ob - oa;
        const da = ea?.estDaysLeft ?? Number.POSITIVE_INFINITY;
        const db = eb?.estDaysLeft ?? Number.POSITIVE_INFINITY;
        if (da !== db) return da - db;
        return a.name.localeCompare(b.name);
      });
    }
    // name_asc is the default from ProductsService — no additional sort needed

    // For price/best sorts, manually paginate the fully-sorted result
    if (fetchAll) {
      const total = products.length;
      const start = (page - 1) * limit;
      products = products.slice(start, start + limit);
      return {
        data: products,
        meta: {
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit),
        },
        hiddenCategories: locked,
      };
    }

    return { data: products, meta: result.meta, hiddenCategories: locked };
  }

  /**
   * Category-rail data: total + per-category product counts + smart-collection
   * counts + the locked regulated categories. Every count applies the W7
   * visibility gate so a locked category's products are never countable.
   */
  async getCatalogCounts(customerId: string, buyerAccountId: string) {
    const { hiddenIds, locked } = await this.visibility.computeGate(customerId);
    const baseWhere: Record<string, unknown> = { isActive: true };
    // Same NULL trap as products.service.findAll: `notIn` never matches NULL,
    // so keying this on trackedCategoryId zeroed every rail count for
    // untracked products whenever a license-gated category existed.
    if (hiddenIds.size > 0) {
      baseWhere.OR = [
        { trackedCategoryId: null },
        { trackedCategoryId: { notIn: [...hiddenIds] } },
      ];
    }

    const [total, byCategory, newCount, favRows, estimates, promos] = await Promise.all([
      this.prisma.forTenant().product.count({ where: baseWhere }),
      this.prisma.forTenant().product.groupBy({
        by: ["category"],
        where: { ...baseWhere, category: { not: null } },
        _count: { _all: true },
      }),
      this.prisma.forTenant().product.count({ where: { ...baseWhere, isNew: true } }),
      this.prisma.forTenant().buyerFavorite.findMany({
        where: { buyerAccountId, customerId },
        select: { productId: true },
      }),
      this.replenishment.estimates(customerId),
      this.promotions.activeForCatalog(),
    ]);

    const usualIds = estimates.filter((e) => e.orderCount >= 2).map((e) => e.productId);
    const favIds = favRows.map((f) => f.productId);
    const [usuals, favorites, deals] = await Promise.all([
      usualIds.length > 0
        ? this.prisma.forTenant().product.count({ where: { ...baseWhere, id: { in: usualIds } } })
        : Promise.resolve(0),
      favIds.length > 0
        ? this.prisma.forTenant().product.count({ where: { ...baseWhere, id: { in: favIds } } })
        : Promise.resolve(0),
      this.prisma
        .forTenant()
        .product.count({ where: { AND: [baseWhere, this.dealsWhere(promos)] } }),
    ]);

    return {
      total,
      categories: (byCategory as Array<{ category: string | null; _count: { _all: number } }>)
        .filter((c) => c.category)
        .map((c) => ({ name: c.category as string, count: c._count._all }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      collections: { usuals, favorites, new: newCount, deals },
      lockedCategories: locked,
    };
  }

  /**
   * Get single product detail with buyer-specific pricing and full image URLs.
   */
  async getProductDetail(productId: string, customerId: string) {
    const product = await this.productsService.findOne(productId);

    // Buyers must not see inactive/discontinued products
    if (!(product as any).isActive) {
      throw new NotFoundException("Product not found");
    }

    // W7 gate: a buyer must not deep-link a product in a locked regulated category.
    const catId = (product as any).trackedCategoryId as string | null;
    if (catId) {
      const { hiddenIds } = await this.visibility.computeGate(customerId);
      if (hiddenIds.has(catId)) throw new NotFoundException("Product not found");
    }

    // Resolve buyer pricing
    const customer = await this.prisma
      .forTenant()
      .customer.findFirst({ where: { id: customerId }, select: { pricingTier: true } });
    const defaultTier = customer?.pricingTier ?? 1;

    // Deactivated variants must never reach a buyer: findOne includes them (it
    // only sorts isActive desc), every other buyer surface lists active products
    // only, and such a row would quote a price whose link dead-ends on this
    // endpoint's own isActive 404.
    const activeVariants: any[] = ((product as any).variants ?? []).filter(
      (v: any) => v.isActive !== false,
    );
    // Tier overrides for the parent AND every variant row in one query: a variant
    // carrying its own CustomerPrice must price identically here and on its own
    // tile/detail page (getCatalog resolves the tier per product the same way).
    const variantIds: string[] = activeVariants.map((v: any) => v.id);
    const cpOverrides = await this.prisma.forTenant().customerPrice.findMany({
      where: { customerId, productId: { in: [product.id, ...variantIds] } },
    });
    const cpMap = new Map(cpOverrides.map((cp) => [cp.productId, cp.pricingTier]));
    const effectiveTier = cpMap.get(product.id) ?? defaultTier;
    const priceHist = await this.getRememberedPrices(customerId);
    const buyerPrice = effectiveBuyerPrice(
      getTierPrice(product, effectiveTier),
      Number(product.pricePerUnit),
      priceHist[product.id]?.lastPrice ?? null,
    );

    // First entry corresponds to thumbnailUrl (same key, first image) — findOne
    // presigns every image, the listing only the first MAX_TILE_IMAGES.
    const imageUrls: string[] = (product as any).imageUrls ?? [];

    return {
      id: product.id,
      name: product.name,
      description: product.description,
      sku: product.sku,
      barcode: product.barcode,
      unit: product.unit,
      category: product.category,
      buyerPrice,
      // The merch/box/stock fields the listing returns must be here too: the
      // detail page shares the tile's add-to-cart semantics (boxed => 1 box)
      // and its stock/badge rendering.
      unitsPerBox: product.unitsPerBox ?? null,
      isFeatured: product.isFeatured ?? false,
      isNew: product.isNew ?? false,
      isDeal: product.isDeal ?? false,
      thumbnailUrl: imageUrls[0] ?? null,
      imageUrls,
      imageKeys: product.imageKeys ?? [],
      ...this.deriveStock(product),
      variants: activeVariants.map((v: any) => ({
        id: v.id,
        name: v.variantName,
        sku: v.sku,
        buyerPrice: effectiveBuyerPrice(
          getTierPrice(v, cpMap.get(v.id) ?? defaultTier),
          Number(v.pricePerUnit),
          priceHist[v.id]?.lastPrice ?? null,
        ),
        unit: v.unit,
        // Promo inputs — a variant row's price must go through the same
        // deriveTilePrice the variant's own tile/detail page uses.
        category: v.category ?? null,
        unitsPerBox: v.unitsPerBox ?? null,
      })),
    };
  }

  /**
   * Get distinct active product categories for filter dropdowns.
   */
  async getCategories() {
    const products = await this.prisma.forTenant().product.findMany({
      where: { isActive: true, category: { not: null } },
      select: { category: true },
      distinct: ["category"],
      orderBy: { category: "asc" },
    });
    return products.map((p) => p.category).filter(Boolean);
  }

  // ─── Favorites ──────────────────────────────────────────────────────────────

  /**
   * Get all favorite products for this buyer at this seller, with resolved pricing.
   */
  async getFavorites(buyerAccountId: string, customerId: string) {
    const favorites = await this.prisma.forTenant().buyerFavorite.findMany({
      where: { buyerAccountId, customerId },
      include: {
        product: true,
      },
      orderBy: { createdAt: "desc" },
    });

    // Filter out inactive products + W7-gated regulated products (categories the
    // buyer isn't licensed for) so favorites never leak a hidden product.
    const { hiddenIds } = await this.visibility.computeGate(customerId);
    const activeFavorites = favorites.filter(
      (f) =>
        f.product.isActive &&
        !(f.product.trackedCategoryId && hiddenIds.has(f.product.trackedCategoryId)),
    );

    // Load customer pricing tier + overrides
    const customer = await this.prisma
      .forTenant()
      .customer.findFirst({ where: { id: customerId }, select: { pricingTier: true } });
    const defaultTier = customer?.pricingTier ?? 1;

    const productIds = activeFavorites.map((f) => f.productId);
    const cpOverrides =
      productIds.length > 0
        ? await this.prisma.forTenant().customerPrice.findMany({
            where: { customerId, productId: { in: productIds } },
          })
        : [];
    const cpMap = new Map(cpOverrides.map((cp) => [cp.productId, cp.pricingTier]));
    const priceHist = await this.getRememberedPrices(customerId);

    return activeFavorites.map((f) => {
      const effectiveTier = cpMap.get(f.productId) ?? defaultTier;
      return {
        id: f.id,
        productId: f.productId,
        name: f.product.name,
        sku: f.product.sku,
        unit: f.product.unit,
        category: f.product.category,
        buyerPrice: effectiveBuyerPrice(
          getTierPrice(f.product, effectiveTier),
          Number(f.product.pricePerUnit),
          priceHist[f.productId]?.lastPrice ?? null,
        ),
        thumbnailUrl: null as string | null, // thumbnails resolved in catalog listing
        imageKeys: f.product.imageKeys ?? [],
        // Needed so add-to-cart from the mobile favorites screen orders a boxed
        // product as boxes (not loose pieces) — matches getCatalog.
        unitsPerBox: f.product.unitsPerBox ?? null,
        createdAt: f.createdAt,
      };
    });
  }

  /**
   * Add a product to the buyer's favorites.
   */
  async addFavorite(
    buyerAccountId: string,
    customerId: string,
    productId: string,
    tenantId: string,
  ) {
    // Verify the product exists and is active
    const product = await this.prisma
      .forTenant()
      .product.findFirst({ where: { id: productId, isActive: true } });
    if (!product) throw new NotFoundException("Product not found");

    try {
      const fav = await this.prisma.forTenant().buyerFavorite.create({
        data: { buyerAccountId, customerId, productId, tenantId },
      });
      return { id: fav.id, productId, message: "Added to favorites" };
    } catch (err: any) {
      // Unique constraint violation — already favorited
      if (err.code === "P2002") {
        throw new ConflictException("Product is already in favorites");
      }
      throw err;
    }
  }

  /**
   * Remove a product from the buyer's favorites.
   */
  async removeFavorite(buyerAccountId: string, customerId: string, productId: string) {
    const deleted = await this.prisma.forTenant().buyerFavorite.deleteMany({
      where: { buyerAccountId, customerId, productId },
    });
    if (deleted.count === 0) throw new NotFoundException("Favorite not found");
    return { productId, message: "Removed from favorites" };
  }
}
