import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type {
  OrderSuggestionProduct,
  OrderSuggestionsResponse,
  RecentOrderLine,
  RecentOrderSummary,
  UsuallyBuysItem,
} from "@routeflow/types";
import { PrismaService } from "../prisma/prisma.service";

/** "Usually buys" looks back this many days from now. */
export const USUALLY_BUYS_DAYS = 90;
/** ...and offers this many products. */
export const USUALLY_BUYS_LIMIT = 8;
/** "Order again" offers this many recent orders. */
export const ORDER_AGAIN_COUNT = 5;

const DAY_MS = 86_400_000;

/** Order lines that can be re-added through the normal add-line path: a catalog product, not cancelled, not a bundle. */
const REORDERABLE_LINE = {
  productId: { not: null },
  status: { not: "CANCELLED" },
  compositionMode: null,
} as const;

const num = (v: unknown): number => Number(v ?? 0);
const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v));

function toSuggestionProduct(p: any): OrderSuggestionProduct {
  return {
    id: p.id,
    name: p.name,
    variantName: p.variantName ?? null,
    parentProductId: p.parentProductId ?? null,
    parent: p.parent ? { name: p.parent.name } : null,
    unit: p.unit,
    unitsPerBox: numOrNull(p.unitsPerBox),
    pricePerUnit: num(p.pricePerUnit),
    priceTier2: num(p.priceTier2),
    priceTier3: num(p.priceTier3),
    priceTier4: num(p.priceTier4),
    priceTier5: num(p.priceTier5),
    averageCost: numOrNull(p.averageCost),
    category: p.category ?? null,
    trackedCategoryId: p.trackedCategoryId ?? null,
    isActive: p.isActive !== false,
  };
}

/**
 * Staff "Usually buys" + "Order again" for the selected customer in New Order. Reads WHAT was
 * bought (product, quantity, unit) and the products' CURRENT catalog columns. A historical price is
 * never selected or returned: the order builder prices every added line today.
 *
 * Every read carries an explicit tenantId (OrderItem rows can have a null tenantId, so lines are
 * read THROUGH their order) and the customer must belong to the caller's tenant.
 */
@Injectable()
export class CustomerOrderSuggestionsService {
  constructor(private readonly prisma: PrismaService) {}

  async getSuggestions(customerId: string): Promise<OrderSuggestionsResponse> {
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) throw new BadRequestException("A tenant context is required.");
    const db = this.prisma.forTenant();

    const customer = await db.customer.findFirst({
      where: { id: customerId, tenantId },
      select: { id: true },
    });
    if (!customer) throw new NotFoundException("Customer not found");

    const since = new Date(Date.now() - USUALLY_BUYS_DAYS * DAY_MS);
    const [lines, orders] = await Promise.all([
      db.orderItem.findMany({
        where: {
          productId: { not: null },
          status: { not: "CANCELLED" },
          product: { isActive: true },
          order: {
            tenantId,
            customerId,
            status: { not: "CANCELLED" },
            // The business date when set, else the entry timestamp (a back-dated order counts when it happened).
            OR: [{ orderDate: { gte: since } }, { orderDate: null, createdAt: { gte: since } }],
          },
        },
        select: {
          productId: true,
          order: { select: { orderDate: true, createdAt: true } },
        },
      }),
      db.order.findMany({
        where: {
          tenantId,
          customerId,
          status: { not: "CANCELLED" },
          lineItems: { some: REORDERABLE_LINE },
        },
        orderBy: [
          { orderDate: { sort: "desc", nulls: "last" } },
          { createdAt: "desc" },
          { id: "desc" },
        ],
        take: ORDER_AGAIN_COUNT,
        select: {
          id: true,
          orderNumber: true,
          status: true,
          orderDate: true,
          createdAt: true,
          lineItems: {
            where: REORDERABLE_LINE,
            orderBy: [{ position: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }],
            select: {
              productId: true,
              qty: true,
              boxes: true,
              pieces: true,
              unitsPerBox: true,
              unitLabel: true,
            },
          },
        },
      }),
    ]);

    const usuallyBuys = this.rank(lines as any[]);
    const recentOrders: RecentOrderSummary[] = (orders as any[]).map((o) => ({
      id: o.id,
      orderNumber: o.orderNumber ?? null,
      date: new Date(o.orderDate ?? o.createdAt).toISOString(),
      status: o.status,
      lines: (o.lineItems as any[]).map((l): RecentOrderLine => ({
        productId: l.productId,
        qty: num(l.qty),
        boxes: numOrNull(l.boxes),
        pieces: numOrNull(l.pieces),
        unitsPerBox: numOrNull(l.unitsPerBox),
        unitLabel: l.unitLabel ?? null,
      })),
    }));

    const ids = [
      ...new Set([
        ...usuallyBuys.map((u) => u.productId),
        ...recentOrders.flatMap((o) => o.lines.map((l) => l.productId)),
      ]),
    ];
    const products: Record<string, OrderSuggestionProduct> = {};
    if (ids.length > 0) {
      const rows = await db.product.findMany({
        where: { tenantId, id: { in: ids } },
        select: {
          id: true,
          name: true,
          variantName: true,
          parentProductId: true,
          parent: { select: { name: true } },
          unit: true,
          unitsPerBox: true,
          pricePerUnit: true,
          priceTier2: true,
          priceTier3: true,
          priceTier4: true,
          priceTier5: true,
          averageCost: true,
          category: true,
          trackedCategoryId: true,
          isActive: true,
        },
      });
      for (const p of rows as any[]) products[p.id] = toSuggestionProduct(p);
    }

    return { customerId, usuallyBuys, recentOrders, products };
  }

  /** Order-line count per product, most bought first; a tie goes to the more recent order, then the id. */
  private rank(lines: { productId: string; order: { orderDate: Date | null; createdAt: Date } }[]) {
    const stats = new Map<string, { count: number; latest: number }>();
    for (const l of lines) {
      if (!l.productId) continue;
      const at = new Date(l.order.orderDate ?? l.order.createdAt).getTime();
      const s = stats.get(l.productId) ?? { count: 0, latest: 0 };
      s.count += 1;
      s.latest = Math.max(s.latest, at);
      stats.set(l.productId, s);
    }
    return [...stats.entries()]
      .sort(
        ([ida, a], [idb, b]) => b.count - a.count || b.latest - a.latest || ida.localeCompare(idb),
      )
      .slice(0, USUALLY_BUYS_LIMIT)
      .map(([productId, s]): UsuallyBuysItem => ({ productId, orderLineCount: s.count }));
  }
}
