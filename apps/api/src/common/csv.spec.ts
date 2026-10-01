import { CSV_BOM, csvCell, csvRow } from "./csv";

describe("common/csv", () => {
  it("prefixes formula leads on strings (ASCII and full-width)", () => {
    for (const lead of ["=", "+", "-", "@", "\t", "\r", "＝", "＋", "－", "＠"]) {
      const out = csvCell(`${lead}x`);
      expect(out.replace(/^"/, "").startsWith("'")).toBe(true);
    }
    expect(csvCell("=SUM(1)")).toBe("'=SUM(1)");
  });

  it("quotes commas, quotes and newlines", () => {
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell("a\nb")).toBe('"a\nb"');
    expect(csvCell("plain")).toBe("plain");
  });

  it("leaves numbers and booleans untouched, null/undefined empty", () => {
    expect(csvCell(-5)).toBe("-5");
    expect(csvCell(1.5)).toBe("1.5");
    expect(csvCell(true)).toBe("true");
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });

  it("csvRow joins cells with commas and ends with CRLF", () => {
    expect(csvRow(["a", 1, null, "=x"])).toBe("a,1,,'=x\r\n");
  });

  it("exposes the UTF-8 BOM", () => {
    expect(CSV_BOM).toBe("﻿");
  });
});
