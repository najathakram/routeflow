import { RegulatedReport } from "./report-types";

/**
 * Project a built report onto `keys` (order = output order). `rows` and `totalsRow`
 * are remapped through ONE index map derived from `report.columns`, so the JSON
 * preview and the CSV project identically — the single-source invariant that keeps
 * what an operator previews equal to what they download.
 *
 * `warnings` are deliberately kept in full: they describe the quality of the
 * underlying filing data, and hiding the Taxpayer ID column does not make a missing
 * taxpayer ID acceptable. `displayTotals`, `csv.preamble` and `csv.footer` are not
 * column-shaped and pass through untouched.
 */
export function projectReportColumns(report: RegulatedReport, keys: string[]): RegulatedReport {
  if (!keys.length) throw new Error("At least one column is required");
  const indexByKey = new Map(report.columns.map((c, i) => [c.key, i]));
  const idx: number[] = [];
  const unknown: string[] = [];
  for (const k of keys) {
    const i = indexByKey.get(k);
    if (i === undefined) unknown.push(k);
    else idx.push(i);
  }
  if (unknown.length) throw new Error(`Unknown column(s): ${unknown.join(", ")}`);
  const pick = (row: string[]) => idx.map((i) => row[i] ?? "");
  return {
    ...report,
    columns: idx.map((i) => report.columns[i]),
    rows: report.rows.map(pick),
    totalsRow: report.totalsRow ? pick(report.totalsRow) : null,
  };
}
