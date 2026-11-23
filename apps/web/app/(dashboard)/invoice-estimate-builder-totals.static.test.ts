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

// The two invoice footers go through `invoiceFooterTotals` (lib/discount-tax-base.ts, which hands the
// document's discount base to `computeInvoiceTotals`); the estimate builder calls `computeInvoiceTotals` itself.
const PAGES: Array<[string, string, string]> = [
  ["invoices/new (new sale / invoice builder)", "invoices/new/page.tsx", "invoiceFooterTotals("],
  ["invoices/[id]/edit", "invoices/[id]/edit/page.tsx", "invoiceFooterTotals("],
  ["estimates (estimate builder)", "estimates/EstimateFormModal.tsx", "computeInvoiceTotals("],
];

describe("the invoice footer helper stays on the pricing helper", () => {
  it("lib/discount-tax-base.ts computes invoiceFooterTotals with computeInvoiceTotals", () => {
    expect(read("../../lib/discount-tax-base.ts").includes("computeInvoiceTotals(")).toBe(true);
  });
});

describe.each(PAGES)("%s footer totals", (_name, rel, helper) => {
  const source = read(rel);

  it(`computes the footer with ${helper.slice(0, -1)}`, () => {
    expect(source.includes(helper)).toBe(true);
  });

  it("never sums line totals as raw floats", () => {
    expect(
      /reduce\(\s*\(\s*s(um)?\s*,\s*(it|li)\s*\)\s*=>\s*s(um)?\s*\+\s*lineTotal/.test(source),
    ).toBe(false);
    expect(/lineTotal\(it\)\s*\*\s*(taxRate|Number\(it\.taxRate\))/.test(source)).toBe(false);
  });
});
