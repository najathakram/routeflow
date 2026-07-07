/**
 * Phase 4 (W5b): builds a regulated-filing CSV, generalizing the tobacco report's
 * hand-rolled CSV (no csv-stringify/papaparse — the codebase builds CSV by hand).
 * The category's `reportTemplate` drives the column set; an unknown template falls
 * back to GENERIC (never throws — a bad category config must not break filing prep).
 * Every number is already roundMoney'd by the caller; nothing here re-signs or
 * clamps, so a reversal-heavy period legitimately renders negative totals.
 */

export interface FilingCsvRow {
  periodBucket: string;
  qty: number;
  unitBasisQty: number;
  netSales: number;
  categoryTax: number;
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
}

// Coverage disclosure: the ledger only captures the order→invoice path today
// (manual/partial/draft-edit invoice paths are deferred W5b/c follow-ups), so a
// filing is only as complete as the ledger. Surfaced on every filing artifact.
const DISCLOSURE = "Based on order-to-invoice sales recorded in the regulated ledger.";

/** Standard CSV field escaping (identical to tobacco-report.service + customers.service). */
function esc(v: string | null): string {
  const s = v ?? "";
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const money = (n: number) => n.toFixed(2);
const qty = (n: number) => n.toFixed(3);

export function buildFilingCsv(template: string, data: FilingCsvData): string {
  const { categoryName, unitBasis, periodKey, rows, totals } = data;
  const unit = unitBasis || "unit";

  let title: string;
  let header: string;
  let rowCols: (r: FilingCsvRow) => string[];
  let totalCols: string[];

  switch (template) {
    case "CA_CDTFA": // excise / tobacco state filing — units + excise tax
      title = "CDTFA Excise Filing";
      header = `Period,Units (${unit}),Net Sales,Excise Tax Due`;
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
      header = `Period,Volume (${unit}),Net Sales,Tax`;
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
      header = "Period,Containers,Net Sales,CRV Deposit";
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
      header = "Period,Qty,Unit Basis Qty,Net Sales,Category Tax";
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

  const lines = [
    `${title},${esc(categoryName)},${periodKey}`,
    header,
    ...rows.map((r) => rowCols(r).join(",")),
    totalCols.join(","),
    `Note,${esc(DISCLOSURE)}`,
  ];
  return lines.join("\n") + "\n";
}
