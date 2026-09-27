// AST helpers for the copier-contract spec (see copier-contract.spec.ts for what this proves and
// what it cannot see). Test-support only: hermetic — `fs`, `path` and the TypeScript compiler API,
// no git, no DB, no env. Everything takes SOURCE TEXT so the mutation cases can feed fixtures.
import * as ts from "typescript";

/** Where inside a function the line-write object literals live. */
export type Anchor =
  | { via: "prop"; name: string } //     a property `<name>: …` holding the line literals (`items: { create: … }`, `items: xs.map(…)`)
  | { via: "delegate"; model: string } // `<x>.<model>.create | createMany({ data: … })`
  | { via: "push"; name: string } //     `<name>.push({ … })` into a local array later handed to a create
  | { via: "return"; nested?: boolean }; // a builder that returns the line object; `nested`: only
//                                          returns INSIDE a callback count (the builder wraps its lines)

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
    if (ts.isCallExpression(n)) {
      // `.map((i) => ({ … }))`: a CALLBACK's returns are lines. Any other argument (`build({ … })`, a
      // local literal passed to a helper) is that helper's INPUT, not a written row, so it is opaque.
      visit(n.expression);
      for (const arg of n.arguments) {
        if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) visit(arg);
        else if (ts.isIdentifier(arg)) {
          const init = findLocal(fn, arg.text)?.initializer;
          if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) visit(arg);
        }
      }
      return;
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
  // B297: returns CategoryTaxSnapshot (all three keys, null when absent). The spec pins this list
  // against the real helper's output on both of its paths.
  copyCategoryTaxSnapshot: ["categoryTaxType", "categoryTaxRate", "categoryPriceIncludesTax"],
};
/** A SPREAD_HELPER_KEYS name counts only when the file imports it from here (never a same-named local). */
const SPREAD_HELPER_MODULE = "@routeflow/pricing";

/** Names `src` imports (unaliased) from SPREAD_HELPER_MODULE. */
function helperImports(src: string): Set<string> {
  const names = new Set<string>();
  for (const st of parse(src).statements)
    if (
      ts.isImportDeclaration(st) &&
      ts.isStringLiteral(st.moduleSpecifier) &&
      st.moduleSpecifier.text === SPREAD_HELPER_MODULE &&
      st.importClause?.namedBindings &&
      ts.isNamedImports(st.importClause.namedBindings)
    )
      for (const el of st.importClause.namedBindings.elements)
        if (!el.propertyName) names.add(el.name.text);
  return names;
}

/** The nearest function-like node around `n`. */
function enclosingFn(n: ts.Node): ts.Node | undefined {
  let p = n.parent;
  while (p && !ts.isFunctionLike(p)) p = p.parent;
  return p;
}

/**
 * The function-like node whose OWN body `fn` is: findFunctions returns the VariableDeclaration for
 * `const f = () => {}` / `const f = function () {}`, and a return's enclosing function is then the
 * initializer, never the declaration (without this, `nested` silently did nothing for those forms).
 */
const ownBody = (fn: ts.Node): ts.Node =>
  ts.isVariableDeclaration(fn) && fn.initializer ? fn.initializer : fn;

/** Top-level keys of the line-write literals inside function `ref.name`, or null when it is not found. */
export function writtenKeys(src: string, ref: FnRef): Set<string> | null {
  const fns = findFunctions(src, ref.name);
  if (!fns.length) return null;
  const keys = new Set<string>();
  const imported = helperImports(src);
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
      else if (
        a.via === "return" &&
        ts.isReturnStatement(n) &&
        n.expression &&
        // `nested` counts only returns inside an inner function (the line callback). Stated limits:
        // a return in ANY inner function counts (a helper arrow, an IIFE), and a concise-body
        // callback `i => ({ … })` has no ReturnStatement, so it reads nothing: a false RED, never green.
        (!a.nested || enclosingFn(n) !== ownBody(fn))
      )
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
        const callee =
          ts.isSpreadAssignment(p) &&
          ts.isCallExpression(p.expression) &&
          ts.isIdentifier(p.expression.expression)
            ? p.expression.expression.text
            : undefined;
        const helper = callee && imported.has(callee) ? SPREAD_HELPER_KEYS[callee] : undefined;
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

/**
 * D-20 (SA-330): the keys a copier passes THROUGH an internal options object (e.g. `create(dto, user, { sourceLines:
 * { [productId]: { unitsPerBox, unitPrice, ... } } })`), which the anchored line literal cannot see. Every property
 * name found (deeply) inside the object literal assigned to `<optionName>:` within function `fn`. Empty set = the
 * hand-off is gone.
 */
export function optionsPassedKeys(src: string, fn: string, optionName: string): Set<string> {
  const keys = new Set<string>();
  for (const node of findFunctions(src, fn)) {
    const visit = (n: ts.Node) => {
      if (ts.isPropertyAssignment(n) && n.name.getText() === optionName) {
        const collect = (m: ts.Node) => {
          if (ts.isPropertyAssignment(m) || ts.isShorthandPropertyAssignment(m)) {
            if (!ts.isComputedPropertyName(m.name))
              keys.add(m.name.getText().replace(/^['"]|['"]$/g, ""));
          }
          ts.forEachChild(m, collect);
        };
        collect(n.initializer);
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
  }
  return keys;
}
