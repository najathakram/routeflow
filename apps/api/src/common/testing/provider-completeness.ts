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
  /** Set when the providers value (or a spread inside it) cannot be read statically. */
  unresolvable?: string;
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

// A file is parsed AT MOST ONCE per (path, text): the repo scan asks about the same spec several times
// (analysis, then the completeness check), and every spec imports shared provider files. Re-parsing
// them was most of the run time (several seconds on a PC).
const parseCache = new Map<string, { text: string; sf: ts.SourceFile }>();
/** How many real parses have run (a test pins that the caches keep this small). */
export const parseStats = { parses: 0 };
const parse = (fileName: string, text: string) => {
  const hit = parseCache.get(fileName);
  if (hit && hit.text === text) return hit.sf;
  parseStats.parses += 1;
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  parseCache.set(fileName, { text, sf });
  return sf;
};

// Text of a file read through an injected reader, read once per reader.
const readMemos = new WeakMap<ReadFile, Map<string, string | null>>();
function readOnce(readFile: ReadFile, file: string): string | null {
  let memo = readMemos.get(readFile);
  if (!memo) readMemos.set(readFile, (memo = new Map()));
  if (!memo.has(file)) memo.set(file, readFile(file));
  return memo.get(file) ?? null;
}

const escapeRe = (n: string) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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

/** Every path this module sees is '/'-separated (a Windows `C:\\a\\b` becomes `C:/a/b`). */
export const toPosix = (p: string) => p.replace(/\\/g, "/");

const dirname = (p: string) => p.slice(0, Math.max(p.lastIndexOf("/"), 0));

/** `base` is a '/'-normalised directory (POSIX `/a/b` or a drive path `C:/a/b`); `rel` is `./x` or `../x`. */
function joinPath(base: string, rel: string): string {
  const drive = /^[A-Za-z]:/.exec(base)?.[0] ?? "";
  const rest = drive ? base.slice(drive.length) : base;
  const out = rest.split("/").filter(Boolean);
  for (const part of rel.split("/")) {
    if (part === "..") out.pop();
    else if (part !== ".") out.push(part);
  }
  return `${drive}/${out.join("/")}`;
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
    const text = readOnce(readFile, candidate);
    if (text == null) continue;
    // Cheap text test first: a class import (nearly every provider) has no `const|let|var NAME` in its file,
    // so its production source is never parsed just to find that out.
    if (!new RegExp(`\\b(?:const|let|var)\\s+${escapeRe(name)}\\b`).test(text)) continue;
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
  into: { real: Set<string>; provided: Set<string>; unresolved: string[] },
  depth = 0,
) {
  if (depth > 4) return;
  if (ts.isSpreadElement(el)) {
    // A spread of a bare identifier that names no readable const is UNRESOLVABLE (reported), not a class.
    if (
      ts.isIdentifier(el.expression) &&
      !resolveConst(el.expression.text, sf, fileName, readFile)
    ) {
      into.unresolved.push(`...${el.expression.text}`);
      return;
    }
    // A spread of a CALL is unreadable (`...helper()`), unless it is a method over a literal array
    // (`...[A, B].map(...)`, a stub list whose named classes are read below).
    const spread = unwrapExpr(el.expression);
    if (
      ts.isCallExpression(spread) &&
      !(
        ts.isPropertyAccessExpression(spread.expression) &&
        ts.isArrayLiteralExpression(unwrapExpr(spread.expression.expression))
      )
    ) {
      into.unresolved.push(`...${spread.getText(sf).slice(0, 40)}`);
      return;
    }
    return collect(el.expression, sf, fileName, readFile, into, depth + 1);
  }
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
/**
 * True when `name` is a parameter of an enclosing function whose declared type is an array of object
 * types that ALL carry `provide` and `useValue`: such a list can only hold value stubs, never a bare
 * class, so it cannot make a guarded service REAL. (Derived from the type, not a file allow-list.)
 */
function isStubOnlyParameter(name: string, from: ts.Node): boolean {
  for (let n: ts.Node | undefined = from; n; n = n.parent) {
    if (!ts.isFunctionLike(n)) continue;
    const param = n.parameters.find((q) => ts.isIdentifier(q.name) && q.name.text === name);
    if (!param?.type) continue;
    let t: ts.TypeNode | undefined = param.type;
    if (ts.isTypeReferenceNode(t) && ts.isIdentifier(t.typeName) && t.typeName.text === "Array") {
      t = t.typeArguments?.[0];
    } else if (ts.isArrayTypeNode(t)) {
      t = t.elementType;
    } else {
      return false;
    }
    if (!t || !ts.isTypeLiteralNode(t)) return false;
    const keys = new Set(
      t.members.map((m) => (m.name && ts.isIdentifier(m.name) ? m.name.text : "")),
    );
    return keys.has("provide") && keys.has("useValue");
  }
  return false;
}

const unwrapExpr = (e: ts.Expression): ts.Expression => {
  while (ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isParenthesizedExpression(e)) {
    e = e.expression;
  }
  return e;
};

/** Read-only array methods: they cannot add a provider. */
const READ_ONLY_ARRAY_MEMBERS = new Set([
  "length",
  "map",
  "some",
  "every",
  "find",
  "filter",
  "includes",
  "indexOf",
  "forEach",
  "slice",
  "join",
]);

/** True when `node` is being assigned to, incremented / decremented, or deleted. */
function isWriteTarget(node: ts.Node): boolean {
  const par = node.parent;
  if (ts.isBinaryExpression(par) && par.left === node) {
    return (
      par.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      par.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    );
  }
  if (ts.isPrefixUnaryExpression(par) || ts.isPostfixUnaryExpression(par)) {
    return (
      par.operator === ts.SyntaxKind.PlusPlusToken || par.operator === ts.SyntaxKind.MinusMinusToken
    );
  }
  return ts.isDeleteExpression(par);
}

type LocalArray = { elements: ts.Expression[] } | { unresolvable: string };

/**
 * A `const/let providers = [...]` declared in an enclosing scope of `from` (the nearest wins), with
 * every `providers.push(...)` in that scope folded in (the union: a conditional push counts). It is
 * read ONLY when every reference to the name is one of: a `.push(...)` call, a read-only member
 * (`.length`, `.map`, `.some`, ...), or the `providers` property itself (`{ providers }` /
 * `providers: providers`). Any other use (unshift, splice, a reassignment, an index write, passing
 * it to a helper, ...) could change what is provided, so it is UNRESOLVABLE and reported, never
 * skipped. Returns null when no such declaration exists in an enclosing scope.
 */
function resolveLocalArray(id: ts.Identifier, from: ts.Node): LocalArray | null {
  const name = id.text;
  let scope: ts.Node | null = null;
  let decl: ts.VariableDeclaration | null = null;
  for (let anc: ts.Node | undefined = from.parent; anc && !decl; anc = anc.parent) {
    if (
      ts.isFunctionLike(anc) &&
      anc.parameters.some((q) => ts.isIdentifier(q.name) && q.name.text === name)
    ) {
      return null; // a parameter of that name shadows anything outside
    }
    const statements: readonly ts.Statement[] | undefined =
      ts.isBlock(anc) || ts.isSourceFile(anc) || ts.isModuleBlock(anc)
        ? anc.statements
        : ts.isCaseClause(anc) || ts.isDefaultClause(anc)
          ? anc.statements
          : undefined;
    if (!statements) continue;
    for (const st of statements) {
      if (!ts.isVariableStatement(st)) continue;
      const d = st.declarationList.declarations.find(
        (x) => ts.isIdentifier(x.name) && x.name.text === name,
      );
      if (d) {
        decl = d;
        scope = anc;
        break;
      }
    }
  }
  if (!decl || !scope) return null;
  const init = decl.initializer ? unwrapExpr(decl.initializer) : null;
  if (!init || !ts.isArrayLiteralExpression(init)) {
    return { unresolvable: `${name} = ${init ? init.getText().slice(0, 40) : "(no initializer)"}` };
  }
  const elements: ts.Expression[] = [...init.elements];
  // The first unsafe use, held in an array: a closure-assigned `let` narrows to `never` after the walk.
  const unsafe: string[] = [];
  const visit = (n: ts.Node) => {
    if (unsafe.length > 0) return;
    if (ts.isIdentifier(n) && n.text === name && n !== decl!.name) {
      const par = n.parent;
      if (ts.isPropertyAccessExpression(par) && par.name === n) return; // `x.providers`, not ours
      if (ts.isPropertyAssignment(par) && par.name === n) return; // the key `providers:`
      if (ts.isShorthandPropertyAssignment(par) && par.name === n) return; // `{ providers }`
      if (ts.isPropertyAssignment(par) && par.initializer === n) return; // `providers: providers`
      if (ts.isPropertyAccessExpression(par) && par.expression === n) {
        const member = par.name.text;
        const call = par.parent;
        if (member === "push" && ts.isCallExpression(call) && call.expression === par) {
          elements.push(...call.arguments);
          return;
        }
        // `.length` is a read-only member EXCEPT as a write target: `providers.length = 0` truncates
        // the array, `length -= 1` / `length++` / `delete` shrink or change it.
        if (member === "length" && isWriteTarget(par)) {
          unsafe.push(`${name}.length write`);
          return;
        }
        if (READ_ONLY_ARRAY_MEMBERS.has(member)) return;
        unsafe.push(`${name}.${member}`);
        return;
      }
      unsafe.push(`${name} (${ts.SyntaxKind[par.kind]})`);
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(scope);
  return unsafe.length > 0
    ? { unresolvable: `${name} is mutated or passed on: ${unsafe[0]}` }
    : { elements };
}

export function analyseSpec(
  fileNameIn: string,
  sourceText: string,
  readFile: ReadFile,
): SpecProviderArray[] {
  const fileName = toPosix(fileNameIn);
  const sf = parse(fileName, sourceText);
  const arrays: SpecProviderArray[] = [];
  const visit = (node: ts.Node) => {
    // `providers: [...]`, `providers: someExpr` AND the shorthand `{ providers }`.
    if (
      (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "providers"
    ) {
      const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      const into = {
        real: new Set<string>(),
        provided: new Set<string>(),
        unresolved: [] as string[],
      };
      let init: ts.Expression = ts.isPropertyAssignment(node) ? node.initializer : node.name;
      // Look through `providers as never` / `(providers)` / `providers satisfies X`.
      while (
        ts.isAsExpression(init) ||
        ts.isSatisfiesExpression(init) ||
        ts.isParenthesizedExpression(init)
      ) {
        init = init.expression;
      }
      let at = { sf, fileName };
      if (ts.isIdentifier(init) && isStubOnlyParameter(init.text, node)) {
        // Value stubs only: nothing in it can be a real service, and nothing to resolve.
      } else if (ts.isIdentifier(init)) {
        // `providers: NAME` / `{ providers }`. First a same-scope `const providers = [...]` (with its
        // `.push(...)`s); then a top-level / imported const array; anything else is unresolvable.
        const local = resolveLocalArray(init, node);
        if (local && "elements" in local) {
          for (const el of local.elements) collect(el, sf, fileName, readFile, into);
          init = ts.factory.createArrayLiteralExpression([]); // already collected
        } else if (local) {
          into.unresolved.push(local.unresolvable);
        } else {
          const resolved = resolveConst(init.text, sf, fileName, readFile);
          if (resolved && ts.isArrayLiteralExpression(resolved.node)) {
            init = resolved.node;
            at = { sf: resolved.sourceFile, fileName: resolved.fileName };
          } else {
            into.unresolved.push(init.text);
          }
        }
      } else if (!ts.isArrayLiteralExpression(init)) {
        into.unresolved.push(init.getText(sf).slice(0, 60));
      }
      if (ts.isArrayLiteralExpression(init)) {
        for (const el of init.elements) collect(el, at.sf, at.fileName, readFile, into);
      }
      arrays.push({
        line,
        real: into.real,
        provided: into.provided,
        ...(into.unresolved.length > 0 ? { unresolvable: into.unresolved.join(", ") } : {}),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return arrays;
}

/**
 * Only files whose text mentions a guarded service AND a `providers` list need parsing; the rest are
 * never opened as ASTs. (A spec that builds a service with `new X(...)` has no providers array, so
 * there is nothing to check in it.)
 */
export function candidateSpecs(
  files: readonly string[],
  read: (file: string) => string | null,
  serviceNames: readonly string[],
): string[] {
  return files.filter((f) => {
    const text = read(f);
    return text != null && text.includes("providers") && serviceNames.some((n) => text.includes(n));
  });
}

/**
 * The guarded services a spec provides REAL whose constructor needs something the same providers
 * array does not give, plus any providers value that cannot be read (reported as
 * `(unresolvable providers: ...)`, never passed silently). `deps` maps a service class name to its
 * required tokens.
 */
export function findMissingProviders(
  fileNameIn: string,
  sourceText: string,
  deps: ReadonlyMap<string, readonly string[]>,
  readFile: ReadFile,
): MissingProvider[] {
  const file = toPosix(fileNameIn);
  if (sourceText.includes(".useMocker(")) return []; // auto-mocks every missing dependency
  const mentionsGuarded = [...deps.keys()].some((n) => sourceText.includes(n));
  const out: MissingProvider[] = [];
  for (const arr of analyseSpec(file, sourceText, readFile)) {
    if (arr.unresolvable && mentionsGuarded) {
      out.push({
        file,
        line: arr.line,
        service: `(unresolvable providers: ${arr.unresolvable})`,
        missing: ["cannot verify: make the providers list explicit"],
      });
    }
    for (const [service, required] of deps) {
      if (!arr.real.has(service)) continue;
      const missing = required.filter((t) => !arr.provided.has(t));
      if (missing.length > 0) out.push({ file, line: arr.line, service, missing });
    }
  }
  return out;
}
