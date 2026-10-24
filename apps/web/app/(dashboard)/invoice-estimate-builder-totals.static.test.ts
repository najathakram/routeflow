/**
 * Source pins for the three builder footers. The new-sale builder and the estimate builder are
 * ~1k-2k lines of hooks, so the arithmetic is pinned on `computeInvoiceTotals`
 * (packages/pricing/src/invoice-totals.spec.ts) and the invoice edit footer is rendered in
 * invoices/[id]/edit/page.totals-rounding.test.tsx; this file pins that each footer goes through
 * the pricing helper instead of summing raw floats (`reduce((s, it) => s + lineTotal(it), 0)`).
 */
import { readFileSync } from "fs";
import { join } from "path";

const read = (rel: string): string => readFileSync(join(__dirname, rel), "utf8");

const PAGES: Array<[string, string]> = [
  ["invoices/new (new sale / invoice builder)", "invoices/new/page.tsx"],
  ["invoices/[id]/edit", "invoices/[id]/edit/page.tsx"],
  ["estimates (estimate builder)", "estimates/page.tsx"],
];

describe.each(PAGES)("%s footer totals", (_name, rel) => {
  const source = read(rel);

  it("computes the footer with computeInvoiceTotals", () => {
    expect(source.includes("computeInvoiceTotals(")).toBe(true);
  });

  it("never sums line totals as raw floats", () => {
    expect(
      /reduce\(\s*\(\s*s(um)?\s*,\s*(it|li)\s*\)\s*=>\s*s(um)?\s*\+\s*lineTotal/.test(source),
    ).toBe(false);
    expect(/lineTotal\(it\)\s*\*\s*(taxRate|Number\(it\.taxRate\))/.test(source)).toBe(false);
  });
});
