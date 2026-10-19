import type { OrderStatus } from "@prisma/client";

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

/** STUB (test-first): replaced by the real read in the next commit. */
export async function openOrderLinesForProduct(
  _db: OpenOrderLinesDb,
  _q: OpenOrderLinesQuery,
): Promise<OpenOrderLine[]> {
  return [];
}
