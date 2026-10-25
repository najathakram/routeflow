/**
 * Row 139 (D-27 / B682): a structural census of BARE line-price math in apps/api/src, count-pinned per file
 * (OP-7, shrink-only, in the style of no-bare-cron.spec.ts).
 *
 * A line's amount is `buildLine` / `computeLineSubtotal` (@routeflow/pricing): boxed lines prorate, and a bare
 * `qty * price` over-charges them by unitsPerBox. This counts, per non-spec source file, the expressions that multiply a
 * quantity (qty / quantity / pieces / boxes) by a price (any identifier ending in Price/price, incl. pricePerUnit and priceTierN), either way round and
 * through a `Number(...)` wrapper, outside comments. A NEW bare multiply, or one more in an existing file, fails here:
 * route it through the shared calculator, or pin it below with the reason it is not a boxed-line amount.
 *
 * It is NOT the bug-hunt scan (`// scan-ok: money-rederive` + scan-ignore.json): that scan is a skill a human runs;
 * this one runs in every build. Quantity x COST (purchasing, valuation) is out of scope on purpose.
 */
import * as fs from "fs";
import * as path from "path";

const SRC_ROOT = path.resolve(__dirname, "..");

/** file (relative to apps/api/src) -> [hits, why none of them is a boxed line's amount] */
const PINNED: Record<string, [number, string]> = {
  "orders/orders.service.ts": [
    2,
    "merge appends of CUSTOM lines (productId: null): never boxed, per-piece price x qty, roundMoney on write (scan-ok: money-rederive)",
  ],
  "import/import.service.ts": [
    1,
    "imported CSV line fallback: no case pack, the file's Item Total wins, plain qty x price only when absent (scan-ok: money-rederive)",
  ],
  "sales-agents/commission-engine.service.ts": [
    1,
    "commission BASE estimate over order items (a reporting figure, never written to a line or an invoice)",
  ],
  "billing/catchup-plan.ts": [
    1,
    "subscription add-on catch-up: unit price x seat quantity of an add-on SKU (not a product line), cents-rounded",
  ],
  "billing/subscription.service.ts": [
    1,
    "subscription add-on monthly = SKU monthlyPrice x seat quantity (not a product line)",
  ],
};

// quantity x price, or price x quantity, optionally through Number(...) on either side.
const QTY = String.raw`(?:qty|quantity|pieces|boxes)`;
const PRICE = String.raw`[\w.]*[Pp]rice(?:PerUnit|Tier\d)?`;
const BARE = new RegExp(
  String.raw`(?<![\w.])(?:\w+\.)?${QTY}\)?\s*\*\s*\(?(?:Number\()?${PRICE}\b|${PRICE}\)?\s*\*\s*\(?(?:Number\()?[\w.]*${QTY}\b`,
  "g",
);

/** Code only: whole-line and trailing `//` comments and `/* ... *​/` blocks are dropped before matching. */
function codeOf(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .split("\n")
    .map((l) => (/^\s*\/\//.test(l) ? "" : l.replace(/\s\/\/.*$/, "")))
    .join("\n");
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "testing" || e.name === "node_modules") continue;
      sourceFiles(full, out);
    } else if (e.name.endsWith(".ts") && !e.name.endsWith(".spec.ts")) out.push(full);
  }
  return out;
}

function census(): Record<string, number> {
  const found: Record<string, number> = {};
  for (const file of sourceFiles(SRC_ROOT)) {
    const n = (codeOf(fs.readFileSync(file, "utf8")).match(BARE) ?? []).length;
    if (n > 0) found[path.relative(SRC_ROOT, file).split(path.sep).join("/")] = n;
  }
  return found;
}

describe("row 139: bare qty x price line math is count-pinned per file (shrink-only)", () => {
  it("every file with a bare multiply is pinned, with exactly its count, and every pin carries a reason", () => {
    const expected = Object.fromEntries(Object.entries(PINNED).map(([f, [n]]) => [f, n]));
    expect(census()).toEqual(expected);
    for (const [, why] of Object.values(PINNED)) expect(why.length).toBeGreaterThan(30);
  });

  it("the detector matches each shape it claims to", () => {
    for (const code of [
      "const s = qty * unitPrice;",
      "const s = li.qty * li.unitPrice;",
      "const s = unitPrice * qty;",
      "const s = Number(i.qty) * Number(i.unitPrice);",
      "roundMoney(data.quantity * data.price)",
      "a.pieces * a.pricePerUnit",
    ]) {
      expect(codeOf(code).match(BARE)).not.toBeNull();
    }
  });

  it("and ignores comments, cost math, and the shared calculator", () => {
    for (const code of [
      "// qty * unitPrice would over-charge a boxed line",
      "/* qty * unitPrice */",
      "const v = qty * unitCost;",
      "const v = quantity * costPerUnit;",
      "const s = computeLineSubtotal({ unitPrice, qty, boxes, pieces, unitsPerBox });",
      "const n = qty * 2; // times price",
    ]) {
      expect(codeOf(code).match(BARE)).toBeNull();
    }
  });
});
