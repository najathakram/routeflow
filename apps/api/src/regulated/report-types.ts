/**
 * WP11: the shared row model behind BOTH the stateless regulated-report preview
 * (JSON, `GET /regulated/reports/preview`) and its CSV download
 * (`GET /regulated/reports/csv`). One `RegulatedReport` value serializes to both —
 * `report-csv.ts#serializeReportCsv` is the only place CSV escaping happens, so
 * what the operator previews in-app is literally the downloaded file's content.
 */

/**
 * The warning codes of a regulated report, in the order the shared list (`REGULATED_REPORT_WARNING_CODES` in
 * `@routeflow/types`) declares them. The API cannot value-import that package, so this is the local copy;
 * `report-warning-codes-parity.spec.ts` pins the two equal (members and order).
 */
export const REPORT_WARNING_CODES = [
  "MISSING_WHOLESALER_LICENSE",
  "MISSING_ITEM_TYPE",
  "MISSING_UOM",
  "MISSING_TAXPAYER_ID",
  "INVALID_TAXPAYER_ID",
  "MISSING_RETAILER_LICENSE",
  "INVALID_RETAILER_LICENSE",
  "INVALID_WHOLESALER_LICENSE",
  "MISSING_ADDRESS",
  "NEGATIVE_NET_INVOICE",
  "FRACTIONAL_QTY",
  "UNLINKED_LEDGER_ROWS",
  "UNMATCHED_LEDGER_LINE",
  "UNLISTED_PRODUCT_LINE",
  "UNCATEGORISED_LINE_IN_RULE_STATE",
  "PARKED_REVERSALS",
] as const;

export type ReportWarningCode = (typeof REPORT_WARNING_CODES)[number];

export interface ReportWarning {
  code: ReportWarningCode;
  /** A complete human sentence, ready to render in the UI. */
  message: string;
  invoiceId?: string;
  customerName?: string;
  productId?: string;
}

export interface ReportColumn {
  key: string;
  label: string;
  align?: "right";
}

/**
 * One report, in a shape that serializes to BOTH the in-app preview (JSON) and the CSV file.
 * `rows` holds fully FORMATTED cells in `columns` order — the preview table and the downloaded
 * file therefore cannot drift.
 */
export interface RegulatedReport {
  /** Unresolved parked return reversals of the range (listed FIRST; not in the figures). Absent = none. */
  parked?: import("./parked-reversals").ParkedReversalRow[];
  /** A stock note: return restocks parked for the same reason. Never blocks. */
  parkedRestockNote?: string | null;
  template: string;
  title: string;
  categoryId: string;
  categoryName: string;
  /** Inclusive YYYY-MM-DD range, echoed back for display. */
  from: string;
  to: string;
  columns: ReportColumn[];
  rows: string[][];
  /** Aggregate templates only; null for per-sale templates like TX. */
  totalsRow: string[] | null;
  /** Headline figures for the preview UI (not necessarily in the CSV). */
  displayTotals: { label: string; value: string }[];
  warnings: ReportWarning[];
  /** True when the column layout deviates from the template's official default. */
  custom?: boolean;
  csv: {
    preamble: string[][];
    includeHeader: boolean;
    includeTotals: boolean;
    footer: string[][];
  };
}
