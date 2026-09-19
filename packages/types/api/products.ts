// ─── Products / inventory / stock-count (wave E / imp-10b) ─────────────────────

export interface InventoryValuation {
  totalValue: number;
  productCount: number;
  missingCostCount: number;
  missingCostProducts: { id: string; name: string }[];
}

export interface RecomputeCostsResult {
  dryRun: boolean;
  processed: number;
  updated: number;
  noHistory: { productId: string; name: string }[];
  results: {
    productId: string;
    name: string;
    oldAvgCost: number | null;
    newAvgCost: number | null;
    stockDrift: number;
    movementsBackfilled: number;
  }[];
}

/** Out of the sweep's `lib/api` scope (this lives in each app's `stock-count-logic.ts`,
 *  not `lib/api/stock-count.ts`) — kept here only so `CommitStockCountPayload` below has
 *  an accurate item shape; web/mobile's own local declarations are left as-is. */
export type StockCountMode = "REPLACE" | "ADD";

export interface CommitStockCountItem {
  productId: string;
  quantity: number;
  mode: StockCountMode;
}

export interface CommitStockCountPayload {
  sessionId: string;
  items: CommitStockCountItem[];
  notes?: string;
  effectiveDate?: string;
}

export interface CommitStockCountResponse {
  sessionId: string;
  reference: string;
  applied: number;
  skipped: number;
  movementIds: string[];
}

/** Near-identical: web's `reference` is nullable, mobile's is required —
 *  nullable widening wins. */
export interface CommitStockCountSessionResponse {
  sessionId: string;
  reference: string | null;
  applied: number;
  skipped: number;
  movementIds: string[];
  costMovementIds?: string[];
  alreadyCommitted?: boolean;
}

/** Near-identical: web's `variantName` is required, mobile's is optional/nullable —
 *  nullable widening wins. */
export interface VariantAssignResultItem {
  productId: string;
  variantName?: string | null;
  qty: number;
  unitCost: number;
  created: boolean;
}

export interface VariantAssignResult {
  reference: string;
  parentProductId: string;
  parentRemaining: number;
  assignments: VariantAssignResultItem[];
  movementIds: string[];
}

/** Per-buyer sales history for the product-detail Sales card. Backed by
 *  `GET /analytics/product-sales/:productId?limit=` — reads INVOICED sales only
 *  (DRAFT/VOID/WRITTEN_OFF excluded), newest first. `lineTotal`/`unitPrice` are
 *  authoritative — never re-derive from qty × unitPrice (would over-charge a
 *  boxed line by `unitsPerBox`). */
export interface ProductSaleLine {
  /** ISO issue date of the invoice this line was billed on. */
  date: string;
  invoiceId: string;
  invoiceNumber: string;
  /** Null when the invoice was raised directly rather than from an order. */
  orderId: string | null;
  /** Human order number for `orderId`; null when the invoice had no order. */
  orderNumber: string | null;
  customerId: string;
  /** Stored name — renders even for a deleted/renamed customer. */
  customerName: string;
  /** Base units (pieces) sold on this line. */
  qty: number;
  /** Sale-time box split, for "N boxes + M pcs". Null when not boxed. */
  boxes: number | null;
  pieces: number | null;
  unitsPerBox: number | null;
  /** Net price actually charged per selling unit. */
  unitPrice: number;
  /** Authoritative line total — never re-derived from qty × unitPrice. */
  lineTotal: number;
  /** Struck-through list price when this line was re-priced, else null. */
  originalPrice: number | null;
  /** True when the line carries a non-STANDARD price (override/promo/tier). */
  overridden: boolean;
}

export interface ProductSalesSummary {
  /** Number of invoiced lines. */
  count: number;
  /** Distinct buyers who bought it. */
  buyers: number;
  /** Σ base units. */
  totalQty: number;
  /** Σ line subtotals. */
  totalRevenue: number;
  /** Per-unit price extremes across the returned lines; null when empty. */
  minPrice: number | null;
  maxPrice: number | null;
  /** Revenue-weighted (Σsubtotal / Σqty), NOT a mean of the unit prices — a
   *  100-unit sale moves this more than a 1-unit sale. Null when no units sold. */
  avgPrice: number | null;
}

export interface ProductSalesHistory {
  productId: string;
  lines: ProductSaleLine[];
  summary: ProductSalesSummary;
}

// ─── Multi-level units (2026-09-19) ─────────────────────────────────────────────
// See local-assets/handoff/2026-09-18/PLAN-units-po-MINIMAL.md §1. A product with
// no levels behaves exactly as it does today — Product.unitsPerBox/pricePerUnit
// + tiers stay the pack.

export interface ProductUnitLevel {
  id: string;
  label: string;
  factorToBase: number;
  price: number | null;
  priceTier2: number | null;
  priceTier3: number | null;
  priceTier4: number | null;
  priceTier5: number | null;
  isDefaultSelling: boolean;
  sortOrder: number;
}

export interface PutProductUnitsPayload {
  units: Array<Omit<ProductUnitLevel, "id"> & { id?: string }>;
}

// ─── Multi-category labels (2026-09-19) ─────────────────────────────────────────
// See local-assets/handoff/2026-09-18/PLAN-categories-jurisdiction-bans.md §1.

export interface ProductLabelRef {
  id: string;
  name: string;
}

export interface ProductLabelsView {
  own: ProductLabelRef[];
  inherited: ProductLabelRef[];
  excluded: Array<ProductLabelRef & { reason: string; inert: boolean }>;
  effective: ProductLabelRef[];
}

export interface PutProductLabelsPayload {
  include: string[];
  exclude: Array<{ categoryId: string; reason: string }>;
}

export interface ProductCategoryDto {
  id: string;
  name: string;
  archivedAt: string | null;
}
