import { Injectable, ConflictException, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { ProductsService } from "../products/products.service";
import { StorageService } from "../storage/storage.service";
import { RegulatedVisibilityService } from "./regulated-visibility.service";
import { getTierPrice } from "../utils/pricing";
import { effectiveBuyerPrice } from "../common/pricing";
import { OrdersService } from "../orders/orders.service";

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
  // RF-200: stock availability fields
  inStock: boolean;
  stockStatus: "IN_STOCK" | "LOW" | "OUT_OF_STOCK";
}

@Injectable()
export class BuyerCatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly productsService: ProductsService,
    private readonly storage: StorageService,
    private readonly visibility: RegulatedVisibilityService,
    private readonly ordersService: OrdersService,
  ) {}

  /**
   * The customer's remembered override prices per product (their last agreed
   * operator price). Used to make a sticky UPSELL the effective buyer price so the
   * catalog never reveals the lower base — see {@link effectiveBuyerPrice}.
   */
  private getRememberedPrices(customerId: string) {
    return this.ordersService.getCustomerPriceHistory(customerId);
  }

  /**
   * Get paginated product catalog with buyer-specific pricing.
   * Strips all seller-internal fields (stock, cost, raw tier prices).
   *
   * For price-based sorts, we must fetch ALL matching products, resolve buyer prices,
   * sort in memory, then paginate. For name sorts, the DB handles ordering natively.
   */
  async getCatalog(
    query: { search?: string; category?: string; page?: number; limit?: number; sort?: string },
    customerId: string,
  ) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const isPriceSort = query.sort === "price_asc" || query.sort === "price_desc";

    // W7 gate: hide products in regulated categories the buyer isn't licensed for.
    const { hiddenIds, locked } = await this.visibility.computeGate(customerId);

    // For price sorts, fetch ALL matching products (limit=0) so sorting is global
    const result = await this.productsService.findAll(
      {
        search: query.search,
        category: query.category,
        isActive: true,
        page: isPriceSort ? 1 : page,
        limit: isPriceSort ? 0 : limit,
      },
      hiddenIds.size > 0 ? { excludeTrackedCategoryIds: [...hiddenIds] } : undefined,
    );

    // Load customer's pricing tier
    const customer = await this.prisma
      .forTenant()
      .customer.findUnique({ where: { id: customerId }, select: { pricingTier: true } });
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
    let products: BuyerProduct[] = result.data.map((p: any) => {
      const effectiveTier = cpMap.get(p.id) ?? defaultTier;
      const buyerPrice = effectiveBuyerPrice(
        getTierPrice(p, effectiveTier),
        Number(p.pricePerUnit),
        priceHist[p.id]?.lastPrice ?? null,
      );

      const stock = Number(p.currentStock ?? 0);
      const lowThreshold = Number(p.lowStockThreshold ?? 5);
      const stockStatus: BuyerProduct["stockStatus"] =
        stock <= 0 ? "OUT_OF_STOCK" : stock <= lowThreshold ? "LOW" : "IN_STOCK";

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
        thumbnailUrl: p.thumbnailUrl ?? null,
        imageKeys: p.imageKeys ?? [],
        inStock: stock > 0,
        stockStatus,
      };
    });

    // Apply sorting
    if (query.sort === "price_asc") {
      products.sort((a, b) => a.buyerPrice - b.buyerPrice);
    } else if (query.sort === "price_desc") {
      products.sort((a, b) => b.buyerPrice - a.buyerPrice);
    } else if (query.sort === "name_desc") {
      products.sort((a, b) => b.name.localeCompare(a.name));
    }
    // name_asc is the default from ProductsService — no additional sort needed

    // For price sorts, manually paginate the fully-sorted result
    if (isPriceSort) {
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
      .customer.findUnique({ where: { id: customerId }, select: { pricingTier: true } });
    const defaultTier = customer?.pricingTier ?? 1;

    const cpOverride = await this.prisma.forTenant().customerPrice.findFirst({
      where: { customerId, productId },
    });
    const effectiveTier = cpOverride?.pricingTier ?? defaultTier;
    const priceHist = await this.getRememberedPrices(customerId);
    const buyerPrice = effectiveBuyerPrice(
      getTierPrice(product, effectiveTier),
      Number(product.pricePerUnit),
      priceHist[product.id]?.lastPrice ?? null,
    );

    return {
      id: product.id,
      name: product.name,
      description: product.description,
      sku: product.sku,
      barcode: product.barcode,
      unit: product.unit,
      category: product.category,
      buyerPrice,
      imageUrls: (product as any).imageUrls ?? [],
      imageKeys: product.imageKeys ?? [],
      variants: ((product as any).variants ?? []).map((v: any) => ({
        id: v.id,
        name: v.variantName,
        sku: v.sku,
        buyerPrice: effectiveBuyerPrice(
          getTierPrice(v, effectiveTier),
          Number(v.pricePerUnit),
          priceHist[v.id]?.lastPrice ?? null,
        ),
        unit: v.unit,
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
      .customer.findUnique({ where: { id: customerId }, select: { pricingTier: true } });
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
