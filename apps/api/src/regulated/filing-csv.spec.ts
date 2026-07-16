import { buildFilingCsv, FilingCsvData } from "./filing-csv";

const base: FilingCsvData = {
  categoryName: "Tobacco",
  unitBasis: "pack",
  periodKey: "2026-07",
  rows: [{ periodBucket: "2026-07", qty: 10, unitBasisQty: 20, netSales: 100, categoryTax: 5 }],
  totals: { qty: 10, unitBasisQty: 20, netSales: 100, categoryTax: 5 },
};

describe("buildFilingCsv", () => {
  it("GENERIC → title, header, row, TOTALS, disclosure, trailing newline", () => {
    const csv = buildFilingCsv("GENERIC", base);
    const lines = csv.split("\n");
    expect(csv.endsWith("\n")).toBe(true);
    expect(lines[0]).toBe("Regulated Filing,Tobacco,2026-07");
    expect(lines[1]).toBe("Period,Qty,Unit Basis Qty,Net Sales,Category Tax");
    expect(lines[2]).toBe("2026-07,10.000,20.000,100.00,5.00");
    expect(lines[3]).toBe("TOTALS,10.000,20.000,100.00,5.00");
    expect(lines[4]).toContain("Note,");
    expect(lines[4]).toContain("regulated ledger");
  });

  it("escapes a category name containing a comma", () => {
    const csv = buildFilingCsv("GENERIC", { ...base, categoryName: "Cigars, premium" });
    expect(csv.split("\n")[0]).toBe('Regulated Filing,"Cigars, premium",2026-07');
  });

  it("CA_CDTFA → excise columns with the unit-basis label", () => {
    const csv = buildFilingCsv("CA_CDTFA", base);
    const lines = csv.split("\n");
    expect(lines[0]).toBe("CDTFA Excise Filing,Tobacco,2026-07");
    expect(lines[1]).toBe("Period,Units (pack),Net Sales,Excise Tax Due");
    expect(lines[2]).toBe("2026-07,20.000,100.00,5.00");
    expect(lines[3]).toBe("TOTALS,20.000,100.00,5.00");
  });

  it("CA_ABC → volume columns", () => {
    expect(buildFilingCsv("CA_ABC", base).split("\n")[1]).toBe(
      "Period,Volume (pack),Net Sales,Tax",
    );
  });

  it("CALRECYCLE → container/CRV columns", () => {
    expect(buildFilingCsv("CALRECYCLE", base).split("\n")[1]).toBe(
      "Period,Containers,Net Sales,CRV Deposit",
    );
  });

  it("unknown template falls back to GENERIC (never throws)", () => {
    const csv = buildFilingCsv("SOME_TYPO", base);
    expect(csv.split("\n")[0]).toBe("Regulated Filing,Tobacco,2026-07");
  });

  it("does NOT clamp a reversal-heavy negative total", () => {
    const csv = buildFilingCsv("GENERIC", {
      ...base,
      rows: [
        { periodBucket: "2026-07", qty: -2, unitBasisQty: -4, netSales: -30, categoryTax: -2 },
      ],
      totals: { qty: -2, unitBasisQty: -4, netSales: -30, categoryTax: -2 },
    });
    expect(csv).toContain("TOTALS,-2.000,-4.000,-30.00,-2.00");
  });

  it("falls back to 'unit' when unitBasis is null", () => {
    expect(buildFilingCsv("CA_CDTFA", { ...base, unitBasis: null }).split("\n")[1]).toBe(
      "Period,Units (unit),Net Sales,Excise Tax Due",
    );
  });

  // ─── RF-3: optional Subcategory column ────────────────────────────────────
  it("withSubcategory injects a Subcategory column after Period (GENERIC)", () => {
    const csv = buildFilingCsv("GENERIC", {
      ...base,
      withSubcategory: true,
      rows: [
        {
          periodBucket: "2026-07",
          subcategoryName: "Cigarettes",
          qty: 10,
          unitBasisQty: 20,
          netSales: 100,
          categoryTax: 5,
        },
      ],
    });
    const lines = csv.split("\n");
    expect(lines[1]).toBe("Period,Subcategory,Qty,Unit Basis Qty,Net Sales,Category Tax");
    expect(lines[2]).toBe("2026-07,Cigarettes,10.000,20.000,100.00,5.00");
    expect(lines[3]).toBe("TOTALS,,10.000,20.000,100.00,5.00"); // blank subcategory cell
  });

  it("withSubcategory leaves the cell blank for a null subcategory and escapes commas", () => {
    const csv = buildFilingCsv("CA_CDTFA", {
      ...base,
      withSubcategory: true,
      rows: [
        {
          periodBucket: "2026-07",
          subcategoryName: null,
          qty: 10,
          unitBasisQty: 20,
          netSales: 100,
          categoryTax: 5,
        },
        {
          periodBucket: "2026-07",
          subcategoryName: "Wine, sparkling",
          qty: 1,
          unitBasisQty: 2,
          netSales: 10,
          categoryTax: 1,
        },
      ],
    });
    const lines = csv.split("\n");
    expect(lines[1]).toBe("Period,Subcategory,Units (pack),Net Sales,Excise Tax Due");
    expect(lines[2]).toBe("2026-07,,20.000,100.00,5.00"); // null → blank cell
    expect(lines[3]).toBe('2026-07,"Wine, sparkling",2.000,10.00,1.00'); // comma escaped
  });

  it("without withSubcategory the CSV is unchanged (no Subcategory column)", () => {
    const csv = buildFilingCsv("GENERIC", {
      ...base,
      rows: [
        {
          periodBucket: "2026-07",
          subcategoryName: "Cigarettes", // present on the row but flag is off
          qty: 10,
          unitBasisQty: 20,
          netSales: 100,
          categoryTax: 5,
        },
      ],
    });
    expect(csv.split("\n")[1]).toBe("Period,Qty,Unit Basis Qty,Net Sales,Category Tax");
  });
});
