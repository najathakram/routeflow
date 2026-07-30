import { serializeReportCsv } from "./report-csv";
import { RegulatedReport } from "./report-types";

/** Acme-style placeholder report, all four csv.* sections populated. */
const base: RegulatedReport = {
  template: "GENERIC",
  title: "Regulated Filing",
  categoryId: "cat-1",
  categoryName: "Tobacco",
  from: "2026-07-01",
  to: "2026-07-31",
  columns: [
    { key: "period", label: "Period" },
    { key: "qty", label: "Qty" },
  ],
  rows: [["2026-07", "10.000"]],
  totalsRow: ["TOTALS", "10.000"],
  displayTotals: [{ label: "Qty", value: "10.000" }],
  warnings: [],
  csv: {
    preamble: [["Regulated Filing", "Tobacco", "2026-07"]],
    includeHeader: true,
    includeTotals: true,
    footer: [["Note", "Coverage disclosure."]],
  },
};

describe("serializeReportCsv", () => {
  it("emits preamble, header, rows, totalsRow, footer in order with a trailing newline", () => {
    const csv = serializeReportCsv(base);
    const lines = csv.split("\n");
    expect(csv.endsWith("\n")).toBe(true);
    expect(lines[0]).toBe("Regulated Filing,Tobacco,2026-07");
    expect(lines[1]).toBe("Period,Qty");
    expect(lines[2]).toBe("2026-07,10.000");
    expect(lines[3]).toBe("TOTALS,10.000");
    expect(lines[4]).toBe("Note,Coverage disclosure.");
    expect(lines.length).toBe(6); // 5 content lines + trailing empty from the final \n
  });

  // ─── The four section toggles ──────────────────────────────────────────
  it("includeHeader:false omits the header row", () => {
    const csv = serializeReportCsv({ ...base, csv: { ...base.csv, includeHeader: false } });
    const lines = csv.split("\n");
    expect(lines).not.toContain("Period,Qty");
    expect(lines[0]).toBe("Regulated Filing,Tobacco,2026-07"); // preamble unaffected
    expect(lines[1]).toBe("2026-07,10.000"); // rows shift up
  });

  it("includeTotals:false omits the totals row even when totalsRow is present", () => {
    const csv = serializeReportCsv({ ...base, csv: { ...base.csv, includeTotals: false } });
    expect(csv.split("\n")).not.toContain("TOTALS,10.000");
  });

  it("a null totalsRow is omitted even when includeTotals is true (TX per-sale shape)", () => {
    const csv = serializeReportCsv({ ...base, totalsRow: null });
    expect(csv.split("\n")).not.toContain("TOTALS,10.000");
  });

  it("empty preamble/footer arrays contribute no lines", () => {
    const csv = serializeReportCsv({ ...base, csv: { ...base.csv, preamble: [], footer: [] } });
    const lines = csv.split("\n");
    expect(lines[0]).toBe("Period,Qty"); // header now first
    expect(lines).not.toContain("Note,Coverage disclosure.");
  });

  it("a TX-shaped report (no header, no totals, no preamble/footer) round-trips to just the rows", () => {
    const tx: RegulatedReport = {
      ...base,
      rows: [
        ["1", "2"],
        ["3", "4"],
      ],
      totalsRow: null,
      csv: { preamble: [], includeHeader: false, includeTotals: false, footer: [] },
    };
    const csv = serializeReportCsv(tx);
    expect(csv).toBe("1,2\n3,4\n");
  });

  // ─── Escaping ───────────────────────────────────────────────────────────
  it("escapes commas in preamble, row, totals, and footer cells alike", () => {
    const csv = serializeReportCsv({
      ...base,
      rows: [["2026-07", "Cigars, premium"]],
      totalsRow: ["TOTALS", "n/a, blank"],
      csv: {
        preamble: [["Title, subtitle", "Tobacco", "2026-07"]],
        includeHeader: true,
        includeTotals: true,
        footer: [["Note", "See disclosure, page 2."]],
      },
    });
    const lines = csv.split("\n");
    expect(lines[0]).toBe('"Title, subtitle",Tobacco,2026-07');
    expect(lines[2]).toBe('2026-07,"Cigars, premium"');
    expect(lines[3]).toBe('TOTALS,"n/a, blank"');
    expect(lines[4]).toBe('Note,"See disclosure, page 2."');
  });
});
