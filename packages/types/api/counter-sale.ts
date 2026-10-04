// ─── Counter sale (walk-in pickup) — the web screen <-> API contract ──────────────────────────
//
// POST /orders/counter-sale. Written locally by the web lane EXACTLY as the contract; PC builder D owns the server and this
// file: when theirs lands on master, drop any second copy (never keep two).

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
  /** false = the sale and invoice exist but the payment write did not land (the receipt says so) */
  paymentRecorded: boolean;
  /** why the payment was not recorded, when it was not */
  paymentErrorCode?: string;
  /** true = this is the stored response of an earlier submit with the same Idempotency-Key */
  replayed?: boolean;
}
