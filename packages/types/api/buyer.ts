// ─── Buyer portal (wave E / imp-10b) ────────────────────────────────────────────

import type {
  AuthorizationSource,
  AuthorizationStatus,
  ChangeRequestStatus,
  ChangeRequestType,
  CheckStatus,
  CreditNoteStatus,
  InvoiceStatus,
  InvoiceTreatment,
  ItemStatus,
  OrderStatusValue,
  PaymentMethod,
  PaymentStatus,
  PromotionScope,
  PromotionType,
  PriceType,
  RouteRunStatusValue,
} from "./enums";
import type { LineComponentView } from "./orders";
import type { DecimalWire } from "./decimal";

export interface LockedCategory {
  id: string;
  name: string;
  status: "NONE" | "PENDING_REVIEW" | "EXPIRED" | "REJECTED";
}

export interface ReplenishmentEstimate {
  productId: string;
  name: string;
  unit: string;
  unitsPerBox: number | null;
  imageKey: string | null;
  lastOrderedAt: string;
  orderCount: number;
  cadenceDays: number | null;
  daysSinceLast: number;
  estDaysLeft: number | null;
  typicalQty: number;
  suggestedQty: number;
  state: "low" | "due-soon" | "ok";
}

export interface ShelfEstimate extends ReplenishmentEstimate {
  /** Presigned URL for `imageKey`, renderable by <img>; null when no image. */
  imageUrl: string | null;
  snoozed: boolean;
  snoozedUntil: string | null;
}

export interface ShelfActiveOrder {
  id: string;
  orderNumber: string | null;
  itemCount: number;
  total: number;
}

export interface ShelfResponse {
  estimates: ShelfEstimate[];
  activeOrder: ShelfActiveOrder | null;
}

export interface BuyerCreateChangeRequestInput {
  orderId: string;
  type: ChangeRequestType;
  /** ADD_ITEM: the catalog product to add. */
  productId?: string;
  /** CHANGE_QTY / REMOVE_ITEM: the target order line. */
  orderItemId?: string;
  /** ADD_ITEM: qty to add. CHANGE_QTY: the NEW absolute qty (not a delta). */
  qty?: number;
  note?: string;
}

export interface BuyerStockAlerts {
  /** Product ids the buyer has a PENDING restock alert on. */
  productIds: string[];
}

export interface BuyerAnalytics {
  monthlySpend: Array<{ month: string; spend: number; orderCount: number }>;
  summary: {
    totalOrders: number;
    totalSpend: number;
    avgOrderValue: number;
    unpaidInvoiceCount: number;
    unpaidInvoiceTotal: number;
  };
  invoiceBreakdown: { paid: number; unpaid: number; overdue: number };
  recentPayments: Array<{ date: string; amount: number; method: string; invoiceNumber: string }>;
}

export interface BuyerStatementTransaction {
  type: "INVOICE" | "CREDIT_NOTE" | "ADVANCE_PAYMENT";
  id: string;
  description: string;
  date: string;
  amount: number;
  runningBalance: number;
  status: string;
  /** CREDIT_NOTE only: optional expiry — a computed filter, never a status flip. */
  expiresAt?: string | null;
}

export interface BuyerStatement {
  outstandingAmount: number;
  overdueAmount: number;
  /** Wallet balance: Σ roundMoney(amount − amountUsed) over open, non-expired,
   *  non-VOID credit notes. Never nets AdvancePayment in. */
  availableCredit: number;
  advanceBalance: number;
  pendingOrdersAmount: number;
  /** Lifetime billed total (every non-DRAFT, non-VOID invoice), summed by the
   *  DATABASE over the whole history — never a reduce over the capped
   *  `transactions` ledger, which stops at one page. */
  lifetimeInvoiced: number;
  /** Lifetime money received: Σ amount over CONFIRMED (PAID) invoice payments,
   *  summed by the DATABASE over the whole history. DRAFT (unconfirmed) and
   *  VOID (bounced) rows never count. */
  lifetimeReceived: number;
  /** True when the transactions ledger below is a capped partial view of the full history. */
  transactionsTruncated: boolean;
  transactions: BuyerStatementTransaction[];
}

export interface BuyerPayment {
  id: string;
  invoiceId: string;
  invoiceNumber: string;
  amount: number;
  method: string;
  status: PaymentStatus;
  checkStatus: CheckStatus | null;
  nsfFeeAmount: number | null;
  paidAt: string;
}

export interface BuyerRemittance {
  payToName?: string;
  bankName?: string;
  accountName?: string;
  accountNumber?: string;
  routingNumber?: string;
  achInstructions?: string;
  wireInstructions?: string;
  checkInstructions?: string;
  mailingAddress?: string;
  notes?: string;
}

export interface BuyerAuthorizationRow {
  trackedCategoryId: string;
  categoryName: string;
  status: AuthorizationStatus;
  source: AuthorizationSource | null;
  licenseNumber: string | null;
  expiresAt: string | null;
  documentKey: string | null;
  submittedAt: string | null;
  verifiedAt: string | null;
}

export interface OrderTemplateItem {
  id: string;
  productId: string;
  product?: { id: string; name: string; unit: string };
  qty: number;
  notes?: string;
}

/**
 * Active, in-window promotion for the current seller (`GET /buyer/promotions`).
 * ⚠️ Drift fixed here (Wave E / imp-10b, L-072): mobile's `type` field omitted
 * `"BUY_N_GET_M"`, which the schema, web, and mobile's OWN `lib/pricing.ts`
 * `PromotionType` already carried — mobile's BOGO matcher
 * (`lib/buyer-cart-logic.ts` `matchingBogoPromo`) worked around the hole with an
 * explicit `as PromotionType` cast, now removable. This made the whole interface
 * diverge between apps (sweep §3: "D"); typing `type`/`scope` from the shared
 * enums resolves that — web and mobile now declare the identical shape.
 */
/** GET /buyer/products/:id — one active variant (a catalog product in its own right). */
export interface BuyerProductVariant {
  id: string;
  name: string;
  sku: string | null;
  buyerPrice: number;
  unit: string;
  /** Promo inputs — a variant row prices through the tile price path like any tile. */
  category: string | null;
  unitsPerBox: number | null;
}

/** GET /buyer/products/:id — the detail-only fields on top of the catalog list row. */
export interface BuyerProductDetailExtras {
  imageUrls: string[];
  variants: BuyerProductVariant[];
  /** P5-03: whether the caller has a PENDING restock alert on this product. */
  alertSubscribed?: boolean;
}

export interface BuyerPromotion {
  id: string;
  name: string;
  bannerText: string | null;
  type: PromotionType;
  value: number;
  minQty: number | null;
  scope: PromotionScope;
  category: string | null;
  startsAt: string;
  endsAt: string;
  productIds: string[];
}

// ─── Catalog + favorites (#2703, SA-562: server truth, one declaration) ─────────

/** A catalog row — GET /buyer/products and the core of GET /buyer/products/:id. The API's
 *  buyer-catalog.service returns exactly this type, so the server's own compile pins it. */
export interface BuyerProduct {
  id: string;
  name: string;
  description: string | null;
  sku: string | null;
  barcode: string | null;
  unit: string;
  category: string | null;
  /** Box packaging: when unitsPerBox > 1 this is the BOX price. */
  buyerPrice: number;
  unitsPerBox: number | null;
  thumbnailUrl: string | null;
  imageKeys: string[];
  isFeatured: boolean;
  isNew: boolean;
  isDeal: boolean;
  /** Presigned URLs for the first images (max 4) — the tile dot-pager. [] when no images. */
  imageUrls: string[];
  inStock: boolean;
  stockStatus: "IN_STOCK" | "LOW" | "OUT_OF_STOCK";
  /** Whole units remaining, exposed ONLY while stockStatus === "LOW"; else null. */
  stockLeft: number | null;
  /**
   * OOS PR2: this buyer may order the item even when it is out of stock (the seller's setting,
   * resolved server-side once per request). Absent/false = an out-of-stock item is not orderable.
   * Where the seller hides backorders, `inStock` / `stockStatus` already read as in stock.
   */
  canBackorder?: boolean;
}

/** GET /buyer/favorites — NOT a BuyerProduct: `id` is the favorite row's id; the product is
 *  `productId`. `thumbnailUrl` is always null here (thumbnails resolve in the catalog). */
export interface BuyerFavoriteAvailable {
  id: string;
  productId: string;
  name: string;
  sku: string | null;
  unit: string;
  category: string | null;
  buyerPrice: number;
  thumbnailUrl: string | null;
  imageKeys: string[];
  unitsPerBox: number | null;
  createdAt: string;
  unavailable: false;
}

/** A favourite the tenant hid from the buyer portal (SA-606 M3): name only, no price, not orderable. */
export interface BuyerFavoriteUnavailable {
  id: string;
  productId: string;
  name: string;
  createdAt: string;
  unavailable: true;
  /** "No longer available online". */
  unavailableText: string;
}

export type BuyerFavoriteProduct = BuyerFavoriteAvailable | BuyerFavoriteUnavailable;

// ─── Orders (#2703, SA-562/562a: server truth, one declaration) ────────────────

/** `ChangeRequest.resolution` is a free `String?` column; these are the values the API writes. */
export type ChangeRequestResolution = "MERGED_AT_STOP" | "NEXT_DELIVERY" | "DECLINED";

/** A post-dispatch order change request (P5-09) — the full row, shared by the buyer portal,
 *  the operator surface and mobile's buyer order detail. `payload` narrows a Json column. */
export interface ChangeRequest {
  id: string;
  orderId: string;
  orderItemId: string | null;
  productId: string | null;
  type: ChangeRequestType;
  status: ChangeRequestStatus;
  /**
   * Typed delta. ADD_ITEM {productId,qty,boxes,pieces,productName};
   * CHANGE_QTY {orderItemId,newQty}; REMOVE_ITEM {orderItemId}; NOTE {text}.
   */
  payload: {
    productId?: string;
    qty?: number;
    boxes?: number | null;
    pieces?: number | null;
    productName?: string;
    orderItemId?: string;
    newQty?: number;
    text?: string;
  };
  note: string | null;
  requestedByName: string | null;
  requestedByRole: string | null;
  resolvedByName: string | null;
  resolvedByRole: string | null;
  resolution: ChangeRequestResolution | null;
  resolutionReason: string | null;
  nextOrderId: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

/** An order line as GET /buyer/orders and /buyer/orders/:id return it. The detail's product
 *  carries `unitsPerBox`; the list's product select does not. */
export interface BuyerOrderLine {
  id: string;
  /** Null for a staff-added custom (unlisted) line — which has no `product` either. */
  productId: string | null;
  /** Free-text label of a custom line. */
  name: string | null;
  qty: DecimalWire;
  unitPrice: DecimalWire;
  subtotal: DecimalWire;
  priceType: PriceType;
  originalPrice: DecimalWire | null;
  status: ItemStatus;
  deliveredQty: DecimalWire;
  boxes: number | null;
  pieces: number | null;
  /** BUY_N_GET_M: whole free SELLING units on this line (names the reduced subtotal). */
  promoFreeUnits: number | null;
  /** RF-4: regulated category tax folded into the order total. */
  categoryTaxAmount: DecimalWire;
  /** units_v1: sold by a non-pack unit (Case, Pallet, Piece…) — null = the pack. */
  unitLabel: string | null;
  /** Per-line note, buyer-visible. */
  notes: string | null;
  /** #2717 M3: frozen components of a composed line; absent on a plain line. */
  components?: LineComponentView[];
  product: { id: string; name: string; unit: string; unitsPerBox?: number | null } | null;
}

/** GET /buyer/orders — one row of the paginated list (OrdersService.findAll). */
export interface BuyerOrderListItem {
  id: string;
  orderNumber: string | null;
  status: OrderStatusValue;
  createdAt: string;
  requestedDeliveryDate: string | null;
  deliveredAt: string | null;
  notes: string | null;
  urgent: boolean;
  subtotal: DecimalWire;
  tax: DecimalWire;
  total: DecimalWire;
  discountAmount: DecimalWire;
  customer: { id: string; businessName: string };
  lineItems: BuyerOrderLine[];
}

/** P5-08: the server's edit window — editing closes when the order's run dispatches. */
export interface BuyerOrderEditWindow {
  editable: boolean;
  editableUntil: string | null;
  closedReason: "DISPATCHED" | "STATUS" | null;
}

/** GET /buyer/orders/:id — the list row plus the detail-only relations (OrdersService.findOne). */
export interface BuyerOrder extends BuyerOrderListItem {
  invoices: Array<{ id: string; invoiceNumber: string; status: InvoiceStatus; total: DecimalWire }>;
  /** P5-09: post-dispatch change requests, newest first. */
  changeRequests: ChangeRequest[];
  editWindow: BuyerOrderEditWindow;
  /** Run state backing the edit window (null until the order is on a run). */
  routeRun: { status: RouteRunStatusValue; startedAt: string | null } | null;
  /**
   * Business profiles 1B: SHIP orders show a shipment (carrier + tracking), never a route. The
   * server's `FulfillPath` ("ROUTE" | "SHIP"); narrows to the shared `FULFILL_PATH_VALUES` type
   * once that export lands (feat/fulfil-path-pickup) — no hand-typed mirror here (L-072).
   */
  fulfillPath: string;
  /** Free-text carrier label and tracking number, set when the seller ships the order. */
  shippingCarrier: string | null;
  shippingTrackingNumber: string | null;
  /**
   * The SHIP transition's stamp (OrdersService.changeStatus), kept through an unmark. Saving
   * tracking never stamps it, except `updateShipment` backfilling a legacy already-shipped order.
   */
  shippedAt: string | null;
}

// ─── Invoice list rows (B1122) ──────────────────────────────────────────────────

/** GET /buyer/invoices — one row of the paginated list (InvoicesService.findAll). The invoice's
 *  own money columns keep their column names (`total`, never `totalAmount`/`amount`) and the
 *  server derives `balanceDue` (never `balance`): a client reading any other name gets nothing
 *  and renders "N/A" (B1122). */
export interface BuyerInvoiceListItem {
  id: string;
  invoiceNumber: string;
  status: InvoiceStatus;
  issueDate: string;
  createdAt: string;
  dueDate: string | null;
  subtotal: DecimalWire;
  taxAmount: DecimalWire;
  total: DecimalWire;
  /** What the buyer still owes — 0 for a settled invoice (confirmed payments + credits applied). */
  balanceDue: DecimalWire;
  /** Cash received only; credit-note and advance applications are the two fields below. */
  paidAmount: DecimalWire;
  creditApplied: DecimalWire;
  advanceApplied: DecimalWire;
  isOverdue: boolean;
  customer: { id: string; businessName: string };
}

// ─── Invoice detail lines + payments (#2703, SA-562/562a: server truth) ─────────

/** An invoice line as GET /buyer/invoices/:id returns it (InvoicesService.findOne; the buyer
 *  boundary nulls an upsell line's originalPrice and reads its priceType as STANDARD). */
export interface BuyerInvoiceItem {
  id: string;
  description: string;
  productId: string | null;
  qty: DecimalWire;
  unitPrice: DecimalWire;
  discount: DecimalWire;
  originalPrice: DecimalWire | null;
  msrp: DecimalWire | null;
  priceType: PriceType;
  subtotal: DecimalWire;
  /** units_v1: set when the line sells by a named unit — `boxes` is then that unit's COUNT. */
  unitLabel: string | null;
  boxes: number | null;
  pieces: number | null;
  unitsPerBox: number | null;
  /** BUY_N_GET_M: whole free SELLING units on this line (names the reduced subtotal). */
  promoFreeUnits: number | null;
  /** Per-line note, buyer-visible. */
  notes: string | null;
  categoryTaxAmount: DecimalWire;
  product: { id: string; name: string; unit: string; unitsPerBox: number | null } | null;
  trackedCategory: { id: string; name: string; invoiceTreatment: InvoiceTreatment } | null;
  trackedSubcategory: { id: string; name: string } | null;
}

/** A payment row on GET /buyer/invoices/:id (newest first). `creditNote` is set when
 *  method = CREDIT_NOTE. */
export interface BuyerInvoicePayment {
  id: string;
  amount: DecimalWire;
  method: PaymentMethod;
  reference: string | null;
  notes: string | null;
  paidAt: string;
  createdAt: string;
  status: PaymentStatus;
  /** Check lifecycle (P5-12) — only ever set when method = CHECK. */
  checkStatus: CheckStatus | null;
  nsfFeeAmount: DecimalWire | null;
  creditNote: {
    id: string;
    creditNoteNumber: string;
    reason: string | null;
    amount: DecimalWire;
    amountUsed: DecimalWire;
    status: CreditNoteStatus;
  } | null;
}
