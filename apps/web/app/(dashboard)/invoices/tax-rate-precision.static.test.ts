import * as fs from "fs";
import * as path from "path";

/**
 * R5-1 (SA-814 §3, B296): InvoiceItem.taxRate is Decimal(9,6) (a fraction, a percent to 4 dp), so the invoice edit
 * line input keeps 6 decimals and the settings default-rate input accepts 4 decimals of percent. Source pins:
 * both pages are thousands of lines and not mountable here; the rule itself is pinned in
 * packages/pricing/src/tax-precision.spec.ts.
 */
const edit = fs.readFileSync(path.join(__dirname, "[id]/edit/page.tsx"), "utf8");
const settings = fs.readFileSync(path.join(__dirname, "../settings/page.tsx"), "utf8");

describe("tax rate precision on the web inputs", () => {
  it("the invoice edit line Tax % input keeps 6 decimals of the fraction (not the old 4)", () => {
    const tax = edit.slice(edit.indexOf('<MobileField label="Tax %">'));
    const input = tax.slice(0, tax.indexOf("</MobileField>"));
    expect(input).toMatch(/decimals=\{TAX_RATE_FRACTION_DECIMALS\}/);
    expect(input).not.toMatch(/decimals=\{4\}/);
    expect(edit).toMatch(/TAX_RATE_FRACTION_DECIMALS,[\s\S]*?from "@routeflow\/pricing"/);
  });

  it("the settings default tax rate accepts 4 decimals of percent and refuses a 5th", () => {
    const field = settings.slice(settings.indexOf('label="Default Tax Rate"'));
    const input = field.slice(0, field.indexOf("error={errors.taxRate"));
    expect(input).toMatch(/step="0\.0001"/);
    expect(input).not.toMatch(/step="0\.01"/);
    expect(settings).toMatch(/taxPercentPrecisionError/);
    expect(settings).toMatch(/taxRate: z\.coerce[\s\S]{0,200}taxPercentPrecisionError/);
  });
});
