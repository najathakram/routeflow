import { readFileSync } from "fs";
import { join } from "path";

/**
 * SA-1029 PDF-R1. The template is globally stubbed under Jest (see invoice-pdf.service.spec.ts),
 * so the five-header column is source-pinned, the house pattern for template wiring.
 */
const src = readFileSync(join(__dirname, "invoice-pdf-template.tsx"), "utf8");
const headerBlock = (): string => {
  const at = src.indexOf("styles.tableHeader}");
  expect(at).toBeGreaterThan(-1);
  return src.slice(at, src.indexOf("</View>", at));
};

describe("invoice-pdf-template — per-piece column (SA-1029 PDF-R1)", () => {
  it("PDF-R1: the header row has five columns including Per piece", () => {
    const block = headerBlock();
    expect(block.match(/styles\.tableHeaderText/g)).toHaveLength(5);
    expect(block).toContain("Per piece");
    expect(block).toMatch(/styles\.colPerUnit/);
  });

  it("PDF-R1: the row cell prints the shared formatter output", () => {
    expect(src).toMatch(/formatPerBaseUnitPrice\(/);
    expect(src).toMatch(/perBaseUnit/);
  });

  it("PDF-R1: the style defines colPerUnit", () => {
    expect(src).toMatch(/colPerUnit:\s*\{/);
  });
});
