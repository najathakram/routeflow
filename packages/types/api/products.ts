// ─── Products / inventory / stock-count (wave E / imp-10b) ─────────────────────

import type {
  BarcodeOrigin,
  BarcodeSymbology,
  OrderStatusValue,
  PackagingLevel,
  RecipeStatus,
} from "./enums";
import type { API_ERROR_CODES } from "./error-codes";

/** #2717 M1: a product barcode as the product read model returns it. `origin: "LEGACY"` = synthesized from the legacy
 *  Product.barcode column for a product with no ProductBarcode rows yet (never persisted). */
export interface ProductBarcodeView {
  code: string;
  level: PackagingLevel;
  symbology: BarcodeSymbology;
  origin: BarcodeOrigin | "LEGACY";
  copiedFromLevel: PackagingLevel | null;
  primaryFor: PackagingLevel | null;
}

/** #2717 M4a-1: which code a scan hit and the packaging levels that code has on the resolved product
 *  (additive on the scan-lookup response; a shared code reports both levels). */
export interface ScanMatchView {
  code: string;
  levels: PackagingLevel[];
}

/** #2717 M1: a product image as the product read model returns it (`origin: "LEGACY"` = synthesized from imageKeys). */
export interface ProductImageView {
  storageKey: string;
  url: string | null;
  focalX: number | null;
  focalY: number | null;
  sortOrder: number;
  isPrimary: boolean;
  altText: string | null;
  origin: "ROW" | "LEGACY";
}

export interface InventoryValuation {
  totalValue: number;
  productCount: number;
  missingCostCount: number;
  missingCostProducts: { id: string; name: string }[];
}

export interface RecomputeCostsResult {
  /** B562 PR-3: true unless the caller sent `dryRun: false` — dry run is the default. */
  dryRun: boolean;
  processed: number;
  /** Products whose average this call corrected (always 0 on a dry run). */
  updated: number;
  noHistory: { productId: string; name: string }[];
  /** B562: products whose StockMovement ledger can't account for their real
   *  currentStock — the replay would run on a wrong stock balance, so nothing
   *  is written for these; `stockDrift` is the unaccounted quantity. */
  gapsDetected: { productId: string; name: string; stockDrift: number }[];
  /** B562 PR-3 (SA-136 §4): per product, the replayed average and — on an apply that changed it —
   *  the id of the one appended COST_BASIS correction row. No existing row is ever rewritten. */
  results: {
    productId: string;
    name: string;
    gap: number;
    oldAvgCost: number | null;
    newAvgCost: number | null;
    correctionId: string | null;
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
  /** "Finish with skips" (SA-767 L-2.4 C): lines left out because the product can never be counted
   *  (a product family now, or deleted). Empty on a normal commit. */
  skippedProducts?: Array<{ productId: string; name?: string; reason: string }>;
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
 *  (DRAFT/VOID excluded; WRITTEN_OFF included and badged via `writtenOff`, #2118),
 *  newest first, at most `limit` LINES. `lineTotal`/`unitPrice` are
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
  /** True when the invoice was written off — still a sale (accrual basis), badged.
   *  Optional so older fixtures stay valid; the API always sends it. */
  writtenOff?: boolean;
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

/** One open order line of a product: what is still to be billed. Backed by
 *  `GET /products/:id/open-orders`. "Open" = `OPEN_ORDER_STATUSES` (PENDING, CONFIRMED,
 *  OUT_FOR_DELIVERY); counter sales and cancelled lines are excluded. No money fields. */
/** The statuses on the open-orders card: the api's OPEN_ORDER_STATUSES plus PARTIALLY_DELIVERED for this card (owner 2026-10-19). */
export type OpenOrderStatusValue = Extract<
  OrderStatusValue,
  "PENDING" | "CONFIRMED" | "OUT_FOR_DELIVERY" | "PARTIALLY_DELIVERED"
>;

export interface ProductOpenOrderLine {
  orderId: string;
  orderNumber: string | null;
  /** Only the open statuses reach this card (the api's OPEN_ORDER_STATUSES, credit-exposure.ts). */
  status: OpenOrderStatusValue;
  /** ISO business date of the order (`orderDate ?? createdAt`). */
  orderDate: string;
  customerId: string;
  customerName: string;
  /** Ordered qty, base units (pieces). */
  qty: number;
  /** Still to come, always > 0: `qty` minus ISSUED-invoice qty; for a PARTIALLY_DELIVERED order, `qty` minus the delivered qty. */
  remainingQty: number;
  /** `remainingQty` split by the line's own `unitsPerBox` snapshot; null when not boxed. */
  boxes: number | null;
  pieces: number | null;
  unitsPerBox: number | null;
  unitLabel: string | null;
}

export interface ProductOpenOrders {
  productId: string;
  /** Newest order first, at most `limit` lines. */
  lines: ProductOpenOrderLine[];
  summary: {
    /** Distinct open orders in `lines`. */
    orders: number;
    /** Distinct customers in `lines`. */
    customers: number;
    /** Σ remainingQty, base units. */
    totalQty: number;
  };
  /** True when more lines existed than `limit`. */
  truncated: boolean;
}

// ─── Multi-level units (2026-09-19) ─────────────────────────────────────────────
// See local-assets/handoff/2026-09-18/PLAN-units-po-MINIMAL.md §1. A product with
// no levels behaves exactly as it does today — Product.unitsPerBox/pricePerUnit
// + tiers stay the pack.

/** A `ProductUnit` row as the API returns it. Prices are Prisma `Decimal`s — decimal STRINGS on the wire. */
export interface ProductUnitLevel {
  id: string;
  label: string;
  /** Pieces per ONE of this unit. */
  factorToBase: number;
  /** Explicit tier-1 price; null = derived from the pack (see `resolveUnitPrice`). */
  price: string | null;
  priceTier2: string | null;
  priceTier3: string | null;
  priceTier4: string | null;
  priceTier5: string | null;
  isDefaultSelling: boolean;
  sortOrder: number;
}

/** POST /products/:id/units — prices are numbers ≤ 2 dp; null/omitted = derived. */
export interface CreateProductUnitPayload {
  label: string;
  factorToBase: number;
  price?: number | null;
  priceTier2?: number | null;
  priceTier3?: number | null;
  priceTier4?: number | null;
  priceTier5?: number | null;
  isDefaultSelling?: boolean;
  sortOrder?: number;
}

/** PATCH /products/:id/units/:unitId — `factorToBase` is refused once a line carries the level. */
export type UpdateProductUnitPayload = Partial<CreateProductUnitPayload>;

/** The pack fields a product form snapshots when it OPENS (from GET /products/:id). */
export interface ProductPackAtOpen {
  unit: string;
  unitsPerBox?: number | null;
  /** The tenant unit the pack word names (GET /products/:id `packTenantUnitId`); null = unlinked. */
  packTenantUnitId?: string | null;
}

/**
 * SA-797 (row 218): sent with a PATCH /products/:id that carries `unit` — the pack the form READ when it opened.
 * The server compares them under the product's pack lock; any difference is a 409 PRODUCT_PACK_STALE.
 */
export interface ExpectedPackPayload {
  expectedUnit: string;
  expectedUnitsPerBox: number | null;
  /** Only when the pack word was linked to a tenant unit. */
  expectedTenantUnitId?: string;
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

/** #2717 M2: one component line of a recipe version. */
export interface RecipeComponentDto {
  id: string;
  componentProductId: string;
  qty: number;
  position: number;
}

/** #2717 M2: one recipe version as the recipes API returns it. Dates are ISO strings on the wire. */
export interface RecipeDto {
  id: string;
  productId: string;
  familyProductId: string;
  version: number;
  unitsPerPack: number;
  status: RecipeStatus;
  activeFor: string | null;
  effectiveFrom: string | null;
  retiredAt: string | null;
  components: RecipeComponentDto[];
}

/** Staff product read shapes (GET /products/:id and list rows) carry the buyer-portal flag. */
export interface ProductPortalVisibilityFields {
  portalVisible: boolean;
}

/** PATCH /products/portal-visibility body (1..200 unique ids). */
export interface BulkSetPortalVisibilityPayload {
  ids: string[];
  portalVisible: boolean;
}

export interface BulkSetPortalVisibilityResult {
  portalVisible: boolean;
  updated: number;
  unchanged: number;
}

// ─── Reuse API 409 bodies (SA-603a/603i; flat keys, one shape for codes and names) ───────────────────
/** One ACTIVE product blocking a reactivation, for one code or the name. */
export interface ProductReactivationHolder {
  /** BARCODE_TAKEN for a barcode (SA-572b keeps its code); CODE_TAKEN for sku / unitSku; NAME_TAKEN for the name. */
  code:
    | typeof API_ERROR_CODES.CODE_TAKEN
    | typeof API_ERROR_CODES.BARCODE_TAKEN
    | typeof API_ERROR_CODES.NAME_TAKEN;
  field: "sku" | "barcode" | "unitSku" | "name";
  value: string;
  productId: string;
  productName: string;
  /** Present when this holder can NOT be deactivated in the one call (a FAMILY, or it has ACTIVE variants). */
  blocked?: "HAS_ACTIVE_VARIANTS";
}

/**
 * 409 when reactivating (or creating / renaming) hits an ACTIVE holder. The top-level keys repeat `holders[0]` (the fixed
 * copy maps from them); `holders` is the COMPLETE set the server derived, which is exactly what `deactivateHolderIds`
 * must equal on the one-call resolution. A barcode conflict also carries SA-572b's `barcode` key.
 */
export interface ProductCodeTakenError extends ProductReactivationHolder {
  message: string;
  barcode?: string;
  holders?: ProductReactivationHolder[];
}
/**
 * The name-taken 409. `productId` / `productName` name the holder, but the DB-unique backstop (a P2002 on an active-name
 * index) cannot know who holds it, so on that path they are absent.
 */
export type ProductNameTakenError = Omit<ProductCodeTakenError, "productId" | "productName"> & {
  code: typeof API_ERROR_CODES.NAME_TAKEN;
  field: "name";
  productId?: string;
  productName?: string;
};

/** 409 when `deactivateHolderIds` was sent but NOTHING blocks the reactivation any more. */
export interface ProductHoldersChangedError {
  code: typeof API_ERROR_CODES.HOLDERS_CHANGED;
  message: string;
  holders: [];
}

// ─── Families (WS8, SA-606): a FAMILY is a non-stocked, non-sellable container; its variants are the sellable rows ──
export interface FamilyVariantInput {
  name: string;
  sku?: string;
  barcode?: string;
  unitSku?: string;
  unitsPerBox?: number;
  pricePerUnit: string;
  /** SA-606a: lands in standardCost only (never averageCost / a StockLot); omitted = inherits the family cost. */
  standardCost?: string;
}

export interface CreateFamilyRequest {
  family: {
    name: string;
    category?: string;
    description?: string;
    /** REQUIRED (SA-606i): no implicit $0.00; send "0.00" for a deliberately free family. */
    pricePerUnit: string;
    standardCost?: string;
  };
  /** 1..200 rows. */
  variants: FamilyVariantInput[];
  /** Copy the family price onto the variants (M2 price authority only matters under mixed_packs). */
  copyFamilyPrice?: boolean;
}

/** One conflicting row of a families write. `row` is the variant index, or "family" for the container. */
export interface FamilyRowConflict {
  row: number | "family";
  field: "name" | "sku" | "barcode" | "unitSku";
  value: string;
  reason:
    typeof API_ERROR_CODES.CODE_TAKEN | typeof API_ERROR_CODES.NAME_TAKEN | "DUPLICATE_IN_REQUEST";
  /** The ACTIVE holder in the same tenant (absent for DUPLICATE_IN_REQUEST). */
  conflictProductId?: string;
}

/** 409 FAMILY_ROWS_CONFLICT: EVERY conflict, all-or-nothing (nothing was written). */
export interface FamilyRowsConflictError {
  code: typeof API_ERROR_CODES.FAMILY_ROWS_CONFLICT;
  message: string;
  rows: FamilyRowConflict[];
}

/** 400 FAMILY_NOT_SELLABLE: a FAMILY container named on a sellable line. */
export interface FamilyNotSellableError {
  code: typeof API_ERROR_CODES.FAMILY_NOT_SELLABLE;
  message: string;
  productIds: string[];
}

/** PATCH /products/:id/variants body: ALL-OR-NOTHING, at most 200 rows in total. */
export interface UpdateFamilyVariantsRequest {
  add?: FamilyVariantInput[];
  update?: Array<Partial<FamilyVariantInput> & { id: string }>;
  deactivate?: string[];
}

/**
 * The "Delete product?" confirm's body, shared by web and mobile (audit 2026-10-14: mobile said "removed
 * permanently", but a delete deactivates the product and keeps its history).
 */
export function deleteProductConfirmText(name: string): string {
  return `${name} will be deactivated and hidden from the catalog. Its SKU and barcode are freed, so another product can use them. Order and invoice history is kept. A product on an undelivered order can't be deleted.`;
}

export interface ProductPriceGridCellDto {
  tier: 1 | 2 | 3 | 4 | 5;
  source: "set" | "auto";
  value: number;
}
export interface ProductPriceGridRowDto {
  ref: string;
  label: string;
  factor: number;
  kind: "pack" | "base" | "unit";
  code: string | null;
  cells: ProductPriceGridCellDto[];
  /**
   * False when the price write would refuse this row (a variant, family or recipe product is priced elsewhere; the
   * implicit piece row has no unit yet). The UI hides Edit there.
   */
  editable: boolean;
  /** Plain words for why, set only when `editable` is false. */
  notEditableReason?: string;
}
export interface ProductPriceGridDto {
  productId: string;
  anchor: string;
  rows: ProductPriceGridRowDto[];
  /**
   * Units v2 sprint contract (K1 fills these in the grid service). `revision` = Product.priceRevision.
   */
  revision: number;
  /** Opaque fingerprint of the R-1 price-bearing state (5 pack columns, packAuto, each unit's id/factor/prices). Echo it back. */
  priceState: string;
  /** LadderView.tierAnchors: tier N's own order unit. A missing tier follows `anchor`. */
  tierAnchors: Partial<Record<2 | 3 | 4 | 5, string>>;
  /** The tenant's normalized TierRules (pricing.tierRules), so client previews plan with the server's rules. */
  tierRules: Partial<Record<2 | 3 | 4 | 5, number>>;
}
