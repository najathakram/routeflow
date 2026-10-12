/**
 * G4 tripwire (CQ-01/02/03 class): an order's tax, levy and total are summed in ONE place, `orderTotalsOf` ->
 * `sumInvoiceTotals` (@routeflow/pricing), the same formula the invoice writers and the till footer (`saleTotals`)
 * run. A second `roundMoney(subtotal * rate)` or a hand-added `subtotal + tax + categoryTax` is how an order, its
 * invoice and the screen drifted apart (the exempt customer's tax, the levy missing on the till). Returns price a
 * single credit chunk and are allow-listed.
 */
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative, sep } from "path";

const SRC = join(__dirname, "..");
const ALLOWED = new Set(["returns/inline-returns-pricing.ts"]);
const SECOND_FORMULA = [
  /roundMoney\(\s*subtotal\s*\*/,
  // any identifier times the tenant rate, however it is named (sub, itemsSubtotal, ...)
  /roundMoney\(\s*[\w.]+\s*\*\s*(?:\(await this\.getTaxRate\(\)\)|taxRate\b|effectiveTaxRate\b)/,
  /subtotal\s*\+\s*tax\s*\+\s*categoryTax/,
  /subtotal\s*\+\s*tax\s*\+\s*Number\(/,
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "node_modules" || name === "testing") continue;
      walk(p, out);
    } else if (p.endsWith(".ts") && !/\.(spec|db\.spec|test)\.ts$/.test(p)) out.push(p);
  }
  return out;
}

describe("one order-totals formula (G4)", () => {
  it("no api source sums an order's tax / total a second way", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = relative(SRC, file).split(sep).join("/");
      if (ALLOWED.has(rel)) continue;
      const text = readFileSync(file, "utf8");
      for (const re of SECOND_FORMULA) if (re.test(text)) offenders.push(`${rel}: ${re}`);
    }
    expect(offenders).toEqual([]);
  });

  it("the order writers all call orderTotalsOf", () => {
    const need = ["orders/orders.service.ts", "order-templates/order-templates.service.ts"];
    for (const rel of need) {
      expect(readFileSync(join(SRC, rel), "utf8")).toContain("orderTotalsOf(");
    }
  });
});
