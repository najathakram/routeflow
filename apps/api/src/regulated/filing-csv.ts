/**
 * Phase 4 (W5b): builds a regulated-filing CSV, generalizing the tobacco report's
 * hand-rolled CSV (no csv-stringify/papaparse — the codebase builds CSV by hand).
 * The category's `reportTemplate` drives the column set; an unknown template falls
 * back to GENERIC (never throws — a bad category config must not break filing prep).
 * Every number is already roundMoney'd by the caller; nothing here re-signs or
 * clamps, so a reversal-heavy period legitimately renders negative totals.
 *
 * WP11: refactored into `buildAggregateReport`, which builds the shared
 * `RegulatedReport` row model (report-types.ts) instead of CSV text directly.
 * `buildFilingCsv` is now a thin `serializeReportCsv(buildAggregateReport(...))`
 * wrapper — its exported signature and byte-for-byte output are UNCHANGED
 * (filing-csv.spec.ts is the byte-identity gate and is not touched by this
 * refactor). `buildAggregateReport` is also reused by `regulated-report.service.ts`
 * for the stateless, arbitrary-date-range report preview/CSV endpoints.
 */

import { ReportColumn, RegulatedReport } from "./report-types";
import { serializeReportCsv } from "./report-csv";

export interface FilingCsvRow {
  periodBucket: string;
  qty: number;
  unitBasisQty: number;
  netSales: number;
  categoryTax: number;
  // RF-3: reporting subcategory label for this row. Rendered as an extra column only
  // when the caller sets `withSubcategory`; blank when the row has no subcategory.
  subcategoryName?: string | null;
}

export interface FilingCsvTotals {
  qty: number;
  unitBasisQty: number;
  netSales: number;
  categoryTax: number;
}

export interface FilingCsvData {
  categoryName: string;
  unitBasis: string | null;
  periodKey: string;
  rows: FilingCsvRow[];
  totals: FilingCsvTotals;
  // RF-3: when true, inject a "Subcategory" column (after Period) for the per-subcategory
  // breakdown. Absent/false → byte-identical to the pre-RF-3 section-level CSV.
  withSubcategory?: boolean;
}

/**
 * WP11: input to `buildAggregateReport`. `periodLabel` is the human period string
 * rendered into the CSV preamble — the legacy `periodKey` (e.g. "2026-07") for
 * filings, or an arbitrary "YYYY-MM-DD to YYYY-MM-DD" range label for the
 * stateless report preview. `categoryId`/`from`/`to` are ONLY known by the
 * stateless report caller (regulated-report.service.ts); legacy filing callers
 * omit them and get harmless placeholders — a filing is period-keyed, not
 * date-ranged, and never renders those fields.
 */
export interface AggregateReportInput extends FilingCsvData {
  periodLabel: string;
  categoryId?: string;
  from?: string;
  to?: string;
}

// Coverage disclosure: the ledger only captures the order→invoice path today
// (manual/partial/draft-edit invoice paths are deferred W5b/c follow-ups), so a
// filing is only as complete as the ledger. Surfaced on every filing artifact.
const DISCLOSURE = "Based on order-to-invoice sales recorded in the regulated ledger.";

const money = (n: number) => n.toFixed(2);
const qty = (n: number) => n.toFixed(3);

/**
 * Build the shared RegulatedReport row model for an aggregate (period-bucket)
 * template — CA_CDTFA / CA_ABC / CALRECYCLE / GENERIC fallback. Pure: no CSV
 * escaping happens here (that's `serializeReportCsv`'s job) — every cell is a
 * fully-formatted but UNESCAPED string, so the JSON preview renders it as-is.
 */
export function buildAggregateReport(
  template: string,
  data: AggregateReportInput,
): RegulatedReport {
  const { categoryName, unitBasis, rows, totals, periodLabel } = data;
  const unit = unitBasis || "unit";
  const withSub = !!data.withSubcategory;

  let title: string;
  let columns: ReportColumn[];
  let rowCols: (r: FilingCsvRow) => string[];
  let totalCols: string[];

  switch (template) {
    case "CA_CDTFA": // excise / tobacco state filing — units + excise tax
      title = "CDTFA Excise Filing";
      columns = [
        { key: "period", label: "Period" },
        { key: "units", label: `Units (${unit})` },
        { key: "netSales", label: "Net Sales" },
        { key: "tax", label: "Excise Tax Due" },
      ];
      rowCols = (r) => [
        r.periodBucket,
        qty(r.unitBasisQty),
        money(r.netSales),
        money(r.categoryTax),
      ];
      totalCols = [
        "TOTALS",
        qty(totals.unitBasisQty),
        money(totals.netSales),
        money(totals.categoryTax),
      ];
      break;
    case "CA_ABC": // alcohol — volume
      title = "ABC Alcohol Filing";
      columns = [
        { key: "period", label: "Period" },
        { key: "volume", label: `Volume (${unit})` },
        { key: "netSales", label: "Net Sales" },
        { key: "tax", label: "Tax" },
      ];
      rowCols = (r) => [
        r.periodBucket,
        qty(r.unitBasisQty),
        money(r.netSales),
        money(r.categoryTax),
      ];
      totalCols = [
        "TOTALS",
        qty(totals.unitBasisQty),
        money(totals.netSales),
        money(totals.categoryTax),
      ];
      break;
    case "CALRECYCLE": // CRV deposits — container count
      title = "CalRecycle CRV Filing";
      columns = [
        { key: "period", label: "Period" },
        { key: "containers", label: "Containers" },
        { key: "netSales", label: "Net Sales" },
        { key: "deposit", label: "CRV Deposit" },
      ];
      rowCols = (r) => [
        r.periodBucket,
        qty(r.unitBasisQty),
        money(r.netSales),
        money(r.categoryTax),
      ];
      totalCols = [
        "TOTALS",
        qty(totals.unitBasisQty),
        money(totals.netSales),
        money(totals.categoryTax),
      ];
      break;
    case "GENERIC":
    default: // GENERIC + any unknown/typo template — the safe fallback
      title = "Regulated Filing";
      columns = [
        { key: "period", label: "Period" },
        { key: "qty", label: "Qty" },
        { key: "unitBasisQty", label: "Unit Basis Qty" },
        { key: "netSales", label: "Net Sales" },
        { key: "categoryTax", label: "Category Tax" },
      ];
      rowCols = (r) => [
        r.periodBucket,
        qty(r.qty),
        qty(r.unitBasisQty),
        money(r.netSales),
        money(r.categoryTax),
      ];
      totalCols = [
        "TOTALS",
        qty(totals.qty),
        qty(totals.unitBasisQty),
        money(totals.netSales),
        money(totals.categoryTax),
      ];
      break;
  }

  // RF-3: additive "Subcategory" column, spliced in right after Period — only when
  // the caller opts in. Off by default → byte-identical to the pre-RF-3 CSV.
  if (withSub) {
    columns = [columns[0], { key: "subcategory", label: "Subcategory" }, ...columns.slice(1)];
  }
  const rowsOut: string[][] = rows.map((r) => {
    const cols = rowCols(r);
    return withSub ? [cols[0], r.subcategoryName ?? "", ...cols.slice(1)] : cols;
  });
  const totalsRow = withSub ? [totalCols[0], "", ...totalCols.slice(1)] : totalCols;

  return {
    template,
    title,
    categoryId: data.categoryId ?? "",
    categoryName,
    from: data.from ?? periodLabel,
    to: data.to ?? periodLabel,
    columns,
    rows: rowsOut,
    totalsRow,
    displayTotals: [
      { label: "Net Sales", value: money(totals.netSales) },
      { label: "Category Tax", value: money(totals.categoryTax) },
    ],
    warnings: [],
    csv: {
      preamble: [[title, categoryName, periodLabel]],
      includeHeader: true,
      includeTotals: true,
      footer: [["Note", DISCLOSURE]],
    },
  };
}

/**
 * Byte-identical to the pre-WP11 implementation — filing-csv.spec.ts is the
 * byte-identity gate and must keep passing unmodified.
 */
export function buildFilingCsv(template: string, data: FilingCsvData): string {
  return serializeReportCsv(
    buildAggregateReport(template, { ...data, periodLabel: data.periodKey }),
  );
}
