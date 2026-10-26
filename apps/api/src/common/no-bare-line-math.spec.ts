/**
 * Row 139 (D-27 / B682, SA-982 section 4): two structural census pins over apps/api/src, count-pinned per file
 * (OP-7, shrink-only, in the style of no-bare-cron.spec.ts). PIN A: bare line-price math. PIN B: hand-built pack-axis
 * builders (`normalizeBoxesPieces(` called with a `boxes:` argument).
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
  "vendor-bills/bill-lines-total.ts": [
    1,
    "an AP vendor-bill line: qty x unitCost (falling back to unitPrice), summed and rounded for the BILL total; not a sale line",
  ],
};

// quantity x price, or price x quantity, optionally through Number(...) on either side.
// A quantity operand: qty / quantity / pieces / boxes, optionally through Number(...) and a `|| 1` default.
const QTY = String.raw`(?:\(?(?:Number\()?[\w.]*(?:qty|quantity|pieces|boxes)\)?(?:\s*\|\|\s*\d+)?\)?)`;
// A price operand, optionally through Number(...) and a `a ?? b ??` fallback chain that ends in a price field.
const PRICE = String.raw`\(?(?:Number\()?(?:[\w.]+\s*\?\?\s*)*[\w.]*[Pp]rice(?:PerUnit|Tier\d)?\b`;
const BARE = new RegExp(
  String.raw`(?<![\w.])${QTY}\s*\*\s*${PRICE}|(?<![\w.])[\w.()]*[Pp]rice(?:PerUnit|Tier\d)?\)?\s*\*\s*${QTY}`,
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

// ---------------------------------------------------------------------------------------------------------------------
// PIN B (SA-982 section 1): `normalizeBoxesPieces(` called with a `boxes:` argument, outside build-line.ts. A hand-built
// pack-axis NEW-write builder is one that does this with CLIENT boxes AND prices the result with `computeLineSubtotal(`
// into a sale-line create: those are the class that converts to `buildLine` one domain at a time (each conversion lowers
// its count in the same diff). The other call sites are out of the class and stay (a re-split of a known piece count, a
// reader of a stored line, inventory); each says which. A CLASS line is one that converts (its count drops in that diff);
// an EDIT line (B717 / SA-077e: resolves against the line's own stored pack) is counted so a new edit-shaped builder cannot
// land unseen, and never converts. SA-982 / SA-982a: the predicate is client `boxes:` + `computeLineSubtotal(` into a sale-line
// create, OR an update that changes the line's productId (a substitute).
// ---------------------------------------------------------------------------------------------------------------------
type Tags = { CLASS?: number; EDIT?: number; OUT?: number };
type PinB = [count: number, tags: Tags, why: string];
const PINNED_B: Record<string, PinB> = {
  "invoices/manual-invoice-lines.ts": [
    1,
    { CLASS: 1 },
    "buildManualInvoiceLines :110 splits the client's item.boxes/pieces, prices at :139 (the purest copy of buildLine's pack axis); warn site invoices.manual",
  ],
  "orders/replace-all-line-build.ts": [
    1,
    { CLASS: 1 },
    "buildReplaceAllLineData :180 splits item.boxes/pieces, prices at :366, the trailing tx.orderItem.create writes it; warn site orders.replace-all",
  ],
  "orders/orders.service.ts": [
    4,
    { CLASS: 3, EDIT: 1 },
    "CLASS: create() lines :1696 (orders.create.lines / counter.sale, priced :1819), the SUBSTITUTE line :3645 (orders.update.substitute: a new sale of a new product on an old row id, priced :3690; SA-982a) and the change-request add :4958 (orders.cr.add, priced :4993, created :4980). EDIT: :3831 orders.update, the same-product line edit that resolves against the line's own pack (B717 / SA-077e); never converts",
  ],
  "orders/counter-sale/counter-sale-lines.ts": [
    1,
    { OUT: 1 },
    "a DTO mapper that passes boxes/pieces through to create(): counted at the orders create site, which carries the counter `site` tag",
  ],
  "orders/merge-items.ts": [
    1,
    { OUT: 1 },
    "foldInto :451 re-splits an accumulator of stored + incoming lines; no pricing here (the merge writer prices)",
  ],
  "orders/buyer-edit-lines.ts": [
    1,
    { OUT: 1 },
    "a reader: the STAFF split is read to a quantity to compare against the stored line, nothing is priced or created",
  ],
  "orders/unit-line-build.ts": [
    1,
    { OUT: 1 },
    "replayLineKey :255 reads a STORED line's boxes/pieces to build an idempotency key",
  ],
  "products/line-units.ts": [
    1,
    { OUT: 1 },
    "norm :221 re-splits a known piece count (boxes: 0, pieces: count) of a line the product already resolved",
  ],
  "recurring-invoices/recurring-line-split.ts": [
    1,
    { OUT: 1 },
    "recurringLineSplit :29 rolls a template quantity's whole boxes + loose pieces over; derived from stored qty, not client boxes (the recurring domain converts later, SA-982 order)",
  ],
  "inventory/inventory.service.ts": [
    4,
    { OUT: 4 },
    "stock quantities (PO receipt, variant assign, create adjustment, stock count lines): not priced sale lines",
  ],
};

const NORMALIZE_CALL = /normalizeBoxesPieces\(/g;
const BOXES_ARG = /\bboxes\b\s*(?::|,|\}|$)/m;

/** The number of `normalizeBoxesPieces(` calls in `code` whose (balanced) argument names `boxes`. */
function boxesCalls(code: string): number {
  let n = 0;
  for (const m of code.matchAll(NORMALIZE_CALL)) {
    let depth = 1;
    let i = (m.index ?? 0) + m[0].length;
    const start = i;
    while (depth > 0 && i < code.length) {
      const ch = code[i++];
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
    }
    if (BOXES_ARG.test(code.slice(start, i - 1))) n++;
  }
  return n;
}

function censusB(): Record<string, number> {
  const found: Record<string, number> = {};
  for (const file of sourceFiles(SRC_ROOT)) {
    const n = boxesCalls(codeOf(fs.readFileSync(file, "utf8")));
    if (n > 0) found[path.relative(SRC_ROOT, file).split(path.sep).join("/")] = n;
  }
  return found;
}

describe("row 139 pin A: bare qty x price line math is count-pinned per file (shrink-only)", () => {
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
      "(Number(item.qty) || 1) * Number(item.unitCost ?? item.unitPrice ?? 0)",
    ]) {
      expect(codeOf(code).match(BARE)).not.toBeNull();
    }
  });

  it("and ignores comments, cost-only math, and the shared calculator", () => {
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

describe("row 139 pin B: hand-built pack-axis builders (normalizeBoxesPieces with boxes:) are count-pinned per file", () => {
  it("every file calling normalizeBoxesPieces with a boxes: argument is pinned, with exactly its count; each pin tags its sites CLASS, EDIT or OUT and says why", () => {
    const expected = Object.fromEntries(Object.entries(PINNED_B).map(([f, [n]]) => [f, n]));
    expect(censusB()).toEqual(expected);
    for (const [count, tags, why] of Object.values(PINNED_B)) {
      expect(Object.values(tags).reduce((a, n) => a + (n ?? 0), 0)).toBe(count);
      expect(why.length).toBeGreaterThan(30);
    }
  });

  it("a new hand builder cannot land: the CLASS sites are exactly the ones SA-982 / SA-982a name (shrinks as domains convert)", () => {
    const classCounts = Object.fromEntries(
      Object.entries(PINNED_B)
        .filter(([, [, tags]]) => (tags.CLASS ?? 0) > 0)
        .map(([f, [, tags]]) => [f, tags.CLASS]),
    );
    expect(classCounts).toEqual({
      "invoices/manual-invoice-lines.ts": 1,
      "orders/orders.service.ts": 3,
      "orders/replace-all-line-build.ts": 1,
    });
    const editSites = Object.entries(PINNED_B)
      .filter(([, [, tags]]) => (tags.EDIT ?? 0) > 0)
      .map(([f]) => f);
    expect(editSites).toEqual(["orders/orders.service.ts"]); // :3831 only; an edit never converts
  });

  it("the detector counts a boxes: argument (key, shorthand), and not a qty-only re-split, or a comment", () => {
    const calls = (code: string) => boxesCalls(codeOf(code));
    expect(
      calls("normalizeBoxesPieces({ boxes: item.boxes, pieces: item.pieces, unitsPerBox })"),
    ).toBe(1);
    expect(calls("normalizeBoxesPieces({ boxes, pieces, unitsPerBox })")).toBe(1);
    expect(calls("normalizeBoxesPieces({\n  boxes: 0,\n  pieces: n,\n  unitsPerBox: u,\n})")).toBe(
      1,
    );
    expect(calls("normalizeBoxesPieces({ qty: sellingUnits * upb, unitsPerBox: upb })")).toBe(0);
    expect(calls("// normalizeBoxesPieces({ boxes: 1 })")).toBe(0);
    expect(
      calls(
        "normalizeBoxesPieces({ qty: a, unitsPerBox: u });\nnormalizeBoxesPieces({ boxes: b, unitsPerBox: u });",
      ),
    ).toBe(1);
  });
});
