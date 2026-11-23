import * as fs from "fs";
import * as path from "path";

/**
 * SA-1141 / W-989 (G4): the inventory pin for the invoice-level discount tax base.
 *
 *   1. Every production call of the totals / rate-inference helpers NAMES its mode (`discountBase`, or forwards the caller's
 *      `opts`): the compiler enforces the required option, this pin also covers the .mjs scripts and keeps the list honest.
 *   2. A STRING-LITERAL mode (`LEGACY_DISCOUNT_BASE`, "LEGACY_POST_TAX", "PRE_TAX") appears only in the listed files, with the
 *      listed counts: the LEGACY-by-definition sites. A new literal anywhere else fails here, so a document never gets a mode
 *      from a constant by accident.
 *   3. The sites PR-1's pin did not reach (rate inference, the order-derived rate, the partial price follow, the B1043 report)
 *      read the mode from the caller: required parameter, no local formula.
 *
 * (Pin 1b, a one-file count of the four `applyOrderDerivedTaxRate` calls, is gone: SA-1153 replaced it with the ordered per-file
 * table of every mode call, `invoices/discount-tax-base.mode-sites.pin.spec.ts`. Two pins on one rule are not kept.)
 *
 * Out of scope by the owner's 2026-10-24 ruling (no old-native fixes): apps/mobile/lib/invoice-totals.ts (the native mirror,
 * "the invoice-level discount comes off AFTER tax") and the mobile invoice-edit tax fill, which keep LEGACY.
 */
const ROOT = path.resolve(__dirname, "../../../..");
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const { GENERATED_DIRS } = require("../../../../scripts/lib/generated-dirs.cjs") as {
  GENERATED_DIRS: readonly string[];
};
const SKIP_DIRS = new Set([...GENERATED_DIRS, "testing"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (
      /\.(ts|tsx|mjs|cjs)$/.test(e.name) &&
      !/\.(spec|test|d)\.(ts|tsx|mjs|cjs)$/.test(e.name)
    )
      out.push(p);
  }
  return out;
}

const SCAN_ROOTS = [
  "apps/api/src",
  "apps/api/scripts",
  "apps/web/app",
  "apps/web/lib",
  "apps/mobile/lib",
];
const FILES = SCAN_ROOTS.flatMap((r) => walk(path.join(ROOT, r)));
const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join("/");
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const CALLS = [
  "sumInvoiceTotals",
  "sumInvoiceTotalsStrict",
  "computeInvoiceTotals",
  "saleTotals",
  "orderTotalsOf",
  "orderTotalsOfSums",
  "effectiveTaxRateFromTotals",
  "inferredGoodsFlatRate",
  "inferredFlatRate",
  "inferredGoodsRateForCopy",
  "totalsFromLines",
  "orderDerivedTaxRate",
  "applyOrderDerivedTaxRate",
  "invoiceFooterTotals",
];
// the old native mirror: out of scope (named in the PR body), and a handful of wrappers that forward their caller's options
const OUT_OF_SCOPE = new Set([
  "apps/mobile/lib/invoice-totals.ts",
  "apps/mobile/lib/sale-mode.ts", // calls the native mirror above, not @routeflow/pricing
  "apps/api/scripts/report-b1043-stale-tax-state.mjs", // its own wrapper over pricing, LEGACY by default (rule 3 pins it)
]);

/** The text of each `name(...)` call (balanced parens), definitions and member calls on other receivers skipped. */
function callsIn(src: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`(?<![\\w.])${name}\\(`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (/function\s+$/.test(src.slice(Math.max(0, m.index - 12), m.index))) continue; // a definition
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") depth--;
    }
    out.push(src.slice(m.index, i));
  }
  return out;
}

describe("SA-1141 discount tax base pin", () => {
  it("scans a real inventory (guards a silently-vacuous pin)", () => {
    expect(FILES.length).toBeGreaterThan(500);
  });

  it("1: every production call names its mode", () => {
    const bad: string[] = [];
    for (const f of FILES) {
      if (OUT_OF_SCOPE.has(rel(f))) continue;
      const src = stripComments(fs.readFileSync(f, "utf8"));
      for (const name of CALLS) {
        for (const call of callsIn(src, name)) {
          if (
            !/discountBase|discountModeOf|\.\.\.opts|\bopts\b|\bbase\b|newDocumentDiscount/.test(
              call,
            )
          )
            bad.push(`${rel(f)}: ${call.replace(/\s+/g, " ").slice(0, 90)}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("2: a string-literal mode appears only in the listed LEGACY-by-definition files, at the listed counts", () => {
    const found: Record<string, number> = {};
    for (const f of FILES) {
      if (rel(f).startsWith("apps/web/lib/discount-tax-base.test")) continue;
      const src = stripComments(fs.readFileSync(f, "utf8"));
      const n = (src.match(/LEGACY_DISCOUNT_BASE|"LEGACY_POST_TAX"|(?<!===\s)"PRE_TAX"/g) ?? [])
        .length;
      if (n > 0) found[rel(f)] = n;
    }
    expect(found).toEqual({
      // the levy-only sum: a discount never reduces a levy, so the base is irrelevant (R1)
      "apps/api/src/invoices/manual-invoice-context.ts": 2,
      // the cutover seam itself: dark (null) is LEGACY without reading a date
      "apps/api/src/common/discount-tax-mode.ts": 1,
      // the report scripts: legacy-by-definition backfills / censuses, and the reports' dark default
      "apps/api/scripts/backfill-b294-order-line-taxrate.mjs": 2,
      "apps/api/scripts/report-order-taxrate-census.mjs": 2,
      "apps/api/scripts/report-b1043-stale-tax-state.mjs": 2,
      "apps/api/scripts/report-standard-refund-tax-shortfall.mjs": 1,
      // the web footers: an older server's response without the wire field reads as LEGACY
      "apps/web/lib/discount-tax-base.ts": 3,
      // the frozen native screens (out of scope, 2026-10-24 ruling)
      "apps/mobile/lib/invoice-edit-tax.ts": 2,
    });
  });

  it("3: rate inference, the order-derived rate, the partial price follow and the B1043 report take the mode from the caller", () => {
    const read = (p: string) => stripComments(fs.readFileSync(path.join(ROOT, p), "utf8"));
    expect(read("apps/api/src/common/tax-rate.ts")).toMatch(
      /effectiveTaxRateFromTotals\([^)]*base:\s*\{\s*discount:\s*unknown;\s*discountBase:\s*DiscountTaxBase/s,
    );
    const mic = read("apps/api/src/invoices/manual-invoice-context.ts");
    expect(mic).toMatch(/function orderDerivedTaxRate\([^)]*discountBase:\s*DiscountTaxBase/s);
    expect(mic).toMatch(/function applyOrderDerivedTaxRate\([^)]*discountBase:\s*DiscountTaxBase/s);
    expect(read("apps/api/src/invoices/partial-price-follow.ts")).toMatch(
      /taxRateOf\([^)]*discountBase:\s*DiscountTaxBase/s,
    );
    const report = read("apps/api/scripts/report-b1043-stale-tax-state.mjs");
    expect(report).toMatch(/pricing\.sumInvoiceTotals\(/);
    expect(report).not.toMatch(/taxable\s*\+=/); // the local copy of the formula is gone
  });
});
