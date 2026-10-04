/**
 * Customer + product price history (step 2A). Served by
 * `GET /customers/:customerId/products/:productId/price-history?limit=25` (max 100), newest first.
 *
 * Staff-only (OPERATOR / TENANT_ADMIN); never buyers or drivers. Every money figure is rounded
 * to cents on the server. Rows show the billed price; credits and returns are not netted. Cost fields are filled only when `costVisible` is true — the server
 * sends `null` (never the value) to a role that cannot see cost.
 */

/** INVOICE = a line on a real (non-draft, non-void, non-written-off) invoice; OPEN_ORDER = an open order line not yet invoiced. */
export type PriceHistorySource = "INVOICE" | "OPEN_ORDER";

export interface PriceHistoryRow {
  /** ISO timestamp: the invoice issue date, or the open order's business date (orderDate, else createdAt). */
  date: string;
  source: PriceHistorySource;
  /** Price per `unitLabel` (per case for a case line, per piece for a piece line). */
  unitPrice: number;
  /** The unit `unitPrice` is quoted in ("Case", "Each", a product unit noun, …). */
  unitLabel: string;
  /** Pieces per unit when the unit is a pack (> 1), else null. */
  unitsPerBox: number | null;
  /** Quantity in `unitLabel` units (e.g. 5 cases), not raw pieces. */
  qty: number;
  boxes: number | null;
  pieces: number | null;
  /** The product's average cost at `date`, in the SAME unit as `unitPrice` (piece cost x unitsPerBox for a case line). Null when hidden or unknown. */
  avgCostAtSale: number | null;
  invoiceId: string | null;
  invoiceNumber: string | null;
  orderId: string;
  orderNumber: string;
  /** STANDARD | SPECIAL | DISCOUNTED | MANUAL | PROMO. */
  priceType: string | null;
}

/** One entry per `unitLabel`, so units are never mixed. Computed over the returned rows. */
export interface PriceHistorySummary {
  unitLabel: string;
  /** Newest row's price in this unit (invoice or open order). */
  last: number | null;
  low: number | null;
  high: number | null;
  /** Quantity on INVOICE rows only (open orders are not sold yet). */
  qtySold: number;
  /** The product's CURRENT average cost per `unitLabel`. Null when hidden or unknown. */
  currentAvgCost: number | null;
}

/** v1.1: reference prices in the NEWEST row's unit. Any member is null when it cannot be known. */
export interface PriceHistoryReferences {
  /** The product's list price (tier 1) in the row unit. */
  listPrice: number | null;
  /** The customer's current tier / special price in the row unit (the order-create resolver). */
  tierPrice: number | null;
  /** (last - previous) / previous for the same unit, 4 decimal places; null with < 2 rows or a 0 previous. */
  changeSinceLast: number | null;
}

/**
 * v1.1 `?compare=all`: anonymous aggregate of OTHER customers' invoiced sales of the product in the
 * last 180 days, in the most common unit. Never carries a customer name or id; null (on the
 * response) when fewer than 3 other customers bought it.
 */
export interface PriceHistoryAggregate {
  low: number;
  median: number;
  high: number;
  /** Count of distinct other customers behind the figures (always >= 3). */
  customers: number;
  unitLabel: string;
}

/** One product in `GET /customers/:customerId/price-summary`. */
export interface PriceSummaryEntry {
  last3: { date: string; unitPrice: number; unitLabel: string }[];
  low: number | null;
  high: number | null;
}

export type PriceSummaryResponse = Record<string, PriceSummaryEntry>;

export interface PriceHistoryResponse {
  customerId: string;
  customerName: string;
  productId: string;
  productName: string;
  /** False => every cost field is null by design (the caller's role may not see cost). */
  costVisible: boolean;
  rows: PriceHistoryRow[];
  summaries: PriceHistorySummary[];
  /** v1.1 */
  references: PriceHistoryReferences;
  /** v1.1: present only with `?compare=all` (null = too few other customers). */
  aggregate?: PriceHistoryAggregate | null;
}
