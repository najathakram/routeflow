import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { ProductsService } from "../products/products.service";
import { StorageService } from "../storage/storage.service";
import { getTierPrice } from "../utils/pricing";

export interface BuyerProduct {
  id: string;
  name: string;
  description: string | null;
  sku: string | null;
  barcode: string | null;
  unit: string;
  category: string | null;
  buyerPrice: number;
  thumbnailUrl: string | null;
  imageKeys: string[];
}

@Injectable()
export class BuyerCatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly productsService: ProductsService,
    private readonly storage: StorageService,
  ) {}

  /**
   * Get paginated product catalog with buyer-specific pricing.
   * Strips all seller-internal fields (stock, cost, raw tier prices).
   */
  async getCatalog(
    query: { search?: string; category?: string; page?: number; limit?: number; sort?: string },
    customerId: string,
  ) {
    // Force isActive: true — buyers only see active products
    const result = await this.productsService.findAll({
      search: query.search,
      category: query.category,
      isActive: true,
      page: query.page ?? 1,
      limit: query.limit ?? 20,
    });

    // Load customer's pricing tier
    const customer = await this.prisma
      .forTenant()
      .customer.findUnique({ where: { id: customerId }, select: { pricingTier: true } });
    const defaultTier = customer?.pricingTier ?? 1;

    // Load per-product tier overrides for all products in this page
    const productIds = result.data.map((p: any) => p.id);
    const customerPrices = productIds.length > 0
      ? await this.prisma.forTenant().customerPrice.findMany({
          where: { customerId, productId: { in: productIds } },
        })
      : [];
    const cpMap = new Map(customerPrices.map((cp) => [cp.productId, cp.pricingTier]));

    // Map to buyer-safe objects with resolved pricing
    const products: BuyerProduct[] = result.data.map((p: any) => {
      const effectiveTier = cpMap.get(p.id) ?? defaultTier;
      const buyerPrice = getTierPrice(p, effectiveTier);

      return {
        id: p.id,
        name: p.name,
        description: p.description,
        sku: p.sku,
        barcode: p.barcode,
        unit: p.unit,
        category: p.category,
        buyerPrice,
        thumbnailUrl: p.thumbnailUrl ?? null,
        imageKeys: p.imageKeys ?? [],
      };
    });

    // Apply client-side sorting (server returns name asc by default)
    if (query.sort === "price_asc") {
      products.sort((a, b) => a.buyerPrice - b.buyerPrice);
    } else if (query.sort === "price_desc") {
      products.sort((a, b) => b.buyerPrice - a.buyerPrice);
    }
    // name_asc is the default from ProductsService, name_desc handled here
    else if (query.sort === "name_desc") {
      products.sort((a, b) => b.name.localeCompare(a.name));
    }

    return { data: products, meta: result.meta };
  }

  /**
   * Get single product detail with buyer-specific pricing and full image URLs.
   */
  async getProductDetail(productId: string, customerId: string) {
    const product = await this.productsService.findOne(productId);

    // Resolve buyer pricing
    const customer = await this.prisma
      .forTenant()
      .customer.findUnique({ where: { id: customerId }, select: { pricingTier: true } });
    const defaultTier = customer?.pricingTier ?? 1;

    const cpOverride = await this.prisma.forTenant().customerPrice.findFirst({
      where: { customerId, productId },
    });
    const effectiveTier = cpOverride?.pricingTier ?? defaultTier;
    const buyerPrice = getTierPrice(product, effectiveTier);

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
        buyerPrice: getTierPrice(v, effectiveTier),
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
}
