import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

/**
 * B562 PR-2 (SA-136 §6.2) — writer coverage for the stock-ledger invariant (§1): every write to
 * `Product.currentStock` appends a StockMovement for that product in the same transaction.
 *
 * Every `currentStock: { increment | decrement }` property and every raw-SQL `SET "currentStock"`
 * under apps/api/src (non-spec `.ts`) is a WRITE SITE. A site is PAIRED when the nearest enclosing
 * function (class method, function declaration, arrow or function expression — free functions too,
 * since `orders/order-stock.ts` is a module of functions) also contains a movement write:
 * `<x>.stockMovement.create(...)` / `createMany(...)`, or a call to one of the shared movement
 * writers below. AST, not regex: a comment or a string never counts.
 *
 * A site that is not paired fails the build unless it is on ALLOW_UNPAIRED, which may only SHRINK
 * (UNPAIRED_BASELINE forces it): a new writer without its ledger row is a red `npm run verify`.
 */

/** Shared movement writers: a call to one of these pairs the site that calls it. */
const MOVEMENT_WRITERS = new Set(["recordSaleMovement", "bookRestockMovement"]);

/** `<file>::<enclosing function>` → why the counter write has no movement in the same function. */
const ALLOW_UNPAIRED: Record<string, string> = {
  // SA-136 §7 "out of scope, filed separately": the vendor-bill un-receive DELETES the bill's PURCHASE
  // movement(s) and decrements the counter by the same pieces, so Σquantity still equals the counter
  // (no gap) — but the receipt's history is erased instead of reversed by an appended row.
  "vendor-bills/vendor-bills.service.ts::VendorBillsService.revertToDraft":
    "un-receive deletes the PURCHASE row instead of appending a reversal (filed separately, SA-136 §7)",
};
/** The RATCHET: may only go DOWN. */
const UNPAIRED_BASELINE = 1;

const SRC_ROOT = path.resolve(__dirname, "..");

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      collectSourceFiles(full, out);
      continue;
    }
    if (!entry.name.endsWith(".ts") || entry.name.endsWith(".spec.ts")) continue;
    out.push(full);
  }
  return out;
}

const parse = (name: string, text: string) =>
  ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);

const isFunctionLike = (n: ts.Node) =>
  ts.isMethodDeclaration(n) ||
  ts.isFunctionDeclaration(n) ||
  ts.isArrowFunction(n) ||
  ts.isFunctionExpression(n) ||
  ts.isConstructorDeclaration(n);

/** The name a reviewer would look for: `Class.method`, `fn`, or `<outer>.<const arrow>`. */
function functionName(fn: ts.Node, sf: ts.SourceFile): string {
  const own = (n: ts.Node): string | null => {
    if ((ts.isMethodDeclaration(n) || ts.isFunctionDeclaration(n)) && n.name)
      return n.name.getText(sf);
    if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && ts.isVariableDeclaration(n.parent))
      return n.parent.name.getText(sf);
    return null;
  };
  const parts: string[] = [];
  for (let c: ts.Node | undefined = fn; c; c = c.parent) {
    if (isFunctionLike(c)) {
      const name = own(c);
      if (name) parts.unshift(name);
    }
    if (ts.isClassDeclaration(c) && c.name) parts.unshift(c.name.text);
  }
  return parts.join(".") || "<anonymous>";
}

function nearestFunction(n: ts.Node): ts.Node | null {
  for (let c: ts.Node | undefined = n.parent; c; c = c.parent) if (isFunctionLike(c)) return c;
  return null;
}

/** Write sites: `currentStock: { increment|decrement: … }` and raw SQL that SETs "currentStock". */
function stockWriteSites(sf: ts.SourceFile): ts.Node[] {
  const out: ts.Node[] = [];
  const visit = (n: ts.Node) => {
    if (
      ts.isPropertyAssignment(n) &&
      n.name.getText(sf) === "currentStock" &&
      ts.isObjectLiteralExpression(n.initializer) &&
      n.initializer.properties.some(
        (p) => p.name && ["increment", "decrement"].includes(p.name.getText(sf)),
      )
    )
      out.push(n);
    if (ts.isTaggedTemplateExpression(n)) {
      const text = n.template.getText(sf);
      if (/SET\s+"currentStock"/i.test(text)) out.push(n);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** True when `fn` (nested functions included) writes a StockMovement or calls a shared writer. */
function writesMovement(fn: ts.Node, sf: ts.SourceFile): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      if (
        ts.isPropertyAccessExpression(callee) &&
        ["create", "createMany"].includes(callee.name.text) &&
        ts.isPropertyAccessExpression(callee.expression) &&
        callee.expression.name.text === "stockMovement"
      )
        found = true;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : null;
      if (name && MOVEMENT_WRITERS.has(name)) found = true;
    }
    ts.forEachChild(n, visit);
  };
  visit(fn);
  void sf;
  return found;
}

interface Site {
  key: string;
  line: number;
  paired: boolean;
}

function scan(rel: string, text: string): Site[] {
  const sf = parse(rel, text);
  return stockWriteSites(sf).map((site) => {
    const fn = nearestFunction(site);
    return {
      key: `${rel}::${fn ? functionName(fn, sf) : "<module>"}`,
      line: sf.getLineAndCharacterOfPosition(site.getStart()).line + 1,
      paired: fn != null && writesMovement(fn, sf),
    };
  });
}

describe("stock-ledger writer coverage (B562 SA-136 §6.2)", () => {
  const sites = collectSourceFiles(SRC_ROOT).flatMap((abs) =>
    scan(path.relative(SRC_ROOT, abs).split(path.sep).join("/"), fs.readFileSync(abs, "utf8")),
  );

  it("finds the known writers (the scan is live, not vacuous)", () => {
    const keys = new Set(sites.map((s) => s.key));
    expect(keys).toContain("orders/order-stock.ts::decrementStockForSale");
    expect(keys).toContain("orders/order-stock.ts::settleStockForEdit");
    expect(keys).toContain("inventory/inventory.service.ts::InventoryService.recordPurchase");
    expect(sites.length).toBeGreaterThan(10);
  });

  it("every currentStock write is paired with a StockMovement in the same function", () => {
    const unpaired = sites
      .filter((s) => !s.paired && !(s.key in ALLOW_UNPAIRED))
      .map((s) => `${s.key} (line ${s.line})`);
    expect(unpaired).toEqual([]);
  });

  it("the allow-list only names live, still-unpaired sites and never grows", () => {
    const unpairedKeys = new Set(sites.filter((s) => !s.paired).map((s) => s.key));
    for (const key of Object.keys(ALLOW_UNPAIRED)) expect(unpairedKeys).toContain(key);
    expect(Object.keys(ALLOW_UNPAIRED).length).toBeLessThanOrEqual(UNPAIRED_BASELINE);
  });

  // ── positive controls on inline source (the classifier itself) ───────────────────────────────
  it("control: an increment with no movement in its function is unpaired", () => {
    const [s] = scan(
      "x.ts",
      "class S { async m(tx) { await tx.product.update({ data: { currentStock: { increment: 1 } } }); } }",
    );
    expect(s).toMatchObject({ key: "x.ts::S.m", paired: false });
  });

  it("control: a raw-SQL SET currentStock paired by recordSaleMovement in a free function", () => {
    const [s] = scan(
      "x.ts",
      'async function f(tx) { await tx.$queryRaw`UPDATE "Product" SET "currentStock" = 1`; await recordSaleMovement(tx, {}); }',
    );
    expect(s).toMatchObject({ key: "x.ts::f", paired: true });
  });

  it("control: a movement in a DIFFERENT function does not pair the write", () => {
    const sites2 = scan(
      "x.ts",
      "class S { a(tx) { tx.product.update({ data: { currentStock: { decrement: 2 } } }); } b(tx) { tx.stockMovement.create({}); } }",
    );
    expect(sites2).toEqual([expect.objectContaining({ key: "x.ts::S.a", paired: false })]);
  });

  it("control: a comment or string mentioning the pattern is not a site", () => {
    expect(
      scan("x.ts", '// currentStock: { increment: 1 }\nconst s = "SET \\"currentStock\\"";'),
    ).toEqual([]);
  });
});
