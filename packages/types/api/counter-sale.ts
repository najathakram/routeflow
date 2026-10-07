// ─── Counter sale (walk-in pickup) — the web screen <-> API contract ──────────────────────────
//
// POST /orders/counter-sale. The server (OrdersModule, counter-sale/) and the web screen both import this one file;
// never keep a second copy. The server always rings the sale as a PICKUP order (the client sends no fulfillPath).

export const COUNTER_SALE_PAYMENT_METHOD_VALUES = ["CASH", "CARD", "CHECK", "ON_ACCOUNT"] as const;
export type CounterSalePaymentMethod = (typeof COUNTER_SALE_PAYMENT_METHOD_VALUES)[number];

export interface CounterSaleItem {
  productId: string;
  /** a selling-unit quantity (the line's own unit) — or `boxes` / `pieces` for a boxed product */
  qty?: number;
  boxes?: number;
  pieces?: number;
  unitPrice?: number;
  priceReason?: string;
}

export interface CounterSalePayment {
  method: CounterSalePaymentMethod;
  /** cash tendered / amount paid; omitted = the exact total */
  amount?: number;
  /** a check number or card reference */
  reference?: string;
}

export interface CounterSaleRequest {
  /** a known customer; omit and send `walkIn: true` for a walk-in */
  customerId?: string;
  walkIn?: boolean;
  items: CounterSaleItem[];
  payment: CounterSalePayment;
  notes?: string;
}

export interface CounterSaleResponse {
  orderId: string;
  orderNumber: string;
  invoiceId: string;
  invoiceNumber: string;
  total: number;
  paid: number;
  balanceDue: number;
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
  /** true when this response is a replay of an earlier request carrying the same Idempotency-Key. */
  replayed?: boolean;
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
