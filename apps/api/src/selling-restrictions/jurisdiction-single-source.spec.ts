import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

/**
 * L8 structural pin (SA ruling 2026-10-14): WHICH state judges a sale is decided in ONE place,
 * `sale-fulfilment.ts` (`saleFulfilmentKind` -> `judgedAtStore`). COUNTER, POS (a POS hand-over is stored as
 * fulfillPath PICKUP / counterSale: there is no separate POS column, the server never infers it) and PICKUP are
 * judged on the store state; ROUTE and SHIP on the customer's governing address (`resolveGoverningState`).
 *
 *  1. The selling-restrictions engine itself never names `fulfillPath` / `counterSale` / `posMode`: only the helper does.
 *  2. Every `fulfilmentKind:` a call site hands the engine is the helper's answer (`saleFulfilmentKind` /
 *     `orderFulfilmentKind`, directly or through a local bound to one), a pass-through of an already-resolved
 *     `fulfilmentKind`, or `undefined`: never a literal and never a re-derivation from the order's columns.
 * AST-based, comments never count; positively controlled on inline sources.
 */
const SRC = path.resolve(__dirname, "..");
const HELPER = "selling-restrictions/sale-fulfilment.ts";
const FORBIDDEN_NAMES = new Set(["fulfillPath", "counterSale", "posMode", "fulfilPath"]);

const parse = (text: string) =>
  ts.createSourceFile("x.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

function walk(node: ts.Node, visit: (n: ts.Node) => void) {
  visit(node);
  node.forEachChild((c) => walk(c, visit));
}

/** Identifier / property names in the engine files that read the order's fulfilment columns. */
export function forbiddenNames(text: string): string[] {
  const out: string[] = [];
  walk(parse(text), (n) => {
    if (ts.isIdentifier(n) && FORBIDDEN_NAMES.has(n.text)) out.push(n.text);
  });
  return out;
}

const HELPERS = new Set(["saleFulfilmentKind", "orderFulfilmentKind", "defaultSaleFulfilmentKind"]);
const isHelperCall = (e: ts.Expression): boolean => {
  if (ts.isAwaitExpression(e)) return isHelperCall(e.expression);
  return ts.isCallExpression(e) && ts.isIdentifier(e.expression) && HELPERS.has(e.expression.text);
};

/** Violations: a `fulfilmentKind` property whose value is not the helper's answer or a pass-through. */
export function kindViolations(text: string): string[] {
  const sf = parse(text);
  const boundToHelper = new Set<string>();
  walk(sf, (n) => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer &&
      isHelperCall(n.initializer)
    )
      boundToHelper.add(n.name.text);
  });
  const bad: string[] = [];
  walk(sf, (n) => {
    if (ts.isShorthandPropertyAssignment(n) && n.name.text === "fulfilmentKind") {
      if (!boundToHelper.has("fulfilmentKind")) bad.push("shorthand not bound to the helper");
    } else if (
      ts.isPropertyAssignment(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === "fulfilmentKind"
    ) {
      const v = n.initializer;
      const ok =
        isHelperCall(v) ||
        (ts.isIdentifier(v) && (v.text === "undefined" || boundToHelper.has(v.text))) ||
        ((ts.isPropertyAccessExpression(v) || ts.isNonNullExpression(v)) &&
          v.getText().endsWith("fulfilmentKind"));
      if (!ok) bad.push(v.getText());
    }
  });
  return bad;
}

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" || e.name === "testing" ? [] : sources(p);
    return /\.ts$/.test(e.name) && !/\.(spec|test|db\.spec)\.ts$/.test(e.name) ? [p] : [];
  });
}
const rel = (p: string) => path.relative(SRC, p).split(path.sep).join("/");

describe("one jurisdiction source (L8)", () => {
  describe("positive controls", () => {
    it("names of the order's columns are caught; a helper-only file is clean", () => {
      expect(forbiddenNames("const x = order.fulfillPath === 'PICKUP';")).toEqual(["fulfillPath"]);
      expect(forbiddenNames("if (o.counterSale) {}")).toEqual(["counterSale"]);
      expect(forbiddenNames("// fulfillPath in a comment\nconst k = judgedAtStore(kind);")).toEqual(
        [],
      );
    });
    it("a literal or re-derived kind is caught; the helper and pass-throughs are not", () => {
      expect(kindViolations("f({ fulfilmentKind: 'COUNTER' });")).toHaveLength(1);
      expect(kindViolations("f({ fulfilmentKind: o.x ? 'PICKUP' : 'DELIVERY' });")).toHaveLength(1);
      expect(
        kindViolations("const fulfilmentKind = 'PICKUP'; f({ fulfilmentKind });"),
      ).toHaveLength(1);
      expect(kindViolations("f({ fulfilmentKind: saleFulfilmentKind(o) });")).toEqual([]);
      expect(kindViolations("f({ fulfilmentKind: await orderFulfilmentKind(db, id) });")).toEqual(
        [],
      );
      expect(
        kindViolations(
          "const fulfilmentKind = saleFulfilmentKind({ fulfillPath }); f({ fulfilmentKind });",
        ),
      ).toEqual([]);
      expect(kindViolations("f({ fulfilmentKind: params.fulfilmentKind });")).toEqual([]);
    });
  });

  it("the engine files (selling-restrictions/, helper excluded) never read fulfillPath / counterSale / posMode", () => {
    const offenders = sources(path.join(SRC, "selling-restrictions"))
      .filter((f) => rel(f) !== HELPER)
      .flatMap((f) => forbiddenNames(fs.readFileSync(f, "utf8")).map((n) => `${rel(f)}: ${n}`));
    expect(offenders).toEqual([]);
  });

  it("every call site's fulfilmentKind is the helper's answer or a pass-through", () => {
    const offenders = sources(SRC)
      .filter((f) => rel(f) !== HELPER)
      .flatMap((f) => {
        const text = fs.readFileSync(f, "utf8");
        return text.includes("fulfilmentKind")
          ? kindViolations(text).map((v) => `${rel(f)}: ${v}`)
          : [];
      });
    expect(offenders).toEqual([]);
  });

  it("the helper is exported once and used by the callers the ruling names", () => {
    const users = sources(SRC)
      .filter((f) => /saleFulfilmentKind|orderFulfilmentKind/.test(fs.readFileSync(f, "utf8")))
      .map(rel);
    for (const must of [
      "orders/orders.service.ts",
      "orders/fulfil-path-restrictions.ts",
      "invoices/invoices.service.ts",
      "order-templates/order-templates.service.ts",
      "orders/merge-restriction-warning.ts",
      "selling-restrictions/restricted-lines-flag.ts",
    ])
      expect(users).toContain(must);
  });
});
