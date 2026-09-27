/**
 * #2118 — runtime copies of the shared insights limits (`@routeflow/types`
 * `analytics-insights.ts`), which the API may only `import type`. Pinned equal to the shared
 * values by `sales-facts.contract.spec.ts`. The window limits live with the window helper
 * (`analytics/demand-range.ts`).
 */

/** Most lines one CSV export streams before it writes a truncation row. */
export const INSIGHT_CSV_MAX_LINES = 50_000;

/** Buyers `GET /analytics/products/:id/insights` returns unless `?buyers=all`. */
export const INSIGHT_TOP_BUYERS = 50;

/** Default and maximum page size of `GET /analytics/products/:id/sales`. */
export const SALES_PAGE_DEFAULT_LIMIT = 100;
export const SALES_PAGE_MAX_LIMIT = 500;
