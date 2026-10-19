import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { normalizeBoxesPieces } from "@routeflow/pricing";
import type { OrderStatusValue, ProductOpenOrderLine, ProductOpenOrders } from "@routeflow/types";
import { roundQty } from "../common/invoiced-sales";
import { OPEN_ORDER_STATUSES } from "../invoices/credit-exposure";
import { openOrderLinesForProduct } from "../orders/open-order-lines";
import { PrismaService } from "../prisma/prisma.service";

export const OPEN_ORDERS_DEFAULT_LIMIT = 200;
export const OPEN_ORDERS_MAX_LIMIT = 500;

/** `?limit=` for the open-orders card: clamped 1-500, default 200 (same rule as product-sales). */
export function clampOpenOrdersLimit(raw: unknown): number {
  const parsed = raw != null && String(raw).trim() !== "" ? Number(raw) : NaN;
  return Number.isFinite(parsed)
    ? Math.min(OPEN_ORDERS_MAX_LIMIT, Math.max(1, Math.trunc(parsed)))
    : OPEN_ORDERS_DEFAULT_LIMIT;
}

/**
 * Orders that still have a product to be billed (the product page's "Open orders" card). Operational,
 * not analytics. The read itself is `openOrderLinesForProduct`, shared with the customer price history.
 */
@Injectable()
export class ProductOpenOrdersService {
  constructor(private readonly prisma: PrismaService) {}

  async getOpenOrders(productId: string, limit: number): Promise<ProductOpenOrders> {
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) throw new BadRequestException("A tenant context is required.");
    const db = this.prisma.forTenant();
    const product = await db.product.findFirst({
      where: { id: productId, tenantId },
      select: { id: true },
    });
    if (!product) throw new NotFoundException("Product not found");

    // Over-read orders (billed-out lines drop); the cut to `limit` lines is made below.
    const found = await openOrderLinesForProduct(db as never, {
      tenantId,
      productId,
      statuses: OPEN_ORDER_STATUSES,
      take: limit * 2,
      excludeCounterSales: true,
    });
    const kept = found.slice(0, limit);

    const lines: ProductOpenOrderLine[] = kept.map((l) => {
      // The remainder is split by the line's OWN pack snapshot, never the live product's.
      const split = normalizeBoxesPieces({ qty: l.remainingQty, unitsPerBox: l.unitsPerBox });
      return {
        orderId: l.orderId,
        orderNumber: l.orderNumber,
        status: l.status as OrderStatusValue,
        orderDate: l.orderDate.toISOString(),
        customerId: l.customerId,
        customerName: l.customerName,
        qty: l.qty,
        remainingQty: l.remainingQty,
        boxes: split.boxes,
        pieces: split.pieces,
        unitsPerBox: l.unitsPerBox == null ? null : Number(l.unitsPerBox),
        unitLabel: l.unitLabel,
      };
    });

    return {
      productId,
      lines,
      summary: {
        orders: new Set(lines.map((l) => l.orderId)).size,
        customers: new Set(lines.map((l) => l.customerId)).size,
        totalQty: roundQty(lines.reduce((sum, l) => sum + l.remainingQty, 0)),
      },
      truncated: found.length > limit,
    };
  }
}
