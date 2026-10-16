import * as fs from "fs";
import * as path from "path";

/**
 * SA-795 fold G1 (T17c): the invoice unit is DISPLAY ONLY. `invoiceLineDisplay` (packages/pricing/src/invoice-display.ts)
 * turns a stored line into "72 Pieces at $0.7875"; that 4-decimal price must never feed money. Line totals, tax, payments and
 * the ledger use the stored line amount, and a credit note computes in the unit sold through `creditedThrough`.
 *
 * Source pin: none of the money writers below, and no money module of the pricing package, may name the display math or
 * the invoice-unit snapshot fields. Comments are ignored.
 */

const REPO = path.resolve(__dirname, "../../../..");
const FORBIDDEN =
  /\b(?:invoiceUnitFactor|invoiceUnitLabel|invoiceLineDisplay|InvoiceLineDisplay)\b/;

/** Directories whose non-spec source writes or computes money. */
const MONEY_DIRS = [
  "apps/api/src/invoices",
  "apps/api/src/orders",
  "apps/api/src/estimates",
  "apps/api/src/recurring-invoices",
  "apps/api/src/credit-notes",
  "apps/api/src/bookkeeping",
  "apps/api/src/payment-requests",
  "apps/api/src/stripe-connect",
  "apps/api/src/returns",
  "apps/api/src/vendor-bills",
  "apps/api/src/regulated",
  "packages/pricing/src",
];
/** Single money files outside those directories. */
const MONEY_FILES = ["apps/api/src/common/invoiced-sales.ts"];
/** The pricing files that legitimately hold the display math. */
const DISPLAY_FILES = new Set([
  "packages/pricing/src/invoice-display.ts",
  "packages/pricing/src/index.ts",
]);
/** The API files that render an invoice (display only): the PDF modules and the detail read. */
const DISPLAY_PATTERNS = [
  /^apps\/api\/src\/invoices\/invoice-pdf[^/]*$/,
  /^apps\/api\/src\/invoices\/invoice-detail-read\.ts$/,
];
const isDisplay = (f: string): boolean =>
  DISPLAY_FILES.has(f) || DISPLAY_PATTERNS.some((re) => re.test(f));

const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

function walk(dir: string, out: string[]): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules" && e.name !== "dist") walk(p, out);
    } else if (/\.(ts|tsx)$/.test(e.name) && !/\.(spec|test)\./.test(e.name)) out.push(p);
  }
}

describe("G1: the invoice unit never reaches a money writer", () => {
  const files: string[] = [];
  for (const d of MONEY_DIRS) walk(path.join(REPO, d), files);
  for (const f of MONEY_FILES) files.push(path.join(REPO, f));
  const rel = files.map((f) => path.relative(REPO, f).split(path.sep).join("/"));

  it("scans a real set of money files", () => {
    expect(rel.length).toBeGreaterThan(40);
    expect(rel).toEqual(
      expect.arrayContaining([
        "apps/api/src/credit-notes/credit-notes.service.ts",
        "apps/api/src/invoices/nsf-line-tax-guard.ts",
        "apps/api/src/invoices/price-adjustment-ledger.ts",
        "apps/api/src/invoices/partial-price-follow.ts",
        "apps/api/src/invoices/counter-payment-guard.ts",
        "apps/api/src/orders/orders.service.ts",
        "apps/api/src/estimates/estimates.service.ts",
        "apps/api/src/recurring-invoices/recurring-invoices.service.ts",
        "apps/api/src/common/invoiced-sales.ts",
      ]),
    );
  });

  it("the detector is not vacuous: it matches a field read and ignores a comment", () => {
    expect(FORBIDDEN.test("const f = x.invoiceUnitFactor;")).toBe(true);
    expect(FORBIDDEN.test(stripComments("// invoiceUnitFactor"))).toBe(false);
    expect(FORBIDDEN.test(stripComments("/* invoiceLineDisplay */"))).toBe(false);
  });

  it("the display allow-list covers the PDF modules and the detail read, and nothing else", () => {
    expect(isDisplay("apps/api/src/invoices/invoice-pdf.service.ts")).toBe(true);
    expect(isDisplay("apps/api/src/invoices/invoice-detail-read.ts")).toBe(true);
    expect(isDisplay("apps/api/src/invoices/invoices.service.ts")).toBe(false);
    expect(isDisplay("apps/api/src/invoices/price-adjustment-ledger.ts")).toBe(false);
  });

  it("no money module names the display math or the snapshot fields", () => {
    const offenders = rel
      .filter((f) => !isDisplay(f))
      .filter((f) => FORBIDDEN.test(stripComments(fs.readFileSync(path.join(REPO, f), "utf8"))));
    expect(offenders).toEqual([]);
  });
});
