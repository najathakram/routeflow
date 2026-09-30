// ─── Insights: product sales facts (#2118 / plan 2105-a) ──────────────────────
//
// Shapes for `GET /analytics/products/:id/insights`, `/analytics/products/:id/sales`
// and `/analytics/products/:id/insights.csv` (apps/api/src/sales-facts/). Read-only
// response DTOs shared by web and mobile — never redeclare one locally.
//
// Conventions every field below follows:
// - Money is rounded to cents server-side (`roundMoney`, @routeflow/pricing). Never
//   re-derive a line total from qty × unitPrice (a boxed line's unitPrice is a BOX price).
// - Quantities are PIECES (the base unit), rounded to 3dp. A line's pieces come from its OWN
//   stored evidence (a boxes/pieces split, or its sale-time pack snapshot) — never from the
//   product's pack today. A line whose pieces cannot be known (a boxed line stored without a
//   split: its qty may count boxes) adds revenue only and is counted in
//   `unresolvedSaleLines`, never guessed into pieces or a per-piece price.
// - Calendar days are "YYYY-MM-DD" strings in the tenant's calendar: an invoice counts on
//   its `issueDate`; a credit note on the tenant-local day of its `createdAt`; an external
//   refund on the tenant-local day of its `refundedAt`.
// - `basis: "accrual_net"`: DRAFT and VOID invoices are excluded; WRITTEN_OFF invoices ARE
//   sales (badged via `writtenOff`); credits net on their own date, never on payment.

import type { ProductSaleLine } from "./products";

/** Bucket sizes for a series. Weeks start on Monday (ISO-8601); quarters on Jan/Apr/Jul/Oct 1. */
export const INSIGHT_GRAIN_VALUES = ["day", "week", "month", "quarter"] as const;
export type InsightGrain = (typeof INSIGHT_GRAIN_VALUES)[number];

/** The revenue basis every insights figure is computed on. */
export type InsightBasis = "accrual_net";

/** Limits the API enforces on a window (400 when exceeded). */
export const INSIGHT_MAX_WINDOW_MONTHS = 36;
export const INSIGHT_MAX_BUCKETS = 400;
/** Most lines one CSV export streams before it writes a truncation row. */
export const INSIGHT_CSV_MAX_LINES = 50_000;
/** Buyers returned by default (`?buyers=all` returns every buyer). */
export const INSIGHT_TOP_BUYERS = 50;

/** The resolved window a response was computed for (defaults filled in). */
export interface InsightWindow {
  /** First calendar day, inclusive. */
  from: string;
  /** Last calendar day, inclusive. */
  to: string;
  grain: InsightGrain;
  /** IANA zone used to place credit/refund instants on calendar days ("UTC" when unset). */
  timezone: string;
}

export interface ProductInsightsProduct {
  id: string;
  name: string;
  sku: string | null;
  /** Retail-unit (piece) code; null means the piece shares `sku`. */
  unitSku: string | null;
  /** Case barcode. */
  barcode: string | null;
  /** CURRENT pack size — use only to display pieces as boxes + pieces, labelled "at the
   *  current pack". Historical selling units come from each line's own snapshot. */
  unitsPerBox: number | null;
  /** The product's unit name (`Product.unit`). */
  unitLabel: string;
  /** False for a deactivated product: its history stays reachable by id. */
  isActive: boolean;
}

export interface ProductInsightsTotals {
  /** Σ pieces on invoiced lines in the window whose piece count is known. */
  invoicedQtyPieces: number;
  /** Invoiced lines in the window whose piece count is unknown (a boxed line stored without a
   *  boxes/pieces split — its qty may count boxes). Their revenue is in `lineGross`; they are
   *  NOT in any pieces figure or per-piece price. */
  unresolvedSaleLines: number;
  /** Σ pieces on returns whose netting event (external refund, or a non-VOID credit note)
   *  falls in the window. */
  returnedQtyPieces: number;
  /** Return lines in the window whose unit could not be resolved to pieces: a STANDARD return
   *  is typed in the order line's own unit (B665) and a box-unaware line's pack is never
   *  guessed. NOT counted in `returnedQtyPieces`; their money still nets (credits). */
  unresolvedReturnLines: number;
  /** invoicedQtyPieces − returnedQtyPieces. */
  netQtyPieces: number;
  /** Σ qty ÷ the line's own sale-time pack, over lines with pieces > 0 whose pack is known.
   *  Lines whose pack is unknown count in pieces only (see `legacyLines`). When
   *  `mixedPackSizes` is true this sums different pack sizes — lead with pieces. */
  sellingUnits: number;
  /** The one sale-time pack size every known-pack line shares (1 = sold by the piece);
   *  null when there are none or when `mixedPackSizes`. */
  sellingUnitPack: number | null;
  /** Lines whose sale-time pack is unknown (no snapshot and a boxed product, a split with no
   *  snapshot, or a boxed snapshot with no boxes/pieces split). Never in `sellingUnits`; in
   *  pieces only when their piece count is known (see `unresolvedSaleLines`). */
  legacyLines: number;
  /** True when known-pack lines were sold in more than one pack size. */
  mixedPackSizes: boolean;
  /** Σ line subtotals (pre-tax, after line discounts). */
  lineGross: number;
  /** Credits attributed to this product's lines from stored line facts: credit-note line
   *  items, and inline-return line subtotals on external refunds. */
  attributedCredits: number;
  /** lineGross − attributedCredits. Never clamped. */
  lineNet: number;
  /** Reported beside `lineNet`, never subtracted from it and never prorated: the amount-only
   *  credits in the window on this product's invoices or returns — a credit note with no line
   *  items (or the part of one its items do not cover), a note minted for a return of it, a
   *  STANDARD external refund, the tax part of an INLINE one — plus a line item whose invoice
   *  line id no longer exists. A line-itemized credit attributes through its items (to this or
   *  another product, or an unlisted line) and is never here. A credit touching several
   *  products appears on each, so these do NOT sum across products. */
  unattributedCredits: number;
  /** Distinct invoices with a line of this product in the window. */
  invoices: number;
  /** Distinct purchase events: one per order (however many invoices it was billed on), plus
   *  one per invoice raised without an order. */
  orders: number;
  /** Distinct buyers. */
  buyers: number;
  /** LIFETIME first / most recent sale day (not window-scoped): null when never sold.
   *  Distinguishes "never sold" from "nothing in this window". */
  firstSaleAt: string | null;
  lastSaleAt: string | null;
}

export interface ProductInsightsLastSale {
  /** Price charged per selling unit on that line (a box price on a boxed line). */
  unitPrice: number;
  /** The line's own unit name when it was sold in a named unit, else null. */
  unitLabel: string | null;
  /** The line's sale-time pack (pieces per selling unit); null when unknown. */
  unitsPerBox: number | null;
  /** Effective price per piece: line subtotal ÷ pieces. */
  perPiece: number;
  date: string;
  customerId: string;
  customer: string;
}

export interface ProductInsightsPrice {
  /** Σ subtotal ÷ Σ pieces over lines with known pieces > 0 (revenue-weighted; includes promo
   *  free units, so it is the EFFECTIVE price). Null when nothing sold. */
  avgPerPiece: number | null;
  /** Σ subtotal ÷ Σ selling units over known-pack lines. Null when none. A blend when
   *  `mixedPackSizes` — lead with `avgPerPiece` then. */
  avgPerSellingUnit: number | null;
  /** Newest line in the window with known pieces > 0 (the sales-page order). */
  last: ProductInsightsLastSale | null;
  /** Lowest / highest effective per-piece line price in the window — one axis, never a
   *  box price next to a piece price. */
  minPerPiece: number | null;
  maxPerPiece: number | null;
}

export interface ProductInsightsSeriesPoint {
  /** Bucket start day. The first/last bucket may extend past the window; only days inside
   *  the window are counted. */
  date: string;
  qtyPieces: number;
  returnedQtyPieces: number;
  lineGross: number;
  /** Attributed credits dated in this bucket. */
  credits: number;
  lineNet: number;
  avgPerPiece: number | null;
}

export interface ProductInsightsBuyer {
  customerId: string;
  /** Stored business name — renders for a deleted customer too. */
  name: string;
  qtyPieces: number;
  lineGross: number;
  /** lineGross − credits attributed to this buyer's lines in the window. */
  lineNet: number;
  /** Purchase events (see `ProductInsightsTotals.orders`). */
  orders: number;
  /** Most recent purchase day in the window; null for a buyer present only through a credit. */
  lastDate: string | null;
  lastPerPiece: number | null;
  avgPerPiece: number | null;
  /** lineGross ÷ totals.lineGross (0–1, 4dp); 0 when the window's gross is 0. */
  share: number;
}

export interface ProductInsightsResponse {
  product: ProductInsightsProduct;
  window: InsightWindow;
  basis: InsightBasis;
  totals: ProductInsightsTotals;
  price: ProductInsightsPrice;
  /** One point per bucket, zero-filled. */
  series: ProductInsightsSeriesPoint[];
  /** Top buyers by lineGross (all of them with `?buyers=all`). */
  buyers: ProductInsightsBuyer[];
  /** Total distinct buyers, including any cut from `buyers`. */
  buyersTotal: number;
}

export interface ProductInsightsQuery {
  /** "YYYY-MM-DD". Default: the first day of the month eleven months before `to`. */
  from?: string;
  /** "YYYY-MM-DD". Default: today in the tenant's timezone. */
  to?: string;
  /** Default: day up to 62 days, week up to 184 days (~6 months), else month. */
  grain?: InsightGrain;
  /** "all" returns every buyer (export); default is the top 50. */
  buyers?: "all";
}

/** One row of `GET /analytics/products/:id/sales`: the product-sales line plus its netting
 *  facts, each tied to THIS line by a stored fact (any date). A credit or return that no
 *  stored fact ties to a line shows only in the product totals. */
export interface ProductInsightSaleLine extends ProductSaleLine {
  /** The invoice line id — stable row key. */
  lineId: string;
  /** Always present on this endpoint (optional only on the legacy shape). */
  writtenOff: boolean;
  unitLabel: string | null;
  /** Effective price per piece (subtotal ÷ pieces); null for a zero-quantity line and for a line
   *  whose piece count is unknown (see `ProductInsightsTotals.unresolvedSaleLines`). */
  perPiece: number | null;
  /** Σ non-VOID credit-note line items on this line. */
  creditedAmount: number;
  /** Pieces returned against this line with a netting event. Exact for INLINE returns (they
   *  record their source line); a STANDARD return records none and counts only in totals. */
  returnedQty: number;
}

export interface ProductSalesPageQuery {
  from?: string;
  to?: string;
  customerId?: string;
  /** Opaque cursor from the previous page's `nextCursor`. */
  cursor?: string;
  /** Lines per page, 1-500 (default 100). Pages count LINES, never invoices. */
  limit?: number;
}

export interface ProductSalesPage {
  productId: string;
  window: InsightWindow;
  /** Newest first by issue date, then invoice (entry time, id), then line (entry time, id) — a
   *  stable paging order that never overlaps or skips between pages. NOT the invoice's printed
   *  line order. */
  lines: ProductInsightSaleLine[];
  /** Null on the last page. */
  nextCursor: string | null;
}
