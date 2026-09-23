import * as ts from "typescript";

/**
 * B809 — find every value that reaches email HTML without being escaped.
 *
 * Sinks: every template literal that contains a tag, and every `html` / `…Html` property in an
 * object literal (the body handed to `send()`, `bodyHtml`, `headerHtml`). Each interpolated
 * value is followed to where it comes from, within the file:
 *   - a literal, a number literal, or `escapeHtml(…)` / `encodeURIComponent(…)` is safe;
 *   - a template is scanned in HTML context even with no tag of its own (` by ${x}`), so a
 *     tag-less template that flows into HTML is held to the same rule;
 *   - a ternary or `a + b` is safe when every branch or part is;
 *   - an identifier is followed to its declaration: a `const` to its initializer, a function
 *     parameter to the argument at EVERY call site of that function in the file (so
 *     `closing(greeting, signInLine)` checks what each caller passes). `params.x` is followed
 *     to the `x` property of each call's object argument;
 *   - a call to a function declared in the file is safe when every value it returns is, and
 *     `xs.map(cb).join(…)` when `cb`'s result is;
 *   - `new Intl.NumberFormat(…).format(…)` is safe (currency digits carry no markup).
 * Anything else is a hit, keyed `enclosingFunction :: expression` so an allow-list entry
 * names one LOCATION, never every use of the same text in the file.
 */
export interface HtmlHit {
  key: string;
  line: number;
}

/** An email-body HTML tag. A bare `<` (a comparison, or `<area>` in an error message) is not. */
const TAG =
  /<\/?(p|div|a|strong|b|i|em|s|u|small|span|br|hr|img|table|thead|tbody|tfoot|tr|td|th|ul|ol|li|h[1-6]|html|head|body|meta|style|!doctype)[\s>/]/i;
const ESCAPING_CALLS = new Set(["escapeHtml", "encodeURIComponent"]);
const HTML_PROP = /^(html|\w+Html)$/;

type FnLike =
  ts.FunctionDeclaration | ts.MethodDeclaration | ts.ArrowFunction | ts.FunctionExpression;

const isFnLike = (n: ts.Node): n is FnLike =>
  ts.isFunctionDeclaration(n) ||
  ts.isMethodDeclaration(n) ||
  ts.isArrowFunction(n) ||
  ts.isFunctionExpression(n);

/** The name a function is called by: its own name, or the const/property it is assigned to. */
function fnNameOf(fn: FnLike): string | undefined {
  if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && fn.name) {
    return fn.name.getText();
  }
  const p = fn.parent;
  if (p && (ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p))) return p.name.getText();
  return undefined;
}

export function scanHtmlInterpolations(code: string): HtmlHit[] {
  const src = ts.createSourceFile("x.ts", code, ts.ScriptTarget.Latest, true);
  const hits = new Map<string, HtmlHit>();
  const scanned = new Set<ts.Node>();
  const inProgress = new Set<ts.Node>();

  const text = (n: ts.Node) => n.getText(src).replace(/\s+/g, " ");
  const enclosingFnName = (n: ts.Node): string => {
    for (let p = n.parent; p; p = p.parent) {
      if (isFnLike(p)) {
        const name = fnNameOf(p);
        if (name) return name;
      }
    }
    return "<module>";
  };
  const hit = (e: ts.Node) => {
    const key = `${enclosingFnName(e)} :: ${text(e)}`;
    const line = src.getLineAndCharacterOfPosition(e.getStart(src)).line + 1;
    hits.set(`${key}@${line}`, { key, line });
  };

  // Every function in the file by the name it is called by, and every call by callee name.
  const fnsByName = new Map<string, FnLike[]>();
  const callsByName = new Map<string, ts.CallExpression[]>();
  const index = (n: ts.Node) => {
    if (isFnLike(n)) {
      const name = fnNameOf(n);
      if (name) fnsByName.set(name, [...(fnsByName.get(name) ?? []), n]);
    }
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : undefined;
      if (name) callsByName.set(name, [...(callsByName.get(name) ?? []), n]);
    }
    ts.forEachChild(n, index);
  };
  index(src);

  /** Run `check` on `node` once at a time; a cycle is treated as unsafe. */
  const guarded = (node: ts.Node, check: () => boolean): boolean => {
    if (inProgress.has(node)) return false;
    inProgress.add(node);
    try {
      return check();
    } finally {
      inProgress.delete(node);
    }
  };

  /** The declaration an identifier refers to: the nearest const, parameter, or module const. */
  const declOf = (id: ts.Identifier): ts.Node | undefined => {
    for (let p: ts.Node | undefined = id.parent; p; p = p.parent) {
      if (isFnLike(p)) {
        const param = p.parameters.find((q) => ts.isIdentifier(q.name) && q.name.text === id.text);
        if (param) return param;
      }
      if (isFnLike(p) || ts.isSourceFile(p) || ts.isBlock(p)) {
        let found: ts.VariableDeclaration | undefined;
        const look = (n: ts.Node) => {
          if (found || (n !== p && isFnLike(n))) return;
          if (
            ts.isVariableDeclaration(n) &&
            ts.isIdentifier(n.name) &&
            n.name.text === id.text &&
            n.getStart(src) < id.getStart(src)
          ) {
            found = n;
          }
          ts.forEachChild(n, look);
        };
        ts.forEachChild(p, look);
        if (found) return found;
        // `const { html, text } = build(…)`: the identifier is one property of the initializer.
        let destructured: ts.VariableDeclaration | undefined;
        const lookBinding = (n: ts.Node) => {
          if (destructured || (n !== p && isFnLike(n))) return;
          if (
            ts.isVariableDeclaration(n) &&
            ts.isObjectBindingPattern(n.name) &&
            n.name.elements.some((el) => ts.isIdentifier(el.name) && el.name.text === id.text)
          ) {
            destructured = n;
          }
          ts.forEachChild(n, lookBinding);
        };
        ts.forEachChild(p, lookBinding);
        if (destructured) return destructured;
      }
    }
    return undefined;
  };

  /** Every value `fn` can return. */
  const returnsOf = (fn: FnLike): ts.Expression[] => {
    if (!fn.body) return [];
    if (!ts.isBlock(fn.body)) return [fn.body];
    const out: ts.Expression[] = [];
    const look = (n: ts.Node) => {
      if (n !== fn && isFnLike(n)) return;
      if (ts.isReturnStatement(n) && n.expression) out.push(n.expression);
      ts.forEachChild(n, look);
    };
    ts.forEachChild(fn.body, look);
    return out;
  };

  /** Is the argument at `pos` (or its `prop` property) safe at every call of `fn` in the file? */
  const safeAtEveryCall = (fn: FnLike, pos: number, prop?: string): boolean => {
    const name = fnNameOf(fn);
    const calls = (name && callsByName.get(name)) || [];
    if (calls.length === 0) return false;
    return calls.every((call) => {
      const arg = call.arguments[pos];
      if (!arg) return true;
      if (!prop) return safe(arg);
      if (!ts.isObjectLiteralExpression(arg)) return false;
      const p = arg.properties.find((q) => q.name && q.name.getText(src) === prop);
      if (!p) return true;
      if (ts.isPropertyAssignment(p)) return safe(p.initializer);
      if (ts.isShorthandPropertyAssignment(p)) return safe(p.name);
      return false;
    });
  };

  const safe = (e: ts.Expression): boolean => {
    if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) {
      return safe(e.expression);
    }
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) || ts.isNumericLiteral(e)) {
      return true;
    }
    if (ts.isTemplateExpression(e)) {
      scanTemplate(e);
      return true;
    }
    if (ts.isConditionalExpression(e)) return safe(e.whenTrue) && safe(e.whenFalse);
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      return safe(e.left) && safe(e.right);
    }
    if (ts.isCallExpression(e)) return safeCall(e);
    if (ts.isIdentifier(e)) {
      if (/^BRAND_[A-Z_]+$/.test(e.text)) return true;
      const decl = declOf(e);
      if (!decl) return false;
      return guarded(decl, () => {
        if (ts.isVariableDeclaration(decl) && ts.isObjectBindingPattern(decl.name)) {
          return !!decl.initializer && safeProp(decl.initializer, e.text);
        }
        if (ts.isVariableDeclaration(decl)) return !!decl.initializer && safe(decl.initializer);
        if (ts.isParameter(decl) && isFnLike(decl.parent)) {
          return safeAtEveryCall(decl.parent, decl.parent.parameters.indexOf(decl));
        }
        return false;
      });
    }
    if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression)) {
      const decl = declOf(e.expression);
      // `params.x` on a parameter: follow `x` into every call's object argument.
      if (decl && ts.isParameter(decl) && isFnLike(decl.parent)) {
        const fn = decl.parent;
        return guarded(e, () => safeAtEveryCall(fn, fn.parameters.indexOf(decl), e.name.text));
      }
      // `built.html` on a const: safe when that property of what it was built from is.
      if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
        const init = decl.initializer;
        return guarded(e, () => safeProp(init, e.name.text));
      }
    }
    return false;
  };

  /** Is property `prop` of the value `e` safe? Follows object literals, consts and calls. */
  const safeProp = (e: ts.Expression, prop: string): boolean => {
    if (ts.isParenthesizedExpression(e)) return safeProp(e.expression, prop);
    if (ts.isObjectLiteralExpression(e)) {
      const p = e.properties.find((q) => q.name && q.name.getText(src) === prop);
      if (!p) return true;
      if (ts.isPropertyAssignment(p)) return safe(p.initializer);
      if (ts.isShorthandPropertyAssignment(p)) return safe(p.name);
      return false;
    }
    const callee = ts.isCallExpression(e)
      ? ts.isIdentifier(e.expression)
        ? e.expression.text
        : ts.isPropertyAccessExpression(e.expression) &&
            e.expression.expression.kind === ts.SyntaxKind.ThisKeyword
          ? e.expression.name.text
          : undefined
      : undefined;
    if (callee) {
      const fns = fnsByName.get(callee);
      if (fns && fns.length > 0) {
        return fns.every((fn) => guarded(fn, () => returnsOf(fn).every((r) => safeProp(r, prop))));
      }
    }
    if (ts.isIdentifier(e)) {
      const decl = declOf(e);
      if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
        const init = decl.initializer;
        return guarded(decl, () => safeProp(init, prop));
      }
    }
    return safe(e);
  };

  /**
   * Check one value that lands in HTML, reporting the unsafe LEAF: in `a + b` or `c ? a : b`
   * the part that is not safe, never the whole expression.
   */
  const sink = (e: ts.Expression): void => {
    if (ts.isParenthesizedExpression(e)) return sink(e.expression);
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      sink(e.left);
      sink(e.right);
      return;
    }
    if (ts.isConditionalExpression(e)) {
      sink(e.whenTrue);
      sink(e.whenFalse);
      return;
    }
    if (!safe(e)) hit(e);
  };

  const safeCall = (c: ts.CallExpression): boolean => {
    const callee = c.expression;
    const name = ts.isIdentifier(callee)
      ? callee.text
      : ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : "";
    if (ESCAPING_CALLS.has(name)) return true;
    // safe.replace(re, "<br/>"): a literal replacement adds only markup the code chose.
    if (
      (name === "replace" || name === "replaceAll") &&
      ts.isPropertyAccessExpression(callee) &&
      c.arguments[1] !== undefined &&
      ts.isStringLiteral(c.arguments[1]) &&
      safe(callee.expression)
    ) {
      return true;
    }
    // new Intl.NumberFormat(…).format(n): currency digits, no markup.
    if (
      name === "format" &&
      ts.isPropertyAccessExpression(callee) &&
      ts.isNewExpression(callee.expression) &&
      callee.expression.expression.getText(src) === "Intl.NumberFormat"
    ) {
      return true;
    }
    // xs.map(cb).join(…): safe when cb's result is.
    if (
      name === "join" &&
      ts.isPropertyAccessExpression(callee) &&
      ts.isCallExpression(callee.expression) &&
      ts.isPropertyAccessExpression(callee.expression.expression) &&
      callee.expression.expression.name.text === "map"
    ) {
      const cb = callee.expression.arguments[0];
      return !!cb && isFnLike(cb) && returnsOf(cb).every(safe);
    }
    // A function declared in this file: safe when every value it returns is.
    const fns = fnsByName.get(name);
    if (fns && fns.length > 0) {
      return fns.every((fn) => guarded(fn, () => returnsOf(fn).every(safe)));
    }
    return false;
  };

  const scanTemplate = (t: ts.TemplateExpression) => {
    if (scanned.has(t)) return;
    scanned.add(t);
    for (const span of t.templateSpans) sink(span.expression);
  };

  const visit = (n: ts.Node) => {
    if (ts.isTemplateExpression(n) && TAG.test(n.getText(src))) scanTemplate(n);
    if (ts.isPropertyAssignment(n) && HTML_PROP.test(n.name.getText(src))) sink(n.initializer);
    if (ts.isShorthandPropertyAssignment(n) && HTML_PROP.test(n.name.text)) sink(n.name);
    ts.forEachChild(n, visit);
  };
  visit(src);

  return [...hits.values()].sort((a, b) => a.line - b.line);
}
