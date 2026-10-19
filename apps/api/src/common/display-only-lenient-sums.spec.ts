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

  /** The only API callers of the charge-line helpers, each with why its result never reaches a write. */
  const DISPLAY_ONLY: Record<string, string> = {
    "common/staff-only-fields.ts":
      "shapes the invoice API RESPONSE (a regularTax / charge split); no write in the file",
    "documents/receipt-model.ts": "builds the receipt RENDER model; no write in the file",
    "invoices/invoice-pdf-template.tsx": "the invoice PDF render; no Prisma write in the file",
    "orders/counter-sale/counter-sale-readback.ts":
      "the counter-sale read-back RESPONSE; no write in the file",
    "orders/counter-sale/counter-sale-today.ts":
      "the counter-sale today RESPONSE; no write in the file",
  };

  it("chargeLinesOf / billedChargeLines / invoiceTaxSplit are called only by display files", () => {
    const callers = FILES.filter((f) =>
      /\b(chargeLinesOf|billedChargeLines|invoiceTaxSplit)\s*\(/.test(f.text),
    ).map((f) => f.rel);
    expect(callers.sort()).toEqual(Object.keys(DISPLAY_ONLY).sort());
  });

  it("the other lenient pricing entry points (saleTotals, computeInvoiceTotals, computeInvoiceLineTotal) have no API caller", () => {
    const callers = FILES.filter((f) =>
      /\b(saleTotals|computeInvoiceTotals|computeInvoiceLineTotal)\s*\(/.test(f.text),
    ).map((f) => f.rel);
    expect(callers).toEqual([]);
  });

  /**
   * SA-816b: no write path consumes a lenient output. A file that calls a lenient helper may hold no Prisma write
   * (`data:` payload or create / update / upsert call). The two shapes the scan must tolerate are named here:
   * react-pdf's StyleSheet.create (a stylesheet, not a row) and a type annotation.
   */
  const WRITE = /\bdata\s*:|\.(create|createMany|update|updateMany|upsert)\s*\(|\$executeRaw/;
  const NOT_A_WRITE = [/StyleSheet\.create\(/g, /\bdata: Record<string, any>/g];
  /** Lenient callers that are NOT pure display, each with the reason its output cannot reach a bad write. */
  const LENIENT_BUT_GUARDED: Record<string, string> = {
    "invoices/stored-tax-state.ts":
      "inferredGoodsFlatRate: its RATE is later stamped on rate-0 lines, but only after sumInvoiceTotalsStrict refused any non-finite stored levy on the same lines (asserted below); the rate is not a levy",
  };

  it("no file that calls a lenient helper holds a Prisma write, and every such file is listed with a reason", () => {
    const lenient = FILES.filter((f) =>
      /\b(chargeLinesOf|billedChargeLines|invoiceTaxSplit|inferredGoodsFlatRate)\s*\(/.test(f.text),
    );
    const listed = { ...DISPLAY_ONLY, ...LENIENT_BUT_GUARDED };
    expect(lenient.map((f) => f.rel).sort()).toEqual(Object.keys(listed).sort());
    for (const f of lenient) {
      const stripped = NOT_A_WRITE.reduce((t, re) => t.replace(re, " "), f.text);
      expect({ file: f.rel, write: WRITE.exec(stripped)?.[0] ?? null }).toEqual({
        file: f.rel,
        write: null,
      });
      expect(listed[f.rel].length).toBeGreaterThan(20);
    }
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
