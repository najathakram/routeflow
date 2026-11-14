import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

/**
 * W-1187 (D3): the order owns its line order, so EVERY writer that creates an OrderItem stamps a `position`. A line with
 * no position sorts last and ties break by creation time: exactly the "new line lands in the middle" bug this build
 * removes. Structure, not text (TypeScript AST, comments cannot satisfy it):
 *
 *   P2  every `orderItem.create(...)` under apps/api/src names `position` in its `data` object, or is one of the
 *       classified exceptions below; the NUMBER of such sites is pinned, so a new writer fails until it is classified
 *   P2b the nested `lineItems: { create }` writers (order create, standing-order run) stamp a position per line
 *   P5  the line read order is written ONCE (`ORDER_LINE_ORDER_BY` in line-position.ts): no other `orderBy` array puts
 *       `position` immediately before `createdAt`
 */
const SRC = path.resolve(__dirname, "..");

function sources(dir = SRC): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" || e.name === "testing" ? [] : sources(p);
    return /\.ts$/.test(e.name) && !/\.(spec|test)\.ts$/.test(e.name) ? [p] : [];
  });
}

const parsed = sources().map((file) => ({
  file: path.relative(SRC, file).replace(/\\/g, "/"),
  sf: ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true),
}));

function walk(node: ts.Node, visit: (n: ts.Node) => void) {
  visit(node);
  node.forEachChild((c) => walk(c, visit));
}

const propName = (p: ts.ObjectLiteralElementLike): string | undefined =>
  p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : undefined;

/** The object-literal argument of `<x>.orderItem.create({ data: {...} })` calls: file + whether `data` names `position`. */
function orderItemCreates() {
  const found: Array<{ file: string; line: number; stamps: boolean; spreads: boolean }> = [];
  for (const { file, sf } of parsed) {
    walk(sf, (n) => {
      if (!ts.isCallExpression(n) || !/\borderItem\.create$/.test(n.expression.getText(sf))) return;
      const arg = n.arguments[0];
      const data =
        arg && ts.isObjectLiteralExpression(arg)
          ? arg.properties.find((p) => propName(p) === "data")
          : undefined;
      const init = data && ts.isPropertyAssignment(data) ? data.initializer : undefined;
      const props = init && ts.isObjectLiteralExpression(init) ? init.properties : [];
      found.push({
        file,
        line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
        stamps: props.some((p) => propName(p) === "position"),
        spreads: props.some(ts.isSpreadAssignment),
      });
    });
  }
  return found;
}

/**
 * The creates whose `data` does not name `position` themselves, and why that is safe. The spread carries it: the unit
 * line is built by `buildUnitLine(..., position)`, which puts the caller's slot into the returned data.
 */
const SPREAD_CARRIES_POSITION: Record<string, string> = {
  "orders/unit-line-edit.ts":
    "createUnitLine: `built` comes from buildUnitLine(position) and the caller passes slots.next()",
};

/** Every `orderItem.create(` site in the API. A new one fails here until it stamps a position and the count moves. */
const ORDER_ITEM_CREATE_SITES = 12;

describe("P2: every OrderItem create stamps a position", () => {
  const creates = orderItemCreates();

  it("the number of orderItem.create sites is the known one", () => {
    expect(creates).toHaveLength(ORDER_ITEM_CREATE_SITES);
  });

  it("each names `position` in its data, or is a classified spread", () => {
    const bad = creates.filter((c) => !c.stamps && !(c.spreads && SPREAD_CARRIES_POSITION[c.file]));
    expect(bad.map((c) => `${c.file}:${c.line}`)).toEqual([]);
  });

  it("every classified spread exception still has a create (no stale row)", () => {
    for (const file of Object.keys(SPREAD_CARRIES_POSITION)) {
      expect(creates.some((c) => c.file === file && !c.stamps)).toBe(true);
    }
  });

  it("the unit-line builder takes the position and returns it in its data", () => {
    const text = fs.readFileSync(path.join(SRC, "orders/unit-line-edit.ts"), "utf8");
    expect(text).toMatch(/\bposition,\s*\n/); // a shorthand `position,` in the built data literal
    expect(text).toMatch(/position:\s*number,/); // the parameter
  });
});

describe("P2b: the nested lineItems creates stamp a position per line", () => {
  it("OrdersService.create maps its lines with `position: index`", () => {
    const text = fs.readFileSync(path.join(SRC, "orders/orders.service.ts"), "utf8");
    expect((text.match(/position:\s*index\b/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it("the standing-order run stamps its template index", () => {
    const text = fs.readFileSync(
      path.join(SRC, "order-templates/order-templates.service.ts"),
      "utf8",
    );
    expect(text).toContain("allowedItems.map((item, index) =>");
    expect(text).toMatch(/position: index,/);
  });
});

describe("P5: the line read order has one definition", () => {
  it("no orderBy array outside line-position.ts puts position immediately before createdAt", () => {
    const offenders: string[] = [];
    for (const { file, sf } of parsed) {
      if (file === "orders/line-position.ts") continue;
      walk(sf, (n) => {
        if (!ts.isArrayLiteralExpression(n)) return;
        const keys = n.elements.map((e) => {
          const lit = ts.isAsExpression(e) ? e.expression : e;
          return ts.isObjectLiteralExpression(lit) && lit.properties.length === 1
            ? propName(lit.properties[0])
            : undefined;
        });
        for (let i = 0; i + 1 < keys.length; i++) {
          if (keys[i] === "position" && keys[i + 1] === "createdAt") {
            offenders.push(`${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`);
          }
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it("the shared order itself is position, createdAt, id", () => {
    const text = fs.readFileSync(path.join(SRC, "orders/line-position.ts"), "utf8");
    expect(text).toMatch(
      /ORDER_LINE_ORDER_BY = \[\s*\{ position: "asc" as const \},\s*\{ createdAt: "asc" as const \},\s*\{ id: "asc" as const \},?\s*\]/,
    );
  });
});
