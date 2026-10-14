// ─── Counter sale (walk-in pickup) — the web screen <-> API contract ──────────────────────────
//
// POST /orders/counter-sale. The server (OrdersModule, counter-sale/) and the web screen both import this one file;
// never keep a second copy. The server always rings the sale as a PICKUP order (the client sends no fulfillPath).

import type { RestrictionAck } from "./restrictions";

export const COUNTER_SALE_PAYMENT_METHOD_VALUES = ["CASH", "CARD", "CHECK", "ON_ACCOUNT"] as const;
export type CounterSalePaymentMethod = (typeof COUNTER_SALE_PAYMENT_METHOD_VALUES)[number];

export interface CounterSaleItem {
  productId: string;
  /** a selling-unit quantity (the line's own unit) — or `boxes` / `pieces` for a boxed product */
  qty?: number;
  boxes?: number;
  pieces?: number;
  /**
   * A one-time NET unit price for the line (a boxed line's is the BOX price). Only a caller who may edit prices
   * (account admins today, `canEditPrices`) may send a price that differs from the server's own for this customer:
   * anyone else gets 403 PRICE_EDIT_NOT_PERMITTED with nothing written. A percent or amount off is resolved to this
   * number by the client; the server stores net price + the list as `originalPrice`, never a separate discount.
   */
  unitPrice?: number;
  /** why the price moved (optional; required on a special-priced line) */
  priceReason?: string;
  /** an optional per-line note (max 200, HTML stripped server-side); stored on the order line */
  note?: string;
}

export interface CounterSalePayment {
  method: CounterSalePaymentMethod;
  /** cash tendered / amount paid; omitted = the exact total */
  amount?: number;
  /** a check number or card reference */
  reference?: string;
}

/**
 * Row 510: after a 409 RESTRICTION_WARNING the till resubmits the SAME cart with the SAME Idempotency-Key plus the ack
 * (`restrictionOverrides`, `warningHash`). The key's cart comparison ignores the ack, so a resubmit never conflicts.
 */
export interface CounterSaleRequest extends RestrictionAck {
  /** a known customer; omit and send `walkIn: true` for a walk-in */
  customerId?: string;
  walkIn?: boolean;
  items: CounterSaleItem[];
  payment: CounterSalePayment;
  notes?: string;
}

/**
 * The stored price facts of one sale line (the invoice line the sale produced): what the receipt needs to apply the invoices'
 * own original-price rule (`showOriginalPrice` in @routeflow/pricing). `originalPrice` is the LIST price (never the tier
 * price), `priceType` one of STANDARD / SPECIAL / DISCOUNTED / MANUAL / PROMO. `unitPrice` is the NET unit price the line was
 * stored at: the live receipt matches a cart line to its stored line by product + this price (two lines of one product at
 * different prices must not swap their list prices).
 */
export interface CounterSaleLinePrice {
  productId: string | null;
  unitPrice: number;
  originalPrice: number | null;
  priceType: string;
}

export interface CounterSaleResponse {
  orderId: string;
  orderNumber: string;
  invoiceId: string;
  invoiceNumber: string;
  total: number;
  paid: number;
  balanceDue: number;
  /**
   * Cash handed back. Server-owned: on the POST and on GET .../by-key/:key it is the STORED `cashTendered` less the sale's
   * own original CASH tender rows (so a same-key replay reads the stored amount's change). Omitted (not null) unless the
   * sale's first stored tender is CASH, nothing is left to pay, and a non-negative change is stored (a legacy CASH sale
   * with no stored `cashTendered` serves none).
   */
  change?: number;
  paymentId?: string;
  /**
   * The tender method, echoed on the POST and DERIVED from storage on GET .../by-key/:key (a stored CASH/CARD/CHECK
   * tender; none = "ON_ACCOUNT", since nothing marks "left on account" apart from "tender failed").
   */
  method?: CounterSalePaymentMethod;
  /**
   * false when the sale committed (an open invoice on account) but recording the payment failed;
   * `paymentErrorCode` then names why. The sale is never rolled back after it commits.
   */
  paymentRecorded: boolean;
  paymentErrorCode?: string;
  /**
   * The cash handed over, as stored on the order. Optional because it is OMITTED (never null) when nothing was stored
   * (card / check / on account / a sale rung before it was stored); the Today's-sales row carries `number | null`.
   */
  cashTendered?: number;
  /**
   * The order's tax (`Order.tax`), server-owned: the counter receipt prints it as the Tax row and the remainder as
   * Adjustments, exactly like the reprint and the emailed receipt. Omitted by an older server; then no Tax row prints.
   */
  tax?: number;
  /**
   * The regulated levies the invoices billed, one named charge per category ("CRV deposit"), taken from the stored invoice
   * lines (an exempt customer's are zero). The receipt prints them as their own rows; omitted by an older server.
   */
  charges?: Array<{ key: string; label: string; amount: number }>;
  /**
   * The sale's stored tax rate in percent (`@routeflow/pricing` `storedTaxRatePercent`), a CANDIDATE: the receipt names it
   * only through `explainedTaxRatePercent`. null = mixed / none; omitted with `tax`.
   */
  taxRatePercent?: number | null;
  /**
   * The sale's stored lines, in invoice order, with the price facts the receipt strikes a list price from. The live receipt
   * matches its cart lines to these by product, so it shows exactly what the reprint and the emailed receipt show. Omitted by
   * an older server: then nothing is struck (the cart's tier price is never a base).
   */
  lines?: CounterSaleLinePrice[];
  /** true when this response is a replay of an earlier request carrying the same Idempotency-Key. */
  replayed?: boolean;
}

// ─── Void a counter sale — POST /orders/counter-sale/:orderId/void ────────────────────────────────
//
// One call voids today's sale: its counter tender, its invoices and the order (stock goes back). `reason` is 3-200
// characters (trimmed, control characters stripped). The call is idempotent: a second void of the same sale answers
// 200 with `replayed: true` and the same `handBack`. Refusals are 409s with their own codes (COUNTER_SALE_VOIDED,
// COUNTER_SALE_VOID_HAS_RETURN, COUNTER_SALE_VOID_FOREIGN_PAYMENT, COUNTER_SALE_VOID_NOT_TODAY, ORDER_HAS_CASH_REFUND)
// and COUNTER_SALE_VOID_BUSY (503, nothing written: retry).

export interface CounterSaleVoidRequest {
  reason: string;
}

/** The PAID tender voided, per method (a method with nothing to hand back is absent). */
export interface CounterSaleHandBack {
  CASH?: number;
  CARD?: number;
  CHECK?: number;
}

export interface CounterSaleVoidResponse {
  voided: true;
  /** true when the sale was already voided by this endpoint: nothing was written, `handBack` is the first call's. */
  replayed?: boolean;
  /** UI copy: "Give back $X cash · Void the card payment on the card terminal". */
  handBack: CounterSaleHandBack;
}

// ─── Pickup complete (order ahead, pick up) — POST /orders/:id/pickup-complete ────────────────
//
// Staff hand a PICKUP order over at the till: the order goes to DELIVERED, its invoice is issued and the
// tender is recorded, in one call (the Idempotency-Key header is REQUIRED). The payment rules are the counter
// sale's (same methods, same "never over-collect", cash change is response-only). Only payments created at or
// after the order's `deliveredAt` (the moment this hand-over moved it to DELIVERED) are this request's tender:
// a deposit or portal payment made before it is never counted as one.

export interface PickupCompleteRequest {
  /** omit to hand the order over unpaid (an open invoice on account); a walk-in must pay */
  payment?: CounterSalePayment;
  /** SA-750r3: the till register this hand-over's cash counts on when the order has none stamped yet; default 'main' */
  registerKey?: string;
}

export interface PickupCompleteResponse {
  orderId: string;
  orderNumber: string;
  invoiceId: string;
  invoiceNumber: string;
  total: number;
  paid: number;
  balanceDue: number;
  /** cash handed back; present only once the stored balance is fully covered */
  change?: number;
  paymentId?: string;
  /** false when the hand-over committed but recording the payment failed; `paymentErrorCode` names why. */
  paymentRecorded: boolean;
  paymentErrorCode?: string;
  /** true when the order was already picked up: no status write; only a planned shortfall of this hand-over's tender is recorded. */
  alreadyPickedUp?: boolean;
}

// ─── Today's sales (register panel) — GET /orders/counter-sale/today ──────────────────────────
//
// Every counter sale of the tenant's calendar day (all registers and clerks; each row names its cashier), one lean
// row each (no line items), plus a whole-day summary on page 1. Read-only; the server owns the day window, the
// web formats times in `meta.timezone` and does no money math.

/** How a sale's money reached the till: "STORE_CREDIT" is a credit-note / advance application, never money in. */
export type TodaysSaleMethod = "CASH" | "CARD" | "CHECK" | "OTHER" | "STORE_CREDIT";
export type TodaysSalePaymentState = "PAID" | "PARTLY_PAID" | "ON_ACCOUNT" | "UNPAID";
export type TodaysSaleReturnState = "NONE" | "PARTLY" | "FULL" | "PENDING";
/** null = settled with no stored resolution (a legacy return with neither a refund method nor a credit note). */
export type TodaysSaleReturnResolution = "STORE_CREDIT" | "REFUND" | "PENDING" | null;

export interface TodaysSaleReturn {
  id: string;
  returnNumber: string | null;
  status: string;
  resolution: TodaysSaleReturnResolution;
  /** the return's priced credit (subtotal + tax + category tax), never recomputed from lines */
  amount: number;
}

export interface TodaysSaleRow {
  orderId: string;
  /** the number printed on the receipt */
  orderNumber: string;
  invoiceId: string | null;
  invoiceNumber: string | null;
  /** ISO instant the sale was rung */
  createdAt: string;
  customerId: string;
  customerName: string;
  isWalkIn: boolean;
  /**
   * Who rang the sale: the staff user's display name (`Order.soldBy.username`, stamped by the counter write). null for a sale
   * rung before it was stamped, or when the stored name looks like an email (a receipt never prints an address). Omitted by an
   * older server.
   */
  cashierName?: string | null;
  status: string;
  total: number;
  /** every PAID payment on the sale's live invoices, store credit included */
  paid: number;
  balanceDue: number;
  methods: Array<{ method: TodaysSaleMethod; amount: number }>;
  paymentState: TodaysSalePaymentState;
  /** the cash handed over, as stored by the tender (null = card / check / on account / a sale rung before it was stored) */
  cashTendered: number | null;
  /**
   * Server-owned, the same value and gate as `CounterSaleResponse.change`: the stored `cashTendered` minus the sale's own
   * original counter-tender CASH rows (credit-note, advance and voided rows never count), served only for a CASH sale with
   * nothing left to pay; null otherwise (card / check / on account, partly paid, nothing tendered, or a negative result).
   */
  change: number | null;
  /**
   * The sale's single stored tax rate as a percent (0.0825 -> 8.25), from `@routeflow/pricing` `storedTaxRatePercent`: the one
   * distinct non-zero line rate on its live invoices; for a legacy invoice whose lines ALL store 0, the flat rate its header
   * tax implies (when that rate reproduces the tax); null when the lines carry several rates or none. A CANDIDATE: a receipt
   * names it only through `explainedTaxRatePercent`.
   */
  taxRatePercent: number | null;
  /**
   * The regulated levies the sale's live invoices billed, one named charge per category ("CRV deposit"), from the stored
   * invoice lines (an exempt customer's are zero). The reprint prints them as their own rows, never inside Tax.
   * Omitted by an older server: then none print.
   */
  charges?: Array<{ key: string; label: string; amount: number }>;
  returned: {
    amount: number;
    state: TodaysSaleReturnState;
    returns: TodaysSaleReturn[];
  };
  /** the order is CANCELLED, or it has invoices and every one is VOID / WRITTEN_OFF */
  voided: boolean;
}

export interface TodaysSalesSummary {
  /** live sales only: not cancelled, with at least one non-void invoice */
  sales: { count: number; total: number };
  /**
   * Money that CAME IN on this day: PAID payments dated (paidAt) inside the day, on counter sales of ANY day. A
   * day-1 sale left on account and paid in cash on day 2 counts in day 2's `cash` and `cashExpectedInDrawer`, not
   * day 1's. (`sales` stays "rung this day".) `other` is ACH / Zelle / other recorded against a counter invoice.
   */
  moneyIn: { cash: number; card: number; check: number; other: number; total: number };
  /**
   * The "Hand-overs" line: the tenders of POS-mode pickup hand-overs (a named customer's order handed over at
   * the till) that came in this day. Already INCLUDED in `moneyIn` and `cashExpectedInDrawer`; a counter sale is
   * never counted here. `count` is hand-overs (orders), `total` the money.
   */
  handOvers: { count: number; total: number };
  /** credit-note and advance applications dated inside the day: NOT money in */
  storeCreditUsed: number;
  /** this day's sales total minus everything paid on those sales (any payment date, store credit included), never below 0 */
  onAccount: number;
  /**
   * Money given back, counted on the day it was given (an earlier day's sale included).
   * The tender is read from `Return.refundTender`. A refund with no recorded tender sits in `other` and is NOT subtracted
   * from `cashExpectedInDrawer`; `tenderKnown` is false while ANY refund in the window has no recorded tender (true when
   * every refund has one, and for a window with no refund at all).
   */
  refunds: {
    count: number;
    cash: number;
    card: number;
    check: number;
    other: number;
    total: number;
    tenderKnown: boolean;
  };
  /** returns captured in the window that resolved as store credit */
  storeCreditIssued: { count: number; amount: number };
  /** EXPECTED, never counted: moneyIn.cash - refunds.cash */
  cashExpectedInDrawer: number;
  /** moneyIn.total - refunds.total */
  netCollected: number;
}

export interface TodaysSalesMeta {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  /** the tenant's calendar day, "YYYY-MM-DD" */
  day: string;
  /** the IANA zone the window was cut in ("UTC" when the tenant has none) */
  timezone: string;
  windowStart: string;
  windowEnd: string;
}

/**
 * One POS-mode pickup hand-over of the day (a named customer's order handed over at the till): the order, who it was for, the
 * tender that came in, and the register + cashier stamped on it. Staff only. Consistent with the Z report: the same rows
 * (a non-counter PICKUP order's own `pickupTenderGroupId` tender) that the day close counts under "Pickup hand-overs".
 */
export interface TodaysHandOverRow {
  orderId: string;
  orderNumber: string;
  /** the named customer (a walk-in is a counter sale, never a hand-over) */
  customerName: string;
  /** when the tender was recorded (the latest tender of this order in the window), ISO */
  paidAt: string;
  /** this order's hand-over tender in the window, rounded to cents */
  amount: number;
  /** the tender split by method */
  methods: Array<{ method: TodaysSaleMethod; amount: number }>;
  /** the register the order is stamped on; "main" when none is stamped */
  registerKey: string;
  /** the cashier who handed it over (display name); null when none is stamped */
  handedOverBy: string | null;
}

export interface TodaysSalesResponse {
  data: TodaysSaleRow[];
  meta: TodaysSalesMeta;
  /** the whole day, on page 1 only (null on later pages) */
  summary: TodaysSalesSummary | null;
  /**
   * The day's POS pickup hand-overs, newest first, on page 1 only ([] on later pages; absent from an older API: read as []).
   * Bounded (the day's few hand-overs); `summary.handOvers` is the count and money of the same rows.
   */
  handOverRows?: TodaysHandOverRow[];
}
