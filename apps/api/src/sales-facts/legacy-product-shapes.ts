import type { DemandGranularity, DemandRange } from "../analytics/demand-range";

/**
 * The response shapes of the two legacy per-product analytics reads,
 * `GET /analytics/product-sales/:productId` and `GET /analytics/demand/:productId`. Moved here
 * unchanged from `analytics.service.ts` (which re-exports them) when their producers moved into
 * `ProductInsightsService` (#2118); `ProductSaleLine` gained only the `writtenOff` badge.
 */

/** One bucket of the per-product demand series. Both metrics ship together. */
export interface ProductDemandBucket {
  /** Bucket START, "YYYY-MM-DD". Never an ISO timestamp — see demand-range.ts. */
  date: string;
  /** Total base units (pieces) invoiced in this bucket. */
  units: number;
  /** Net invoiced sales in this bucket (line subtotals, pre-tax). */
  revenue: number;
}

/** One invoiced sale of a product to one buyer — a row of the Sales tab. */
export interface ProductSaleLine {
  /** The sale's business date (parent invoice `issueDate`), ISO. */
  date: string;
  invoiceId: string;
  invoiceNumber: string;
  /** Null when the invoice was raised directly rather than from an order. */
  orderId: string | null;
  /** The human order number for `orderId`. Null alongside a null orderId — the
   *  UI must never fall back to slicing the uuid, which reads as noise. */
  orderNumber: string | null;
  customerId: string;
  customerName: string;
  /** Base units (pieces) — `Number(item.qty)`, the same basis demand uses. */
  qty: number;
  /** Sale-time box split, for rendering "N boxes + M pcs". Null when not boxed. */
  boxes: number | null;
  pieces: number | null;
  unitsPerBox: number | null;
  /** Net price actually charged per selling unit. */
  unitPrice: number;
  /** Authoritative line total — never re-derived from qty × unitPrice. */
  lineTotal: number;
  /** The struck-through list price when this line was re-priced, else null. */
  originalPrice: number | null;
  /** True when the line carries a non-STANDARD price (override/promo/tier). */
  overridden: boolean;
  /** #2118: the invoice was written off — still a sale on the accrual basis, badged. */
  writtenOff: boolean;
}

export interface ProductSalesHistory {
  productId: string;
  lines: ProductSaleLine[];
  summary: {
    /** Number of invoiced lines. */
    count: number;
    /** Distinct buyers who bought it. */
    buyers: number;
    /** Σ base units. */
    totalQty: number;
    /** Σ line subtotals. */
    totalRevenue: number;
    /** Per-unit price extremes/average across the returned lines; null when empty. */
    minPrice: number | null;
    maxPrice: number | null;
    /** Revenue-weighted, not a mean of unit prices — a 100-unit sale should
     *  move the average more than a 1-unit sale. Null when no units sold. */
    avgPrice: number | null;
  };
}

export interface ProductDemandSeries {
  productId: string;
  range: DemandRange;
  granularity: DemandGranularity;
  /** ISO, inclusive. */
  from: string;
  /** ISO, EXCLUSIVE. */
  to: string;
  buckets: ProductDemandBucket[];
  totals: { units: number; revenue: number };
  /** False ⇒ never invoiced at any date: "never sold", not "zero this window". */
  hasAnySales: boolean;
  /** "YYYY-MM-DD" of this product's first / most recent invoiced sale. */
  firstSaleAt: string | null;
  lastSaleAt: string | null;
}
