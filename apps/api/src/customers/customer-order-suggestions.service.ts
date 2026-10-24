import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { ItemStatus, OrderStatus, type Prisma } from "@prisma/client";
import type {
  OrderSuggestionProduct,
  OrderSuggestionsResponse,
  RecentOrderLine,
  RecentOrderSummary,
  UsuallyBuysItem,
} from "@routeflow/types";
import { PrismaService } from "../prisma/prisma.service";
import { tenantSafeParent } from "../products/product-parent";
import { defaultSaleFulfilmentKind } from "../orders/default-sale-fulfilment";
import type { SaleFulfilmentKind } from "../selling-restrictions/sale-fulfilment";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";

/** "Usually buys" looks back this many days from now. */
export const USUALLY_BUYS_DAYS = 90;
/** ...and offers this many products. */
export const USUALLY_BUYS_LIMIT = 8;
/**
 * The database ranks and returns this many candidates (a bound, whatever the customer's history),
 * so a few banned or retired products at the top still leave `USUALLY_BUYS_LIMIT` to offer.
 */
export const USUALLY_BUYS_CANDIDATES = 24;
/** "Order again" offers this many recent orders. */
export const ORDER_AGAIN_COUNT = 5;

const DAY_MS = 86_400_000;

/** Orders that never count: cancelled, and a DRAFT (not placed yet). */
const NOT_PLACED: Prisma.EnumOrderStatusFilter = {
  notIn: [OrderStatus.CANCELLED, OrderStatus.DRAFT],
};

/** Order lines that can be re-added through the normal add-line path: a catalog product, not cancelled, not a bundle. */
const REORDERABLE_LINE = {
  productId: { not: null },
  status: { not: ItemStatus.CANCELLED },
  compositionMode: null,
} satisfies Prisma.OrderItemWhereInput;

const PRODUCT_SELECT = {
  id: true,
  name: true,
  variantName: true,
  parentProductId: true,
  // tenantId only for the cross-tenant check (B1211); it never reaches the response.
  parent: { select: { name: true, tenantId: true } },
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
} satisfies Prisma.ProductSelect;

type ProductRow = Prisma.ProductGetPayload<{ select: typeof PRODUCT_SELECT }>;

const num = (v: { toString(): string } | number | null | undefined): number => Number(v ?? 0);
const numOrNull = (v: { toString(): string } | number | null | undefined): number | null =>
  v == null ? null : Number(v);

function toSuggestionProduct(p: ProductRow, tenantId: string): OrderSuggestionProduct {
  const parent = tenantSafeParent(p.parent, tenantId);
  return {
    id: p.id,
    name: p.name,
    variantName: p.variantName ?? null,
    parentProductId: p.parentProductId ?? null,
    parent: parent ? { name: parent.name } : null,
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
 * Tenancy: the customer must belong to the caller's tenant and every read carries an explicit
 * tenantId. OrderItem.tenantId is nullable (legacy rows) and the tenant extension would drop those
 * lines, so the per-product count reads the base client and scopes THROUGH the order's tenantId;
 * order lines for "Order again" come nested under their (tenant-scoped) order.
 *
 * Banned products (a SellingRestriction that binds staff, surface ALL) are never suggested: the
 * order save's restriction engine (`evaluate`, the engine `checkLinesSellable` calls) decides, so a chip can never offer what saving refuses.
 */
@Injectable()
export class CustomerOrderSuggestionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly restrictions: SellingRestrictionsService,
  ) {}

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
    const [counts, orders] = await Promise.all([
      // The ranking happens in the database and is bounded: never a customer's whole history in memory.
      this.prisma.orderItem.groupBy({
        by: ["productId"],
        where: {
          productId: { not: null },
          status: { not: ItemStatus.CANCELLED },
          product: { tenantId, isActive: true },
          order: {
            tenantId,
            customerId,
            status: NOT_PLACED,
            // The business date when set, else the entry timestamp (a back-dated order counts when it happened).
            OR: [{ orderDate: { gte: since } }, { orderDate: null, createdAt: { gte: since } }],
          },
        },
        _count: { _all: true },
        orderBy: [{ _count: { productId: "desc" } }, { productId: "asc" }],
        take: USUALLY_BUYS_CANDIDATES,
      }),
      db.order.findMany({
        where: {
          tenantId,
          customerId,
          status: NOT_PLACED,
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

    const candidates: UsuallyBuysItem[] = [];
    for (const c of counts) {
      if (c.productId) candidates.push({ productId: c.productId, orderLineCount: c._count._all });
    }
    const wanted = [
      ...new Set([
        ...candidates.map((c) => c.productId),
        ...orders.flatMap((o) => o.lineItems.flatMap((l) => (l.productId ? [l.productId] : []))),
      ]),
    ];
    // L8: judged as the NEXT order would be (the tenant's model + the customer's stored path).
    const fulfilmentKind = await defaultSaleFulfilmentKind(this.prisma, tenantId, customerId);
    const banned = await this.bannedAmong(tenantId, customerId, wanted, fulfilmentKind);

    const usuallyBuys = candidates
      .filter((c) => !banned.has(c.productId))
      .slice(0, USUALLY_BUYS_LIMIT);
    const recentOrders: RecentOrderSummary[] = [];
    for (const o of orders) {
      const lines: RecentOrderLine[] = [];
      for (const l of o.lineItems) {
        if (!l.productId || banned.has(l.productId)) continue;
        lines.push({
          productId: l.productId,
          qty: num(l.qty),
          boxes: numOrNull(l.boxes),
          pieces: numOrNull(l.pieces),
          unitsPerBox: numOrNull(l.unitsPerBox),
          unitLabel: l.unitLabel ?? null,
        });
      }
      if (lines.length === 0) continue; // every line was banned: nothing to offer
      recentOrders.push({
        id: o.id,
        orderNumber: o.orderNumber ?? null,
        date: new Date(o.orderDate ?? o.createdAt).toISOString(),
        status: o.status,
        lines,
      });
    }

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
        select: PRODUCT_SELECT,
      });
      for (const p of rows) products[p.id] = toSuggestionProduct(p, tenantId);
    }

    return { customerId, usuallyBuys, recentOrders, products };
  }

  /**
   * The products the order-save helper would refuse for this customer today. Judged as STAFF (a
   * rule on the buyer portal only does not bind); a BLOCK or an INDETERMINATE answer (fail closed)
   * names each refused product.
   */
  private async bannedAmong(
    tenantId: string,
    customerId: string,
    productIds: string[],
    fulfilmentKind: SaleFulfilmentKind,
  ): Promise<Set<string>> {
    if (productIds.length === 0) return new Set();
    const evaluation = await this.restrictions.evaluate(
      tenantId,
      customerId,
      productIds.map((productId) => ({ productId })),
      { channel: "STAFF", fulfilmentKind },
    );
    if (evaluation.outcome !== "BLOCK" && evaluation.outcome !== "INDETERMINATE") return new Set();
    return new Set(evaluation.reasons.map((r) => r.productId));
  }
}
