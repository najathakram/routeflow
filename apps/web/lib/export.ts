/**
 * Client-side CSV export utility.
 * Accepts rows as arrays of values; builds a CSV blob and triggers a download.
 */
type CsvCell = string | number | boolean | null | undefined;

/** UTF-8 byte-order mark so Excel opens the file as UTF-8. */
const CSV_BOM = "\uFEFF";

/** Text a spreadsheet may run as a formula: = + - @ tab CR LF and the full-width forms
 *  (OWASP CSV injection). Same set as the server's `csvCell`. */
const FORMULA_LEAD = /^[=+\-@\t\r\n＝＋－＠]/;
/** A plain number written as a string (`toFixed(2)` money): safe, and must stay numeric. */
const PLAIN_NUMBER = /^[+-]?\d+(\.\d+)?$/;

function escapeCsvCell(v: CsvCell): string {
  if (v == null) return "";
  // Numbers/booleans are never text a user typed, so a negative amount stays numeric.
  let s = String(v);
  if (typeof v === "string" && FORMULA_LEAD.test(s) && !PLAIN_NUMBER.test(s)) s = `'${s}`;
  // Quote if contains comma, newline, or double-quote
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Trigger a browser download of a Blob under `filename`. */
export function downloadCsvBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** `prefix-YYYY-MM-DD.csv`, or `prefix-<from>-to-<to>.csv` when a range is given. */
export function csvFilename(prefix: string, from?: string | null, to?: string | null): string {
  if (from && to) return `${prefix}-${from}-to-${to}.csv`;
  return `${prefix}-${new Date().toISOString().slice(0, 10)}.csv`;
}

export function downloadCsv(filename: string, headers: string[], rows: CsvCell[][]): void {
  const lines = [
    headers.map(escapeCsvCell).join(","),
    ...rows.map((row) => row.map(escapeCsvCell).join(",")),
  ];
  const blob = new Blob([CSV_BOM + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
  downloadCsvBlob(filename, blob);
}

/** Format a date string for CSV (YYYY-MM-DD) */
export function csvDate(d?: string | null): string {
  if (!d) return "";
  return d.split("T")[0];
}
