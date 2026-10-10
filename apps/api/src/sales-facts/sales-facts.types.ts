/**
 * #2118 — the fact shapes `SalesFactsService` reads and the pure aggregators consume. Numbers,
 * never Prisma Decimals; dates as real `Date`s. No I/O here.
 */

/** One sold line of a product, flattened from its (accrual-basis) invoice. */
export interface ProductSaleFact {
  lineId: string;
  lineCreatedAt: Date;
  invoiceId: string;
  invoiceNumber: string;
  /** Null only when the reader did not select it (legacy stubs). */
  invoiceStatus: string | null;
  /** UTC-midnight stamp of the tenant-local sale day (the calendar-date convention). */
  issueDate: Date;
  invoiceCreatedAt: Date;
  orderId: string | null;
  orderNumber: string | null;
  customerId: string;
  /** Stored business name; null when the customer row is unreadable. */
  customerName: string | null;
  /** Pieces, as stored (`InvoiceItem.qty`). */
  qty: number;
  /** Authoritative line total — never re-derived from qty × unitPrice. */
  subtotal: number;
  /** Price per selling unit as charged (a BOX price on a boxed line). */
  unitPrice: number;
  originalPrice: number | null;
  priceType: string | null;
  boxes: number | null;
  pieces: number | null;
  unitsPerBox: number | null;
  unitLabel: string | null;
}

/** A credit attributed to this product's lines by a stored line fact. */
export interface AttributedCreditEvent {
  /** Real instant of the netting event (credit note `createdAt` / return `refundedAt`). */
  at: Date;
  amount: number;
  /** Which B440 term it belongs to. */
  kind: "CREDIT_NOTE" | "EXTERNAL_REFUND";
  customerId: string;
  customerName: string | null;
}

/** Pieces of this product returned (one return line), with the instant the return netted. */
export interface ReturnedQtyEvent {
  at: Date;
  /**
   * Pieces, or null when the line's unit cannot be resolved to pieces: a STANDARD return is
   * typed in the order line's own unit (B665), and `standardRestockResolver` refuses to guess a
   * pack. Never counted as pieces then — reported as `unresolvedReturnLines`.
   */
  qty: number | null;
  customerId: string;
  customerName: string | null;
}

/** Credit touching this product that no stored line fact attributes (footnote only). */
export interface UnattributedCreditEvent {
  at: Date;
  amount: number;
}

export interface ProductCreditEvents {
  attributed: AttributedCreditEvent[];
  returned: ReturnedQtyEvent[];
  unattributed: UnattributedCreditEvent[];
}

/** Lifetime first/last sale stamps (UTC-midnight), accrual basis. */
export interface ProductLifetime {
  first: Date | null;
  last: Date | null;
}

/** Real-instant bounds of a calendar-day window in the tenant's zone: [gte, lt). */
export interface InstantWindow {
  gte: Date;
  lt: Date;
}

/** One product's accrual sales inside a window (the catalog CSV's stats columns). */
export interface ProductPeriodStats {
  /** Σ pieces of the lines that state them; a line that cannot say counts revenue only. */
  pieces: number;
  /** Σ line subtotal (accrual gross of credits), unrounded. */
  gross: number;
  /** Newest issue date in the window, or null when nothing sold. */
  lastSold: Date | null;
}
