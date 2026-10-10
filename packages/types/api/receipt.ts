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
 * ONE money model (SA-762r): Subtotal - Discounts + Tax + Adjustments = Total. `tax` is the order's tax; `adjustments` is
 * whatever remains (a re-price, a credit, regulated tax). `taxRatePercent` is set only when `explainedTaxRatePercent`
 * (@routeflow/pricing) says one stored rate reproduces `tax`. Every renderer (80 mm print, email) prints these fields and
 * derives nothing of its own.
 */
export interface ReceiptModel {
  header: { name: string | null; addressLines: string[]; phone: string | null };
  orderNumber: string;
  invoiceNumber: string;
  invoiceId: string;
  dateLabel: string;
  lines: ReceiptLine[];
  cashier: string | null;
  /** the lines at their system prices: net lines plus `discounts`, so Subtotal - Discounts + Tax + Adjustments = Total */
  subtotal: number;
  /** POS-5: the sum of the edited lines' discounts (0 = no `Discounts` row) */
  discounts: number;
  /** the order's tax (live: the settings rate when it explains the whole difference): 0 = hide the Tax row */
  tax: number;
  /** server total minus the net subtotal minus `tax` (a re-price, a credit, regulated tax): 0 = hide the Adjustments row */
  adjustments: number;
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
  /** the sale's single stored tax rate in percent (8.25 = 8.25%), only when it explains `tax`; else null */
  taxRatePercent: number | null;
  /** SA-762r: the customer's name, only for a named customer (null for a walk-in) */
  customerName: string | null;
  /** SA-762r: the business's receipt footer, trimmed, or null. Tenant text: the email template HTML-escapes it, print renders a React text node. */
  footer: string | null;
}
