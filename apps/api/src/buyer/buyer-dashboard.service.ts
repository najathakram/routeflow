import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { getTierPrice } from "../utils/pricing";

@Injectable()
export class BuyerDashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  /**
   * Aggregated dashboard data for a buyer at a specific seller.
   */
  async getDashboard(customerId: string) {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

    // Load customer pricing tier
    const customer = await this.prisma
      .forTenant()
      .customer.findUnique({ where: { id: customerId }, select: { pricingTier: true } });
    const defaultTier = customer?.pricingTier ?? 1;

    // Run all queries in parallel
    const [
      recentOrders,
      activeOrderCount,
      pendingDeliveries,
      templateCount,
      frequentlyOrderedRaw,
      newProducts,
      spend30d,
      spend90d,
      spendAllTime,
    ] = await Promise.all([
      // Recent orders (last 5)
      this.prisma.forTenant().order.findMany({
        where: { customerId },
        select: {
          id: true,
          orderNumber: true,
          status: true,
          total: true,
          createdAt: true,
          requestedDeliveryDate: true,
          lineItems: {
            select: { id: true },
          },
        },
        orderBy: { createdAt: "desc" },
        take: 5,
      }),

      // Active orders count (non-terminal)
      this.prisma.forTenant().order.count({
        where: {
          customerId,
          status: { in: ["PENDING", "CONFIRMED", "OUT_FOR_DELIVERY"] },
        },
      }),

      // Pending deliveries (confirmed + out for delivery)
      this.prisma.forTenant().order.count({
        where: {
          customerId,
          status: { in: ["CONFIRMED", "OUT_FOR_DELIVERY"] },
        },
      }),

      // Template count
      this.prisma.forTenant().orderTemplate.count({
        where: { customerId, isActive: true },
      }),

      // Frequently ordered products (top 10 by occurrence count)
      this.prisma.forTenant().orderItem.groupBy({
        by: ["productId"],
        where: {
          order: { customerId, status: { not: "CANCELLED" } },
        },
        _count: { productId: true },
        _sum: { qty: true },
        orderBy: { _count: { productId: "desc" } },
        take: 10,
      }),

      // New products (last 30 days)
      this.prisma.forTenant().product.findMany({
        where: { isActive: true, createdAt: { gte: thirtyDaysAgo } },
        orderBy: { createdAt: "desc" },
        take: 10,
      }),

      // Spend last 30 days
      this.prisma.forTenant().order.aggregate({
        where: {
          customerId,
          status: { not: "CANCELLED" },
          createdAt: { gte: thirtyDaysAgo },
        },
        _sum: { total: true },
      }),

      // Spend last 90 days
      this.prisma.forTenant().order.aggregate({
        where: {
          customerId,
          status: { not: "CANCELLED" },
          createdAt: { gte: ninetyDaysAgo },
        },
        _sum: { total: true },
      }),

      // Spend all time
      this.prisma.forTenant().order.aggregate({
        where: {
          customerId,
          status: { not: "CANCELLED" },
        },
        _sum: { total: true },
      }),
    ]);

    // Enrich frequently ordered products with product details + buyer pricing
    const freqProductIds = frequentlyOrderedRaw.map((f) => f.productId);
    const freqProducts =
      freqProductIds.length > 0
        ? await this.prisma.forTenant().product.findMany({
            where: { id: { in: freqProductIds }, isActive: true },
          })
        : [];
    const freqProductMap = new Map(freqProducts.map((p) => [p.id, p]));

    // Load customer price overrides for frequent products
    const freqCustomerPrices =
      freqProductIds.length > 0
        ? await this.prisma.forTenant().customerPrice.findMany({
            where: { customerId, productId: { in: freqProductIds } },
          })
        : [];
    const cpMap = new Map(freqCustomerPrices.map((cp) => [cp.productId, cp.pricingTier]));

    const frequentlyOrdered = await Promise.all(
      frequentlyOrderedRaw
        .filter((f) => freqProductMap.has(f.productId))
        .map(async (f) => {
          const product = freqProductMap.get(f.productId)!;
          const effectiveTier = cpMap.get(f.productId) ?? defaultTier;
          const thumbnailUrl =
            product.imageKeys.length > 0
              ? await this.storage.presignedUrl(product.imageKeys[0])
              : null;
          return {
            productId: product.id,
            name: product.name,
            sku: product.sku,
            unit: product.unit,
            category: product.category,
            buyerPrice: getTierPrice(product, effectiveTier),
            thumbnailUrl,
            orderCount: f._count.productId,
            totalQty: Number(f._sum.qty ?? 0),
          };
        }),
    );

    // Enrich new products with thumbnails + buyer pricing
    const newProductIds = newProducts.map((p) => p.id);
    const newCpOverrides =
      newProductIds.length > 0
        ? await this.prisma.forTenant().customerPrice.findMany({
            where: { customerId, productId: { in: newProductIds } },
          })
        : [];
    const newCpMap = new Map(newCpOverrides.map((cp) => [cp.productId, cp.pricingTier]));

    const newFromSeller = await Promise.all(
      newProducts.map(async (p) => {
        const effectiveTier = newCpMap.get(p.id) ?? defaultTier;
        const thumbnailUrl =
          p.imageKeys.length > 0 ? await this.storage.presignedUrl(p.imageKeys[0]) : null;
        return {
          id: p.id,
          name: p.name,
          sku: p.sku,
          unit: p.unit,
          category: p.category,
          buyerPrice: getTierPrice(p, effectiveTier),
          thumbnailUrl,
        };
      }),
    );

    return {
      recentOrders: recentOrders.map((o) => ({
        id: o.id,
        orderNumber: o.orderNumber,
        status: o.status,
        total: Number(o.total),
        createdAt: o.createdAt,
        requestedDeliveryDate: o.requestedDeliveryDate,
        itemCount: o.lineItems.length,
      })),
      stats: {
        activeOrders: activeOrderCount,
        pendingDeliveries,
        templateCount,
        spend30d: Number(spend30d._sum.total ?? 0),
        spend90d: Number(spend90d._sum.total ?? 0),
        spendAllTime: Number(spendAllTime._sum.total ?? 0),
      },
      frequentlyOrdered,
      newFromSeller,
    };
  }
}
