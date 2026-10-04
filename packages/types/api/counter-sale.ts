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
   * false when the sale committed (an open invoice on account) but recording the payment failed;
   * `paymentErrorCode` then names why. The sale is never rolled back after it commits.
   */
  paymentRecorded: boolean;
  paymentErrorCode?: string;
  /** true when this response is a replay of an earlier request carrying the same Idempotency-Key. */
  replayed?: boolean;
}
