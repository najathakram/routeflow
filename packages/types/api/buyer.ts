// ─── Buyer portal (wave E / imp-10b) ────────────────────────────────────────────

import type {
  AuthorizationSource,
  AuthorizationStatus,
  ChangeRequestType,
  CheckStatus,
  PaymentStatus,
  PromotionScope,
  PromotionType,
} from "./enums";

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
