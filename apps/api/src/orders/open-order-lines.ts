import type { OrderStatus } from "@prisma/client";
import { ACCRUAL_REVENUE_STATUSES, roundQty } from "../common/invoiced-sales";

/** Invoices that were actually issued: DRAFT/VOID are not sales, a WRITTEN_OFF invoice was billed. */
const ISSUED_STATUSES = { notIn: [...ACCRUAL_REVENUE_STATUSES.notIn] };

/** One order line of a product that can still owe an invoice, with what is left to bill. */
export interface OpenOrderLine {
  orderId: string;
  orderNumber: string | null;
  /** `orderDate ?? createdAt` — the business date of the order. */
  orderDate: Date;
  status: OrderStatus;
  customerId: string;
  customerName: string;
  orderItemId: string;
  /** Ordered qty in base units (pieces). */
  qty: number;
  /** Qty already on ISSUED invoices (never `OrderItem.invoicedQty`: a DRAFT invoice bumps it). */
  billedQty: number;
  /** `qty - billedQty`, always > 0 (billed-out lines are dropped). */
  remainingQty: number;
  /** The line's own sale-time split (raw, not the remainder's). */
  boxes: number | null;
  pieces: number | null;
  unitsPerBox: number | null;
  unitLabel: string | null;
  unitPrice: unknown;
  priceType: string | null;
}

export interface OpenOrderLinesQuery {
  tenantId: string;
  productId: string;
  customerId?: string | null;
  /** Which order statuses count: `OPEN_ORDER_STATUSES`, or `BACKING_ORDER_STATUSES` for price history. */
  statuses: OrderStatus[];
  /** Max ORDERS read (newest first); an order can hold several lines of the product. */
  take: number;
  /** Drop one order (the one being edited). */
  excludeOrderId?: string | null;
  /** Skip `counterSale: true` orders (they are paid on the spot, never "to bill"). */
  excludeCounterSales?: boolean;
}

/** The slice of the tenant-scoped Prisma client this helper reads. */
export interface OpenOrderLinesDb {
  order: { findMany(args: any): Promise<any[]> };
  invoice: { findMany(args: any): Promise<any[]> };
}

/**
 * The ONE read of "open, un-billed order lines of a product" (G4): used by the customer price
 * history (open orders as pseudo-sales) and by the product page's Open orders card.
 *
 * Newest order first (`orderDate ?? createdAt`). Lines on CANCELLED status are skipped. A line's
 * billed qty is the sum over ISSUED invoices only, read THROUGH Invoice with an explicit tenantId
 * (never top-level invoiceItem.findMany: lines with a null tenantId would be dropped), and never
 * `OrderItem.invoicedQty`, which a DRAFT invoice bumps. Fully billed lines drop.
 */
export async function openOrderLinesForProduct(
  db: OpenOrderLinesDb,
  q: OpenOrderLinesQuery,
): Promise<OpenOrderLine[]> {
  const { tenantId, productId, customerId, statuses, take } = q;
  const orders = await db.order.findMany({
    where: {
      tenantId,
      ...(customerId ? { customerId } : {}),
      status: { in: statuses },
      ...(q.excludeCounterSales ? { counterSale: false } : {}),
      lineItems: { some: { productId, status: { not: "CANCELLED" } } },
      ...(q.excludeOrderId ? { id: { not: q.excludeOrderId } } : {}),
    },
    orderBy: [
      { orderDate: { sort: "desc", nulls: "last" } },
      { createdAt: "desc" },
      { id: "desc" },
    ],
    take,
    select: {
      id: true,
      orderNumber: true,
      orderDate: true,
      createdAt: true,
      status: true,
      customerId: true,
      customer: { select: { id: true, businessName: true } },
      lineItems: {
        where: { productId, status: { not: "CANCELLED" } },
        select: {
          id: true,
          unitPrice: true,
          priceType: true,
          boxes: true,
          pieces: true,
          unitsPerBox: true,
          unitLabel: true,
          qty: true,
        },
      },
    },
  });

  const lineIds = orders.flatMap((o: any) => (o.lineItems ?? []).map((l: any) => l.id));
  const billed = new Map<string, number>();
  if (lineIds.length > 0) {
    const billedInvoices = await db.invoice.findMany({
      where: {
        tenantId,
        status: ISSUED_STATUSES,
        items: { some: { orderItemId: { in: lineIds } } },
      },
      select: {
        items: {
          where: { orderItemId: { in: lineIds } },
          select: { orderItemId: true, qty: true },
        },
      },
    });
    for (const inv of billedInvoices as any[]) {
      for (const b of inv.items ?? []) {
        billed.set(b.orderItemId, (billed.get(b.orderItemId) ?? 0) + Number(b.qty));
      }
    }
  }

  const out: OpenOrderLine[] = [];
  for (const ord of orders as any[]) {
    for (const it of ord.lineItems ?? []) {
      const billedQty = billed.get(it.id) ?? 0;
      const remainingQty = roundQty(Number(it.qty) - billedQty);
      if (!(remainingQty > 0)) continue;
      out.push({
        orderId: ord.id,
        orderNumber: ord.orderNumber ?? null,
        orderDate: new Date(ord.orderDate ?? ord.createdAt),
        status: ord.status,
        customerId: ord.customerId ?? ord.customer?.id,
        customerName: ord.customer?.businessName ?? "",
        orderItemId: it.id,
        qty: Number(it.qty),
        billedQty,
        remainingQty,
        boxes: it.boxes ?? null,
        pieces: it.pieces ?? null,
        unitsPerBox: it.unitsPerBox ?? null,
        unitLabel: it.unitLabel ?? null,
        unitPrice: it.unitPrice,
        priceType: it.priceType ?? null,
      });
    }
  }
  return out;
}
