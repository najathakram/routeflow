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
