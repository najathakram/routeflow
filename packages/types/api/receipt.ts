// ─── Order receipt (SA-751r, amended by SA-757) ───────────────────────────────────────────────
//
// `POST /orders/:id/receipt { channel, to }` sends a receipt for any order with a non-void invoice (counter, delivered or
// picked up). The 80 mm print view (web) and the email renderer (API, `documents/`) share ONE `ReceiptModel`, so the two
// can never print different lines for the same sale. The model is TYPE-ONLY here (L-261: the API never value-imports it);
// only `RECEIPT_CHANNEL_VALUES` is a value, and the API keeps a local literal copy pinned by a parity spec (L-072).

/** The ways a receipt can be delivered. One row per channel; SMS / WhatsApp are a later row, not a rework. */
export const RECEIPT_CHANNEL_VALUES = ["email"] as const;
export type ReceiptChannel = (typeof RECEIPT_CHANNEL_VALUES)[number];

/** `POST /orders/:id/receipt` body. `to` is typed by the cashier and is NEVER written to the customer. */
export interface SendReceiptRequest {
  channel: ReceiptChannel;
  to: string;
}

/** The 200 answer: the receipt left (a failure or a limit is a coded error, never a 200). */
export interface SendReceiptResponse {
  channel: ReceiptChannel;
  to: string;
}

export interface ReceiptLine {
  key: string;
  name: string;
  /** "3 × $2.50" or "1 box + 3 pcs × $12.00 per box" */
  detail: string;
  /** trimmed per-line note, or null */
  note: string | null;
  total: number;
  /**
   * POS-5: the line total at the system price, only for a LOWERED line (struck on the receipt); else null. A raised or
   * unchanged price prints plain: the customer never sees a system price below what they were charged.
   */
  original: number | null;
  /** POS-5: money taken off a lowered line (0 for every other line) */
  discount: number;
}

/**
 * The receipt as a pure view model. Line money goes through `computeLineSubtotal` (a boxed line is prorated, never
 * `qty * unitPrice`); the sale's own figures (total / paid / balance / change) are the server's, passed through.
 *
 * The optional fields are the Day-0 receipt fields (SA-762 r-note): a builder that has them sets them, a builder that does
 * not leaves them out, and neither renderer prints a row it was not given.
 */
export interface ReceiptModel {
  header: { name: string | null; addressLines: string[]; phone: string | null };
  orderNumber: string;
  invoiceNumber: string;
  invoiceId: string;
  dateLabel: string;
  lines: ReceiptLine[];
  cashier: string | null;
  /** omitted for a walk-in */
  customerName?: string;
  /** the lines at their system prices: net lines plus `discounts`, so Subtotal - Discounts + adjustment = Total */
  subtotal: number;
  /** POS-5: the sum of the edited lines' discounts (0 = no `Discounts` row) */
  discounts: number;
  /** server total minus the client subtotal (tax, a re-price, a credit): 0 = hide the row */
  adjustment: number;
  /** `order.tax`, where the builder has it (informational: the printed row is still `adjustment`) */
  tax?: number;
  /** the live receipt only, until SA-761 snapshots the order rate */
  taxRatePercent?: number;
  /** SystemConfig `receiptFooter`, at most 200 characters; tenant text, so the email template HTML-escapes it */
  footer?: string;
  /** `Order.counterCashTendered`, where the sale stored it */
  cashTendered?: number;
  total: number;
  paid: number;
  balanceDue: number;
  onAccount: boolean;
  paymentNotRecorded: boolean;
  showPaid: boolean;
  showBalance: boolean;
  methodLabel: string | null;
  tendered: number | null;
  tenderedAsEntered: boolean;
  change: number | null;
  changeAsEntered: boolean;
}
