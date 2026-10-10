import { csvDate, csvFilename } from "@/lib/export";

type Cell = string | number | null;

/** Row shapes of the analytics cards (structurally the page's own interfaces). */
export interface RevenuePeriodRow {
  period: string;
  revenue: number;
}
export interface DsoRow {
  dso: number;
  count: number;
}
export interface GrossMarginRow {
  revenue: number;
  cogs: number;
  grossProfit: number;
  grossMarginPct: number;
}
export interface CategoryRow {
  category: string;
  revenue: number;
}
export interface TopProductRow {
  id: string;
  name: string;
  totalRevenue: number;
  unitsSold: number;
}
export interface TurnoverRow {
  id: string;
  name: string;
  unitsSold: number;
  currentStock: number;
  turnoverRate: number;
}
export interface DeadStockRow {
  id: string;
  name: string;
  currentStock: number;
  lastMovement: string | null;
  daysInactive: number | null;
}
export interface MarginAlertRow {
  id: string;
  name: string;
  price: number;
  cost: number;
  marginPct: number;
}
export interface TopCustomerRow {
  id: string;
  name: string;
  totalRevenue: number;
  orderCount: number;
}
interface OpsMetrics {
  onTimeRate: number | null;
  stopsPerHour: number | null;
  avgRunDurationMinutes: number | null;
}
export interface RoutePerfRow extends OpsMetrics {
  id: string;
  name: string;
  totalRuns: number;
  completedRuns: number;
  completionRate: number;
}
export interface DriverPerfRow extends OpsMetrics {
  id: string;
  name: string;
  totalDeliveries: number;
  completedDeliveries: number;
  completionRate: number;
}

interface Section<T> {
  headers: string[];
  rows: (data: T) => Cell[][];
}

const section = <T>(headers: string[], rows: (data: T) => Cell[][]): Section<T> => ({
  headers,
  rows,
});

/** null (no measurable data) stays blank — distinct from a real 0. */
const blank = (v: number | null): Cell => (v == null ? "" : v);

const opsCells = (r: OpsMetrics): Cell[] => [
  blank(r.onTimeRate),
  blank(r.stopsPerHour),
  blank(r.avgRunDurationMinutes),
];
const OPS_HEADERS = ["On-time %", "Stops/hr", "Avg duration (min)"];

/**
 * Per-card CSV column specs: raw numbers (no currency/locale formatting), dates as YYYY-MM-DD,
 * names raw — `downloadCsv` applies the formula-injection guard. Slug → filename segment.
 */
export const ANALYTICS_CSV = {
  "revenue-trend": section<RevenuePeriodRow[]>(["Period", "Revenue"], (d) =>
    d.map((r) => [r.period, r.revenue]),
  ),
  aov: section<number | null>(["Average order value"], (d) => (d == null ? [] : [[d]])),
  dso: section<DsoRow | null>(["DSO (days)", "Invoices counted"], (d) =>
    d ? [[d.dso, d.count]] : [],
  ),
  "gross-margin": section<GrossMarginRow | null>(
    ["Revenue", "COGS", "Gross profit", "Gross margin %"],
    (d) => (d ? [[d.revenue, d.cogs, d.grossProfit, d.grossMarginPct]] : []),
  ),
  // Every category — the chart folds the tail into "Other", a spreadsheet needs the detail.
  "sales-by-category": section<CategoryRow[]>(["Category", "Revenue"], (d) =>
    d.map((r) => [r.category, r.revenue]),
  ),
  "top-products": section<TopProductRow[]>(["Product", "Revenue", "Units sold"], (d) =>
    d.map((r) => [r.name, r.totalRevenue, r.unitsSold]),
  ),
  "inventory-turnover": section<TurnoverRow[]>(
    ["Product", "Units sold", "Current stock", "Turnover rate"],
    (d) => d.map((r) => [r.name, r.unitsSold, r.currentStock, r.turnoverRate]),
  ),
  "dead-stock": section<DeadStockRow[]>(
    ["Product", "Stock", "Last movement", "Days inactive"],
    (d) => d.map((r) => [r.name, r.currentStock, csvDate(r.lastMovement), blank(r.daysInactive)]),
  ),
  "margin-alerts": section<MarginAlertRow[]>(["Product", "Price", "Cost", "Margin %"], (d) =>
    d.map((r) => [r.name, r.price, r.cost, r.marginPct]),
  ),
  "top-customers": section<TopCustomerRow[]>(["#", "Customer", "Total revenue", "Orders"], (d) =>
    d.map((r, i) => [i + 1, r.name, r.totalRevenue, r.orderCount]),
  ),
  "route-performance": section<RoutePerfRow[]>(
    ["Route", "Total runs", "Completed", "Completion rate %", ...OPS_HEADERS],
    (d) => d.map((r) => [r.name, r.totalRuns, r.completedRuns, r.completionRate, ...opsCells(r)]),
  ),
  "driver-performance": section<DriverPerfRow[]>(
    ["Driver", "Total deliveries", "Completed", "Completion rate %", ...OPS_HEADERS],
    (d) =>
      d.map((r) => [
        r.name,
        r.totalDeliveries,
        r.completedDeliveries,
        r.completionRate,
        ...opsCells(r),
      ]),
  ),
};

export type AnalyticsCsvSlug = keyof typeof ANALYTICS_CSV;
export type AnalyticsCsvData<S extends AnalyticsCsvSlug> = Parameters<
  (typeof ANALYTICS_CSV)[S]["rows"]
>[0];

/** analytics-<slug>-<from>-to-<to>.csv from the applied date range. */
export function analyticsCsvFilename(slug: AnalyticsCsvSlug, from: string, to: string): string {
  return csvFilename(`analytics-${slug}`, from, to);
}
