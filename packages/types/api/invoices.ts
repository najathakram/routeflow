import type { API_ERROR_CODES } from "./error-codes";

/**
 * SA-1029: the per-piece price printed beside a pack line (display only; never stored, summed or multiplied back).
 * `unit` is the lowercase base word ("pc", "bag"). The ONE declaration: pricing, the buyer wire and the web client reuse it.
 */
export interface PerBaseUnit {
  price: number;
  unit: string;
}

// ─── Invoice KPI summary (B12) ─────────────────────────────────────────────
//
// `GET /invoices/kpi-summary?today=YYYY-MM-DD` — the invoices page's six KPI
// tiles, computed server-side over the tenant's whole OPEN set (never a
// capped `limit: 999` fetch-all-then-reduce, which silently drops whichever
// rows page 1000+ would have held — see .claude/pipeline/2026-09-07-F16-list-caps).

export interface InvoiceKpiSummary {
  totalOutstanding: number;
  overdue: number;
  dueToday: number;
  dueIn30: number;
  avgDays: number;
  awaitingConfirmationCount: number;
}

// ─── Bulk price adjustment refusals (B1051 / B1058) ────────────────────────
//
// `POST /invoices/:id/price-adjustment` with scope ALL_CUSTOMER_SINCE. Two structured bodies the invoice
// page renders from fixed copy (B980: never the server `message`):
//   400 PRICE_ADJUSTMENT_OVERPAYS — a re-price would leave invoices overpaid (confirmed payments above the
//        new total); nothing was written. `overpaid` is ALWAYS present: the bulk pre-flight collects every
//        offender across the batch, SINGLE scope and a bulk first-invoice race carry exactly one entry.
//   409 PRICE_ADJUSTMENT_PARTIAL — a race stopped the run after >= 1 invoice committed. `applied` are
//        invoice ids; exactly one of `refused` (that invoice was refused in its transaction) or `syncFailed`
//        (that invoice committed, then its follow-up sync of order totals and commissions threw; it is also
//        in `applied`) is present;
//        `skipped` were never attempted. Re-running the same request finishes them.

export interface PriceAdjustmentOverpaidInvoice {
  invoiceId: string;
  invoiceNumber: string | null;
  paid: number;
  newTotal: number;
  overpaidBy: number;
}

export interface PriceAdjustmentOverpaysBody {
  code: typeof API_ERROR_CODES.PRICE_ADJUSTMENT_OVERPAYS;
  message: string;
  overpaid: PriceAdjustmentOverpaidInvoice[];
}

export interface PriceAdjustmentPartialBody {
  code: typeof API_ERROR_CODES.PRICE_ADJUSTMENT_PARTIAL;
  message: string;
  applied: string[];
  refused?: { invoiceId: string; invoiceNumber: string | null; code: string; message: string };
  syncFailed?: { invoiceId: string; invoiceNumber: string | null };
  skipped: string[];
}

/** SA-827: how an invoice line reads. "pieces" = the customer's invoice unit is the base piece; "legacy" = today's layout. */
export interface InvoiceDisplayUnitView {
  kind: "legacy" | "pieces";
  label: string | null;
}

// ─── Editing an issued invoice in place (SA-1508) ──────────────────────────
//
// The invoice detail carries `editAction` and `editBlocked`, computed by the server for the viewing user
// (apps/api/src/invoices/invoice-edit-policy.ts). The clients render them and never re-derive:
//   EDIT       the Edit button opens the edit screen;
//   EDIT_ORDER the invoice comes from an order, so Edit goes to the order (the order edit restates the invoice);
//   null       the invoice cannot be edited now; `editBlocked.reason` says why.
// The PATCH refuses with 409 INVOICE_EDIT_REFUSED and the same reason, before any write.

export const INVOICE_EDIT_ACTION_VALUES = ["EDIT", "EDIT_ORDER"] as const;
export type InvoiceEditAction = (typeof INVOICE_EDIT_ACTION_VALUES)[number];

export const INVOICE_EDIT_BLOCK_REASONS = [
  "ORDER_LINKED",
  "PART_OF_ORDER",
  "NOT_ADMIN",
  "PAYING_CASH",
  "PAYING_ONLINE",
  "PENDING_PAYMENT",
  "PAID",
  "CREDIT",
  "VOID",
  "WRITTEN_OFF",
  "FILED",
  "ISSUE_DATE",
  "DEPOSIT",
  "ZERO_TOTAL",
  "UNIT_LINE",
  "TOTAL_NOT_FROM_LINES",
] as const;
export type InvoiceEditBlockReason = (typeof INVOICE_EDIT_BLOCK_REASONS)[number];

export interface InvoiceEditBlocked {
  reason: InvoiceEditBlockReason;
  /** Set when the invoice comes from an order (ORDER_LINKED, PART_OF_ORDER, and NOT_ADMIN's "Edit order" button). */
  orderId?: string | null;
  orderNumber?: string | null;
}

export interface InvoiceEditFields {
  editAction: InvoiceEditAction | null;
  editBlocked: InvoiceEditBlocked | null;
  /**
   * The verified flat rate an issued invoice's rate-0 goods lines are saved at (the screen shows and sends it); null on a
   * DRAFT, an order-linked invoice, or when the stored tax already reproduces. One source for both screens.
   */
  restampRate: number | null;
}

/** Why a money edit asks for consent: the tax was worked out the old way, or the stored total is not what the lines add up to. */
export const INVOICE_EDIT_CONSENT_CAUSES = ["OLDER_TAX", "TOTAL_NOT_FROM_LINES"] as const;
export type InvoiceEditConsentCause = (typeof INVOICE_EDIT_CONSENT_CAUSES)[number];

/**
 * The figures of a 409 INVOICE_EDIT_REFUSED whose reason is TOTAL_NOT_FROM_LINES (merged into the body). `difference` is
 * stored minus new, rounded by the server: positive = "Add a line for the difference", negative = "Add an invoice discount".
 */
export interface InvoiceEditConsentBody {
  storedTotal: number;
  newTotal: number;
  difference: number;
  storedTax: number;
  newTax: number;
  cause: InvoiceEditConsentCause;
}

/** PATCH /invoices/:id `acceptLineTotal`: the two figures the dialog showed, echoed back to confirm. */
export interface AcceptLineTotal {
  storedTotal: number;
  newTotal: number;
}
