/**
 * L-247 guard helper — "a spec that provides a REAL service must provide everything its constructor
 * needs". The scan behind `service-provider-completeness.spec.ts`.
 *
 * Why: a DB-lane spec (`*.db.spec.ts`) builds a Nest testing module with the REAL service, but it
 * cannot run in the unit lane, so a constructor dependency added later (`EntitlementAuthority`, #2241)
 * left several of them unable to compile their module and nobody saw it until a DB run. This reads
 * the specs' source (never runs them), so the gap is caught WITHOUT a database.
 *
 * What it derives (nothing is listed by hand):
 *  - a guarded service's REQUIRED providers from its own constructor parameters (a param is required
 *    unless it is `?` or `@Optional()`; the token is the `@Inject(...)` token when there is one, else
 *    the parameter's type name), so a dependency added tomorrow is covered the day it lands;
 *  - what a spec PROVIDES from each `providers: [...]` array: a bare class is a REAL provider,
 *    `{ provide: X, ... }` provides X (any of useValue / useClass / useFactory / useExisting), an
 *    identifier or spread that names a `const` provider object / array (same file, or a relative
 *    import such as `testing/entitlement-authority-provider`) is resolved and read the same way, and
 *    a call element (`...[A, B].map(...)`, a helper) counts the class names it names as STUBBED.
 *
 * A guarded service counts only when it is REAL (a bare class in `providers`). A stub of it
 * (`{ provide: ProductsService, useValue }`, `.map`, `useMocker`) is not, and needs nothing. A spec
 * that calls `.useMocker(` auto-mocks every missing dependency, so it is complete by construction.
 * There is no allow-list: an unresolvable provider is reported, and the fix is to make the spec
 * explicit.
 */
import * as ts from "typescript";

export interface SpecProviderArray {
  /** 1-based line of the `providers` array. */
  line: number;
  /** Bare classes in the array (REAL providers). */
  real: Set<string>;
  /** Every token provided: real classes plus `provide:` tokens plus stubbed class names. */
  provided: Set<string>;
}

export interface MissingProvider {
  file: string;
  line: number;
  service: string;
  missing: string[];
}

export type ReadFile = (absolutePath: string) => string | null;

const parse = (fileName: string, text: string) =>
  ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

const decoratorName = (d: ts.Decorator): string | null => {
  const e = d.expression;
  if (ts.isCallExpression(e) && ts.isIdentifier(e.expression)) return e.expression.text;
  if (ts.isIdentifier(e)) return e.text;
  return null;
};

/** The token a constructor parameter asks Nest for, or null when it is optional. */
function paramToken(p: ts.ParameterDeclaration): string | null {
  const decorators = ts.canHaveDecorators(p) ? (ts.getDecorators(p) ?? []) : [];
  if (p.questionToken || decorators.some((d) => decoratorName(d) === "Optional")) return null;
  const inject = decorators.find((d) => decoratorName(d) === "Inject");
  if (inject && ts.isCallExpression(inject.expression)) {
    const arg = inject.expression.arguments[0];
    if (arg && ts.isIdentifier(arg)) return arg.text;
    if (arg && ts.isStringLiteralLike(arg)) return `"${arg.text}"`;
    if (arg && ts.isCallExpression(arg) && arg.arguments[0]) {
      // forwardRef(() => Foo)
      const fn = arg.arguments[0];
      if (ts.isArrowFunction(fn) && ts.isIdentifier(fn.body)) return fn.body.text;
    }
  }
  const type = p.type;
  if (type && ts.isTypeReferenceNode(type)) {
    const n = type.typeName;
    return ts.isIdentifier(n) ? n.text : n.right.text;
  }
  return null;
}

/** The required provider tokens of `className`'s constructor, in parameter order. */
export function constructorDeps(sourceText: string, className: string): string[] {
  const sf = parse(`${className}.ts`, sourceText);
  const deps: string[] = [];
  let found = false;
  const visit = (node: ts.Node) => {
    if (ts.isClassDeclaration(node) && node.name?.text === className) {
      found = true;
      for (const m of node.members) {
        if (ts.isConstructorDeclaration(m)) {
          for (const p of m.parameters) {
            const t = paramToken(p);
            if (t) deps.push(t);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (!found) throw new Error(`class ${className} not found`);
  return deps;
}

interface Resolved {
  node: ts.Expression;
  sourceFile: ts.SourceFile;
  fileName: string;
}

/** `const name = <object | array>` at the top level of a file (exported or not). */
function topLevelConst(sf: ts.SourceFile, name: string): ts.Expression | null {
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer) {
        let init = d.initializer;
        while (
          ts.isAsExpression(init) ||
          ts.isSatisfiesExpression(init) ||
          ts.isParenthesizedExpression(init)
        ) {
          init = init.expression;
        }
        return init;
      }
    }
  }
  return null;
}

function relativeImport(sf: ts.SourceFile, name: string): string | null {
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const spec = st.moduleSpecifier.text;
    if (!spec.startsWith(".")) continue;
    const named = st.importClause?.namedBindings;
    if (named && ts.isNamedImports(named) && named.elements.some((e) => e.name.text === name)) {
      return spec;
    }
  }
  return null;
}

const dirname = (p: string) => p.slice(0, Math.max(p.lastIndexOf("/"), 0));

function joinPath(base: string, rel: string): string {
  const out = base.split("/").filter(Boolean);
  for (const part of rel.split("/")) {
    if (part === "..") out.pop();
    else if (part !== ".") out.push(part);
  }
  return `/${out.join("/")}`;
}

/** Resolves an identifier to a provider `const` (object or array), here or through a relative import. */
function resolveConst(
  name: string,
  sf: ts.SourceFile,
  fileName: string,
  readFile: ReadFile,
): Resolved | null {
  const local = topLevelConst(sf, name);
  if (local) return { node: local, sourceFile: sf, fileName };
  const rel = relativeImport(sf, name);
  if (!rel) return null;
  const base = joinPath(dirname(fileName), rel);
  for (const candidate of [`${base}.ts`, `${base}/index.ts`]) {
    const text = readFile(candidate);
    if (text == null) continue;
    const other = parse(candidate, text);
    const found = topLevelConst(other, name);
    if (found) return { node: found, sourceFile: other, fileName: candidate };
  }
  return null;
}

/** Class names mentioned inside a call element (`...[A, B].map(...)`, `mock(A)`): STUBBED, not real. */
function namedClasses(node: ts.Node, out: Set<string>) {
  if (ts.isIdentifier(node) && /^[A-Z]/.test(node.text)) out.add(node.text);
  ts.forEachChild(node, (c) => namedClasses(c, out));
}

function collect(
  el: ts.Expression,
  sf: ts.SourceFile,
  fileName: string,
  readFile: ReadFile,
  into: { real: Set<string>; provided: Set<string> },
  depth = 0,
) {
  if (depth > 4) return;
  if (ts.isSpreadElement(el))
    return collect(el.expression, sf, fileName, readFile, into, depth + 1);
  if (ts.isParenthesizedExpression(el) || ts.isAsExpression(el) || ts.isSatisfiesExpression(el)) {
    return collect(el.expression, sf, fileName, readFile, into, depth + 1);
  }
  if (ts.isIdentifier(el)) {
    const resolved = resolveConst(el.text, sf, fileName, readFile);
    if (resolved) {
      return collect(
        resolved.node,
        resolved.sourceFile,
        resolved.fileName,
        readFile,
        into,
        depth + 1,
      );
    }
    into.real.add(el.text);
    into.provided.add(el.text);
    return;
  }
  if (ts.isArrayLiteralExpression(el)) {
    for (const e of el.elements) collect(e, sf, fileName, readFile, into, depth + 1);
    return;
  }
  if (ts.isObjectLiteralExpression(el)) {
    for (const prop of el.properties) {
      if (
        ts.isPropertyAssignment(prop) &&
        ts.isIdentifier(prop.name) &&
        prop.name.text === "provide"
      ) {
        const v = prop.initializer;
        if (ts.isIdentifier(v)) into.provided.add(v.text);
        else if (ts.isStringLiteralLike(v)) into.provided.add(`"${v.text}"`);
      }
    }
    return;
  }
  // A call element / call spread: a helper or `.map` stub. Count the class names it mentions as stubbed.
  const named = new Set<string>();
  namedClasses(el, named);
  for (const n of named) into.provided.add(n);
}

/** Every `providers: [...]` array in a spec, with what it provides. */
export function analyseSpec(
  fileName: string,
  sourceText: string,
  readFile: ReadFile,
): SpecProviderArray[] {
  const sf = parse(fileName, sourceText);
  const arrays: SpecProviderArray[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "providers" &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      const into = { real: new Set<string>(), provided: new Set<string>() };
      for (const el of node.initializer.elements) collect(el, sf, fileName, readFile, into);
      const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      arrays.push({ line, ...into });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return arrays;
}

/**
 * The guarded services a spec provides REAL whose constructor needs something the same providers
 * array does not give. `deps` maps a service class name to its required tokens.
 */
export function findMissingProviders(
  fileName: string,
  sourceText: string,
  deps: ReadonlyMap<string, readonly string[]>,
  readFile: ReadFile,
): MissingProvider[] {
  if (sourceText.includes(".useMocker(")) return []; // auto-mocks every missing dependency
  const out: MissingProvider[] = [];
  for (const arr of analyseSpec(fileName, sourceText, readFile)) {
    for (const [service, required] of deps) {
      if (!arr.real.has(service)) continue;
      const missing = required.filter((t) => !arr.provided.has(t));
      if (missing.length > 0) out.push({ file: fileName, line: arr.line, service, missing });
    }
  }
  return out;
}
