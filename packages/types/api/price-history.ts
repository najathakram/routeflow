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
  /**
   * `salePackOf`'s answer for this line, sent verbatim: 1 = by the piece, > 1 = pieces per pack, null = cannot be
   * known (a pre-snapshot line). `unitsPerBox` is its > 1 projection and is null for BOTH 1 and unknown, so a reader
   * that must tell them apart reads this (SA-1004).
   */
  salePack: number | null;
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
  /** (the customer's last price - the one before it) / the one before it, same unit, 4 decimal places; not today's price. Null with < 2 rows or a 0 previous. */
  changeSinceLast: number | null;
}

/** One month of a reference line: `month` is "YYYY-MM" (UTC), `average` is the monthly mean in the line's unit. */
export interface PriceHistoryAveragePoint {
  month: string;
  average: number;
}

/**
 * One plot unit's two reference lines (SA-954 D4), next to this customer's own line. `unitsPerBox` follows
 * `PriceHistoryRow`'s rule: pieces per unit, null = by the piece. Only months that have a sale are sent, oldest first
 * (nothing carried or filled in for an empty month), and the read has no date bound. A line whose pack cannot be read
 * is left out of `converted`. An OPERATOR denied both ORDERS and FINANCE gets only months backed by 3 or more distinct
 * OTHER buyers (W-1058 H-2.10).
 */
export interface PriceHistoryComparisonLine {
  unitLabel: string;
  unitsPerBox: number | null;
  /** Line 2: OTHER customers' lines in this unit name and pack, the monthly mean of the line price. Oldest first. */
  likeForLike: PriceHistoryAveragePoint[];
  /** Line 3: ALL customers' known-pack lines in any unit, converted to this unit (one rounding). Oldest first. */
  converted: PriceHistoryAveragePoint[];
}

/**
 * `?compare=all`: anonymous aggregate of OTHER customers' invoiced sales of the product in the 180 days counted back
 * from the NEWEST sale to another customer (not from today), in the most common unit. Never carries a customer name or
 * id; null (on the response) when no other customer bought it. An OPERATOR denied both ORDERS and FINANCE still gets
 * it only with 3 or more distinct other customers behind it (W-1058 H-2.10).
 */
export interface PriceHistoryAggregate {
  low: number;
  median: number;
  high: number;
  /** Count of distinct other customers behind the figures. */
  customers: number;
  unitLabel: string;
  /** The month ("YYYY-MM", UTC) of the newest sale to another customer: the window's end, so the panel says how old it is. */
  newestMonth: string;
}

/** `GET /customers/:customerId/price-summary` refuses more than this many distinct product ids. */
export const PRICE_SUMMARY_MAX_PRODUCTS = 50;

/** One product in `GET /customers/:customerId/price-summary`. */
export interface PriceSummaryEntry {
  /**
   * The newest sales, each in ITS OWN unit AND pack size (`unitsPerBox`, null = unknown / sold by the
   * piece). A chip may only be offered for a line whose pack matches the row's own, never the entry's.
   * `salePack` as on `PriceHistoryRow` (1 piece, > 1 pack, null unknown); absent from an older server.
   */
  last3: {
    date: string;
    unitPrice: number;
    unitLabel: string;
    unitsPerBox: number | null;
    salePack?: number | null;
  }[];
  /** Low / high of the NEWEST sale's unit group only (never units mixed); null with no sales. */
  low: number | null;
  high: number | null;
  /** The unit `low` / `high` are in (the newest sale's), so the figures carry their unit. */
  unitLabel: string | null;
  unitsPerBox: number | null;
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
  /** v1.1: present only with `?compare=all` (null = no other customer bought it, or fewer than the floor an OPERATOR denied ORDERS and FINANCE keeps). */
  aggregate?: PriceHistoryAggregate | null;
  /**
   * SA-954: present only with `?compare=all`, one entry per plot unit (this customer's units; with no history, the
   * summary's unit). Absent from an older server, which the web reads as empty.
   */
  comparison?: PriceHistoryComparisonLine[];
}
