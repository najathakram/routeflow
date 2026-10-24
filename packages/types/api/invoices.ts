import type { API_ERROR_CODES } from "./error-codes";

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
