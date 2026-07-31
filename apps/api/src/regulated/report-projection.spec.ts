import { projectReportColumns } from "./report-projection";
import { RegulatedReport } from "./report-types";

/** Acme-style placeholder report with a base TX-ish shape: 4 columns, 2 rows, a totalsRow. */
const base: RegulatedReport = {
  template: "TX_COMPTROLLER",
  title: "TX Comptroller Report",
  categoryId: "cat-1",
  categoryName: "Tobacco",
  from: "2026-07-01",
  to: "2026-07-31",
  columns: [
    { key: "retailerName", label: "Retailer Name" },
    { key: "itemType", label: "Item Type" },
    { key: "uom", label: "Unit of Measure" },
    { key: "quantity", label: "Quantity", align: "right" },
  ],
  rows: [
    ["Acme Retail", "1", "CP", "10"],
    ["Acme Wholesale", "3", "WO", "5"],
  ],
  totalsRow: ["TOTALS", "", "", "15"],
  displayTotals: [{ label: "Total Quantity", value: "15" }],
  warnings: [{ code: "MISSING_UOM", message: '"Widget" has no regulatory unit of measure.' }],
  csv: {
    preamble: [["TX Comptroller Report", "Tobacco", "2026-07-01", "2026-07-31"]],
    includeHeader: false,
    includeTotals: false,
    footer: [],
  },
};

describe("projectReportColumns", () => {
  it("subsets columns while preserving cell↔column alignment", () => {
    const out = projectReportColumns(base, ["retailerName", "quantity"]);
    expect(out.columns.map((c) => c.key)).toEqual(["retailerName", "quantity"]);
    expect(out.rows).toEqual([
      ["Acme Retail", "10"],
      ["Acme Wholesale", "5"],
    ]);
  });

  it("reorders columns per the requested key order", () => {
    const out = projectReportColumns(base, ["quantity", "itemType", "retailerName"]);
    expect(out.columns.map((c) => c.key)).toEqual(["quantity", "itemType", "retailerName"]);
    expect(out.rows[0]).toEqual(["10", "1", "Acme Retail"]);
    expect(out.rows[1]).toEqual(["5", "3", "Acme Wholesale"]);
  });

  it("remaps totalsRow through the same index map as rows", () => {
    const out = projectReportColumns(base, ["quantity", "retailerName"]);
    expect(out.totalsRow).toEqual(["15", "TOTALS"]);
  });

  it("keeps a null totalsRow null", () => {
    const out = projectReportColumns({ ...base, totalsRow: null }, ["quantity"]);
    expect(out.totalsRow).toBeNull();
  });

  it("throws on an unknown column key", () => {
    expect(() => projectReportColumns(base, ["retailerName", "bogusKey"])).toThrow(
      /Unknown column\(s\): bogusKey/,
    );
  });

  it("throws when keys is empty", () => {
    expect(() => projectReportColumns(base, [])).toThrow(/At least one column is required/);
  });

  it("passes warnings, displayTotals, csv.preamble and csv.footer through untouched", () => {
    const out = projectReportColumns(base, ["retailerName"]);
    expect(out.warnings).toBe(base.warnings);
    expect(out.displayTotals).toBe(base.displayTotals);
    expect(out.csv.preamble).toBe(base.csv.preamble);
    expect(out.csv.footer).toBe(base.csv.footer);
  });

  it("emits a duplicate requested key twice, once per occurrence", () => {
    const out = projectReportColumns(base, ["retailerName", "retailerName"]);
    expect(out.columns.map((c) => c.key)).toEqual(["retailerName", "retailerName"]);
    expect(out.rows[0]).toEqual(["Acme Retail", "Acme Retail"]);
    expect(out.rows[1]).toEqual(["Acme Wholesale", "Acme Wholesale"]);
  });
});
