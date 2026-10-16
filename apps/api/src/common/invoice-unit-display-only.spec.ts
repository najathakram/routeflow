import * as fs from "fs";
import * as path from "path";
import { legacyInvoiceCode } from "@routeflow/pricing";
import { invoiceItemCode } from "../invoices/invoice-item-code";

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
  "apps/api/src/credit-notes",
  "apps/api/src/bookkeeping",
  "apps/api/src/payment-requests",
  "apps/api/src/stripe-connect",
  "apps/api/src/returns",
  "apps/api/src/vendor-bills",
  "apps/api/src/regulated",
  "packages/pricing/src",
];
/** The pricing files that legitimately hold the display math. */
const DISPLAY_FILES = new Set([
  "packages/pricing/src/invoice-display.ts",
  "packages/pricing/src/index.ts",
]);

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
  const rel = files.map((f) => path.relative(REPO, f).split(path.sep).join("/"));

  it("scans a real set of money files", () => {
    expect(rel.length).toBeGreaterThan(40);
    expect(rel).toEqual(
      expect.arrayContaining(["apps/api/src/credit-notes/credit-notes.service.ts"]),
    );
  });

  it("no money module names the display math or the snapshot fields", () => {
    const offenders = rel
      .filter((f) => !DISPLAY_FILES.has(f))
      .filter((f) => FORBIDDEN.test(stripComments(fs.readFileSync(path.join(REPO, f), "utf8"))));
    expect(offenders).toEqual([]);
  });
});

describe("T16: the legacy invoice code is today's invoiceItemCode, for all 8 null combinations", () => {
  it("is byte-identical", () => {
    for (let mask = 0; mask < 8; mask++) {
      const p = {
        unitSku: mask & 1 ? "U-1" : null,
        barcode: mask & 2 ? "B-1" : null,
        sku: mask & 4 ? "S-1" : null,
      };
      expect(legacyInvoiceCode(p)).toBe(invoiceItemCode(p));
    }
    expect(legacyInvoiceCode(null)).toBe(invoiceItemCode(null));
    expect(legacyInvoiceCode(undefined)).toBe(invoiceItemCode(undefined));
  });
});
