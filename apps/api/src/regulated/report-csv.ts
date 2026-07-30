import { RegulatedReport } from "./report-types";

/**
 * Standard CSV field escaping (moved verbatim from filing-csv.ts, W5b). Shared by
 * every regulated CSV — aggregate filings (filing-csv.ts) and the per-sale TX
 * Comptroller report (tx-report.ts) alike.
 */
export function esc(v: string | null | undefined): string {
  const s = v ?? "";
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Serialize a RegulatedReport into CSV bytes: `csv.preamble` rows, then the header
 * row only when `csv.includeHeader`, then `rows`, then `totalsRow` only when
 * `csv.includeTotals` (and present), then `csv.footer` — joined with "\n" and
 * ending in a trailing newline.
 *
 * `report.rows`/`totalsRow`/`csv.preamble`/`csv.footer` hold fully FORMATTED but
 * UNESCAPED cells — this is the single place CSV escaping is applied, so the JSON
 * preview (raw text) and the CSV download (escaped) can never drift on content.
 */
export function serializeReportCsv(report: RegulatedReport): string {
  const lines: string[] = [];

  for (const row of report.csv.preamble) lines.push(row.map(esc).join(","));

  if (report.csv.includeHeader) {
    lines.push(report.columns.map((c) => esc(c.label)).join(","));
  }

  for (const row of report.rows) lines.push(row.map(esc).join(","));

  if (report.csv.includeTotals && report.totalsRow) {
    lines.push(report.totalsRow.map(esc).join(","));
  }

  for (const row of report.csv.footer) lines.push(row.map(esc).join(","));

  return lines.join("\n") + "\n";
}
