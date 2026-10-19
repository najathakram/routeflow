/**
 * SA-816 (d)2 / register row 593: three `@routeflow/pricing` helpers still read a non-finite levy as 0 on
 * purpose, because every caller of them is a DISPLAY (or a pure derived value): the non-strict
 * `sumInvoiceTotals` (`finite()`, invoice-totals.ts), `chargeLinesOf` / `billedChargeLines` /
 * `invoiceTaxSplit` (charge-lines.ts) and `inferredFlatRate` (inferred-flat-rate.ts). Refusing inside the
 * shared package would turn an invoice's PDF, receipt and open page into a 500 (SA-816 (a) rules those
 * "Safe") and would crash the mobile / web previews. The WRITE paths are the fix, and this spec pins the
 * two facts that make leaving the helpers lenient safe, so a new caller cannot slip past:
 *
 *  1. in apps/api production source, `sumInvoiceTotals(` is called only inside the two strict wrappers
 *     (`strict: true`), and the display helpers are called only by the display files listed below;
 *  2. `inferredGoodsFlatRate` (-> `inferredFlatRate`) is reached on the API only after
 *     `sumInvoiceTotalsStrict` has already refused a non-finite stored levy.
 *
 * An allowlist row that no longer matches anything fails too (L-202): the list shrinks as callers go.
 */
import * as fs from "fs";
import * as path from "path";
import { BadRequestException } from "@nestjs/common";
import { API_ERROR_CODES } from "./api-error-codes";
import { taxStateOf } from "../invoices/stored-tax-state";

const SRC = path.resolve(__dirname, "..");
const SOURCE = /\.[cm]?[tj]sx?$/;
const NOT_PRODUCTION = /\.(spec|test)\.[cm]?[tj]sx?$|\.d\.ts$|[\\/]testing[\\/]/;

function productionFiles(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) productionFiles(p, acc);
    else if (SOURCE.test(e.name) && !NOT_PRODUCTION.test(p)) acc.push(p);
  }
  return acc;
}

/** The source with line and block comments blanked, so prose that names a function is not a call. */
const code = (file: string): string =>
  fs
    .readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

const rel = (file: string) => path.relative(SRC, file).split(path.sep).join("/");

const FILES = productionFiles(SRC).map((f) => ({ rel: rel(f), text: code(f) }));

describe("SA-816 (d)2: the lenient pricing helpers stay display-only on the API", () => {
  it("sumInvoiceTotals( is called only inside the two strict wrappers, each with `strict: true`", () => {
    const callers = FILES.filter((f) => /\bsumInvoiceTotals\s*\(/.test(f.text));
    expect(callers.map((f) => f.rel).sort()).toEqual([
      "common/money-invariants.util.ts",
      "orders/order-totals.ts",
    ]);
    for (const f of callers) {
      const call = f.text.slice(f.text.search(/\bsumInvoiceTotals\s*\(/));
      expect(call.slice(0, 400)).toMatch(/strict:\s*true/);
    }
  });

  const DISPLAY_ONLY = [
    "common/staff-only-fields.ts",
    "documents/receipt-model.ts",
    "invoices/invoice-pdf-template.tsx",
    "orders/counter-sale/counter-sale-readback.ts",
    "orders/counter-sale/counter-sale-today.ts",
  ];

  it("chargeLinesOf / billedChargeLines / invoiceTaxSplit are called only by display files", () => {
    const callers = FILES.filter((f) =>
      /\b(chargeLinesOf|billedChargeLines|invoiceTaxSplit)\s*\(/.test(f.text),
    ).map((f) => f.rel);
    expect(callers.sort()).toEqual([...DISPLAY_ONLY].sort());
  });

  it("inferredGoodsFlatRate is called on the API only from stored-tax-state.ts, behind sumInvoiceTotalsStrict", () => {
    const callers = FILES.filter((f) => /\binferredGoodsFlatRate\s*\(/.test(f.text));
    expect(callers.map((f) => f.rel)).toEqual(["invoices/stored-tax-state.ts"]);
    const text = callers[0].text;
    expect(text.search(/\bsumInvoiceTotalsStrict\s*\(/)).toBeGreaterThan(-1);
    expect(text.search(/\bsumInvoiceTotalsStrict\s*\(/)).toBeLessThan(
      text.search(/\binferredGoodsFlatRate\s*\(/),
    );
  });

  it("taxStateOf refuses a stored non-finite levy with MONEY_INVARIANT before any rate is inferred", () => {
    let err: unknown;
    try {
      taxStateOf({
        invoice: { subtotal: 100, taxAmount: 7.5 },
        storedLines: [{ subtotal: 100, taxRate: 0, categoryTaxAmount: "NaN" }],
        canRestamp: true,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).getResponse()).toMatchObject({
      code: API_ERROR_CODES.MONEY_INVARIANT,
    });
  });
});
