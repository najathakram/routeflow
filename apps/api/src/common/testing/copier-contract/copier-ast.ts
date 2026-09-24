// AST helpers for the copier-contract spec (see copier-contract.spec.ts for what this proves and
// what it cannot see). Test-support only: hermetic — `fs`, `path` and the TypeScript compiler API,
// no git, no DB, no env. Everything takes SOURCE TEXT so the mutation cases can feed fixtures.
import * as ts from "typescript";

/** Where inside a function the line-write object literals live. */
export type Anchor =
  | { via: "prop"; name: string } //     a property `<name>: …` holding the line literals (`items: { create: … }`, `items: xs.map(…)`)
  | { via: "delegate"; model: string } // `<x>.<model>.create | createMany({ data: … })`
  | { via: "push"; name: string } //     `<name>.push({ … })` into a local array later handed to a create
  | { via: "return" }; //                 a builder that returns the line object

export type FnRef = { name: string; anchor: Anchor };

const parse = (src: string) =>
  ts.createSourceFile("x.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

const fnName = (n: ts.Node): string | undefined => {
  if ((ts.isMethodDeclaration(n) || ts.isFunctionDeclaration(n)) && n.name) return n.name.getText();
  if (
    ts.isVariableDeclaration(n) &&
    n.initializer &&
    (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))
  )
    return n.name.getText();
  return undefined;
};

/** Every function-like node called `name` (a method, function or `const name = () =>`). */
export function findFunctions(src: string, name: string): ts.Node[] {
  const out: ts.Node[] = [];
  const visit = (n: ts.Node) => {
    if (fnName(n) === name) out.push(n);
    ts.forEachChild(n, visit);
  };
  visit(parse(src));
  return out;
}

const keyName = (p: ts.ObjectLiteralElementLike): string | null => {
  if (ts.isSpreadAssignment(p)) return "...spread";
  if (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p))
    return p.name.getText().replace(/^['"]|['"]$/g, "");
  return null;
};

/** Outermost object literals under `node` (does not descend into a literal it has collected). */
function outermostLiterals(
  node: ts.Node,
  fn: ts.Node,
  seen = new Set<string>(),
): ts.ObjectLiteralExpression[] {
  const out: ts.ObjectLiteralExpression[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isObjectLiteralExpression(n)) return void out.push(n);
    if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) {
      // A callback (`.map(i => …)`): only what it RETURNS is a line, not every literal in its body.
      const rets: ts.Node[] = [];
      const collect = (m: ts.Node) => {
        if (ts.isReturnStatement(m) && m.expression) rets.push(m.expression);
        if (!ts.isFunctionLike(m) || m === n) ts.forEachChild(m, collect);
      };
      if (ts.isBlock(n.body)) collect(n.body);
      else rets.push(n.body);
      return rets.forEach(visit);
    }
    if (ts.isIdentifier(n) && !seen.has(n.text)) {
      // `create: itemsData` — follow a local `const itemsData = …` inside the same function.
      seen.add(n.text);
      const decl = findLocal(fn, n.text);
      if (decl?.initializer) out.push(...outermostLiterals(decl.initializer, fn, seen));
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

function findLocal(fn: ts.Node, name: string): ts.VariableDeclaration | undefined {
  let hit: ts.VariableDeclaration | undefined;
  const visit = (n: ts.Node) => {
    if (!hit && ts.isVariableDeclaration(n) && n.name.getText() === name) hit = n;
    ts.forEachChild(n, visit);
  };
  visit(fn);
  return hit;
}

const propValue = (o: ts.ObjectLiteralExpression, name: string) =>
  o.properties.find(
    (p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText() === name,
  )?.initializer;

/** Unwrap `{ data: X }` / `{ create: X }` / `{ createMany: { data: X } }` wrappers down to the line literals. */
function lineLiterals(v: ts.Node, fn: ts.Node): ts.ObjectLiteralExpression[] {
  return outermostLiterals(v, fn).flatMap((o) => {
    const inner = propValue(o, "data") ?? propValue(o, "create") ?? propValue(o, "createMany");
    return inner &&
      o.properties.every((p) =>
        /^(data|create|createMany|skipDuplicates|update|where)$/.test(keyName(p) ?? ""),
      )
      ? lineLiterals(inner, fn)
      : [o];
  });
}

const QUERY_ONLY = /^(select|include|where|orderBy|take|skip)$/;

/**
 * Helpers whose return is a FIXED key set on every path (a typed snapshot, never a partial), so
 * `...helper(x)` inside an anchored literal writes exactly these keys. Only list a helper whose
 * type makes every key mandatory: an optional-key helper would be a false green.
 */
export const SPREAD_HELPER_KEYS: Record<string, string[]> = {
  // @routeflow/pricing, B297: returns CategoryTaxSnapshot (all three keys, null when absent).
  copyCategoryTaxSnapshot: ["categoryTaxType", "categoryTaxRate", "categoryPriceIncludesTax"],
};

/** Top-level keys of the line-write literals inside function `ref.name`, or null when it is not found. */
export function writtenKeys(src: string, ref: FnRef): Set<string> | null {
  const fns = findFunctions(src, ref.name);
  if (!fns.length) return null;
  const keys = new Set<string>();
  for (const fn of fns) {
    const lits: ts.ObjectLiteralExpression[] = [];
    const visit = (n: ts.Node) => {
      const a = ref.anchor;
      if (a.via === "prop" && ts.isPropertyAssignment(n) && n.name.getText() === a.name)
        lits.push(...lineLiterals(n.initializer, fn));
      else if (
        a.via === "push" &&
        ts.isCallExpression(n) &&
        n.expression.getText().endsWith(`${a.name}.push`)
      )
        n.arguments.forEach((arg) => lits.push(...outermostLiterals(arg, fn)));
      else if (
        a.via === "delegate" &&
        ts.isCallExpression(n) &&
        new RegExp(`\\.${a.model}\\.(create|createMany|createManyAndReturn)$`).test(
          n.expression.getText(),
        ) &&
        n.arguments[0]
      )
        lits.push(...lineLiterals(n.arguments[0], fn));
      else if (a.via === "return" && ts.isReturnStatement(n) && n.expression)
        lits.push(...outermostLiterals(n.expression, fn));
      ts.forEachChild(n, visit);
    };
    visit(fn);
    const addKeys = (o: ts.ObjectLiteralExpression) => {
      const ks = o.properties.map(keyName).filter((k): k is string => !!k);
      if (ks.length && ks.every((k) => QUERY_ONLY.test(k))) return; // a select/include/where, not a line
      o.properties.forEach((p) => {
        // `...(cond ? { productId } : {})` contributes its literal keys, and `...helper(x)` the keys
        // SPREAD_HELPER_KEYS pins for that helper; any other spread is opaque.
        const helper =
          ts.isSpreadAssignment(p) &&
          ts.isCallExpression(p.expression) &&
          ts.isIdentifier(p.expression.expression)
            ? SPREAD_HELPER_KEYS[p.expression.expression.text]
            : undefined;
        if (helper) helper.forEach((k) => keys.add(k));
        else if (ts.isSpreadAssignment(p) && !ts.isIdentifier(p.expression))
          outermostLiterals(p.expression, fn).forEach(addKeys);
        else if (keyName(p)) keys.add(keyName(p)!);
      });
    };
    lits.forEach(addKeys);
  }
  return keys;
}

/** Discovery: every (function) that writes one of `models` — delegate calls, or a nested `<relation>: { create }`. */
export function writeSites(src: string, models: string[], relationNames: Set<string>): string[] {
  const lc = (s: string) => s[0].toLowerCase() + s.slice(1);
  const delegate = new RegExp(
    `\\.(${models.map(lc).join("|")})\\.(create|createMany|createManyAndReturn|upsert)$`,
  );
  const out = new Set<string>();
  const enclosing = (n: ts.Node) => {
    for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
      const nm = fnName(p);
      if (nm) return nm;
    }
    return "<top>";
  };
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && delegate.test(n.expression.getText())) out.add(enclosing(n));
    if (
      ts.isPropertyAssignment(n) &&
      relationNames.has(n.name.getText()) &&
      ts.isObjectLiteralExpression(n.initializer) &&
      n.initializer.properties.some((p) => /^(create|createMany|upsert)$/.test(keyName(p) ?? ""))
    )
      out.add(enclosing(n));
    ts.forEachChild(n, visit);
  };
  visit(parse(src));
  return [...out];
}
