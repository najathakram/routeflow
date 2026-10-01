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

  describe("numeric-text exemption (SA-629c): only numeric-only text stays unprefixed", () => {
    it.each([
      "-12.50",
      "-5",
      "0.00",
      "12",
      "-0.5",
      "+1 555 123 4567",
      "(555) 123-4567",
      "555-123-4567",
    ])("leaves the numeric text %s untouched", (n) => {
      expect(csvCell(n)).toBe(n);
    });

    it.each([
      "=1+1",
      "+SUM(A1)",
      "-2+cmd|' /C calc'!A0",
      "@x",
      "+1e5",
      "-1e5",
      "-A1",
      "+1;2",
      "-5x",
      "-12,50",
      "=1",
      "+",
      "-",
      "+ ",
      "\tSUM(1)",
      "\r1",
      "\n1",
      "＋1 555",
    ])("still guards %j (not numeric-only text)", (v) => {
      expect(csvCell(v).replace(/^"/, "").startsWith("'")).toBe(true);
    });
  });

  describe("verbatim mode ({ guard: false }) — regulator/audit artifacts are never edited", () => {
    it("adds NO apostrophe to a formula lead, but still quotes commas, quotes and newlines", () => {
      expect(csvCell("=SUM(1)", { guard: false })).toBe("=SUM(1)");
      expect(csvCell("-x", { guard: false })).toBe("-x");
      expect(csvCell('a,"b"', { guard: false })).toBe('"a,""b"""');
      expect(csvCell("a\nb", { guard: false })).toBe('"a\nb"');
    });
    it("quotes exactly like the legacy regulated/tobacco escapers: comma, quote, LF only (a bare CR is NOT quoted)", () => {
      expect(csvCell("a\rb", { guard: false })).toBe("a\rb");
      expect(csvCell("a\r\nb", { guard: false })).toBe('"a\r\nb"');
    });
    it("null/undefined/numbers behave as in guarded mode", () => {
      expect(csvCell(null, { guard: false })).toBe("");
      expect(csvCell(-5, { guard: false })).toBe("-5");
    });
  });

  it("csvRow joins cells with commas and ends with CRLF", () => {
    expect(csvRow(["a", 1, null, "=x"])).toBe("a,1,,'=x\r\n");
  });

  it("exposes the UTF-8 BOM", () => {
    expect(CSV_BOM).toBe("﻿");
  });
});
