import * as fs from "fs";
import * as path from "path";

/**
 * SA-795 (g), fold G1 — the invoice unit is DISPLAY ONLY. `InvoiceItem/CreditNoteItem.invoiceUnitLabel` and
 * `.invoiceUnitFactor` (units S6) are a snapshot of how a line is SHOWN; line totals, tax, payments, credit
 * notes and the regulated ledger use the stored line amount in the unit SOLD. This source scan fails if any
 * money writer names either column. The issue-time snapshot WRITER (invoices.service.ts, S23) is not a money
 * writer and is deliberately outside the scan. Comments are stripped first, so a doc mention is not a read.
 */
const API_SRC = path.resolve(__dirname, "..");
const PRICING_SRC = path.resolve(__dirname, "..", "..", "..", "..", "packages", "pricing", "src");

const COLUMN_RE = /\binvoiceUnit(?:Factor|Label)\b/;

/** Whole money directories (every non-spec source file). */
const MONEY_DIRS = ["credit-notes", "regulated", "bookkeeping", "payment-requests"];
/** Money files inside invoices/: payments, tax, balances, ledgers, refunds, deposits. */
const INVOICE_MONEY_FILE_RE =
  /(payment|tax|total|ledger|balance|credit|refund|price-adjustment|nsf|deposit|cash)[\w-]*\.ts$/;
/** @routeflow/pricing money math (line, tax and document totals). */
const PRICING_MONEY_FILES = [
  "pricing.ts",
  "build-line.ts",
  "invoice-totals.ts",
  "sale-totals.ts",
  "charge-lines.ts",
  "recompute-category-tax.ts",
  "money-invariants.ts",
  "largest-remainder.ts",
  "cents.ts",
  "tier-pricing.ts",
  "regulated-unit-basis.ts",
  "explained-tax-rate.ts",
];

const isSource = (f: string) => /\.tsx?$/.test(f) && !/\.(spec|test)\.tsx?$/.test(f);

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return isSource(e.name) ? [p] : [];
  });
}

function moneyWriterFiles(): string[] {
  const invoices = fs
    .readdirSync(path.join(API_SRC, "invoices"))
    .filter((f) => isSource(f) && INVOICE_MONEY_FILE_RE.test(f))
    .map((f) => path.join(API_SRC, "invoices", f));
  return [
    ...MONEY_DIRS.flatMap((d) => walk(path.join(API_SRC, d))),
    ...invoices,
    ...PRICING_MONEY_FILES.map((f) => path.join(PRICING_SRC, f)),
  ];
}

/** Code with comments blanked (strings kept: a `"invoiceUnitFactor"` key in a select IS a read). */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

function invoiceUnitReaders(files: ReadonlyArray<{ file: string; text: string }>): string[] {
  return files.filter(({ text }) => COLUMN_RE.test(stripComments(text))).map(({ file }) => file);
}

describe("SA-795 G1: the invoice unit snapshot never feeds money", () => {
  const files = moneyWriterFiles();

  it("scans real money writers (not vacuous)", () => {
    expect(files.length).toBeGreaterThan(30);
    for (const f of files) expect(fs.existsSync(f)).toBe(true);
    const names = files.map((f) => path.relative(path.resolve(API_SRC, "..", "..", ".."), f));
    expect(names).toEqual(
      expect.arrayContaining([
        "apps/api/src/credit-notes/credit-notes.service.ts",
        "apps/api/src/credit-notes/line-credit-headroom.ts",
        "apps/api/src/regulated/regulated-ledger.service.ts",
        "apps/api/src/invoices/payment-void-tx.ts",
        "apps/api/src/invoices/nsf-line-tax-guard.ts",
        "packages/pricing/src/invoice-totals.ts",
      ]),
    );
  });

  it("no money writer names invoiceUnitFactor or invoiceUnitLabel", () => {
    const texts = files.map((file) => ({ file, text: fs.readFileSync(file, "utf8") }));
    expect(invoiceUnitReaders(texts)).toEqual([]);
  });

  it("planted reads are caught; a comment mention is not", () => {
    expect(
      invoiceUnitReaders([{ file: "a", text: "const q = line.qty / line.invoiceUnitFactor;" }]),
    ).toEqual(["a"]);
    expect(
      invoiceUnitReaders([{ file: "b", text: 'select: { "invoiceUnitLabel": true }' }]),
    ).toEqual(["b"]);
    expect(
      invoiceUnitReaders([{ file: "c", text: "const { invoiceUnitFactor: f } = row;" }]),
    ).toEqual(["c"]);
    expect(
      invoiceUnitReaders([
        {
          file: "d",
          text: "// invoiceUnitFactor is display only\n/* invoiceUnitLabel too */ const x = 1;",
        },
      ]),
    ).toEqual([]);
  });
});
