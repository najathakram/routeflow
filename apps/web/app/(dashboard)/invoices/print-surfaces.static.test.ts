/**
 * WP4 / T11 (R6.6, R6.7, R6.10) — source-text pins across the three web print
 * surfaces + the print CSS. Rulings HL-6/HL-8/HL-9/HL-10 give the exact
 * attribute strings, state-variable name, and CSS block asserted here.
 *
 * None of these strings exist in the three surface files or globals.css
 * today — every positive assertion below fails RED until WP4 lands.
 */
import { readFileSync } from "fs";
import { join } from "path";

function read(relFromWebRoot: string): string {
  return readFileSync(join(__dirname, "..", "..", "..", relFromWebRoot), "utf8");
}

function countOccurrences(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

describe("print surfaces — source pins (T11)", () => {
  it("invoices/page.tsx: row Print button aria-label + printingId gating, exactly once each", () => {
    const source = read("app/(dashboard)/invoices/page.tsx");
    expect(countOccurrences(source, "aria-label={`Print invoice ${inv.invoiceNumber}`}")).toBe(1);
    expect(source).toContain("disabled={printingId === inv.id}");
  });

  it("orders/[id]/page.tsx: printLoading state used at least 3x, printPdfBlob( called exactly once", () => {
    const source = read("app/(dashboard)/orders/[id]/page.tsx");
    expect(countOccurrences(source, "printLoading")).toBeGreaterThanOrEqual(3);
    expect(countOccurrences(source, "printPdfBlob(")).toBe(1);
  });

  it("invoices/[id]/page.tsx: calls the shared printPdfBlob(blob) exactly once, no inline iframe creation left behind", () => {
    const source = read("app/(dashboard)/invoices/[id]/page.tsx");
    expect(countOccurrences(source, "printPdfBlob(blob)")).toBe(1);
    expect(countOccurrences(source, 'createElement("iframe")')).toBe(0);
  });

  it("globals.css: @media print hides .surface-operator aside and header", () => {
    const source = read("app/globals.css");
    expect(source).toContain("@media print");
    expect(source).toContain(".surface-operator aside");
    expect(source).toContain(".surface-operator header");
  });
});
