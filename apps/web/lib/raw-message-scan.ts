import * as fs from "fs";
import * as path from "path";

import ts from "typescript";

/**
 * B986 scan helper: finds the reads that put a server / axios message into the UI. Used by the static pin
 * `raw-message-scan.test.ts` and by `toast-no-raw-message.test.ts`.
 *
 * It walks the TypeScript AST (not a regex over text), so comments, strings, regexes, template text and JSX text can never
 * hide or fake a read, and an apostrophe in JSX text or a `/>` after a quoted attribute cannot blank the rest of a line.
 *
 * COUNTED forms (each node counts once):
 *   - `<receiver>.message` where the receiver is a known error / body alias (see RECEIVERS), a cast or parenthesised
 *     expression (`(err as Error).message`), or a `...data` / `...response` chain (`res.data.message`);
 *   - `response.data.error` / `.detail`;
 *   - bracket access with the literal "message": `err["message"]`;
 *   - destructuring a `message` out of an error-ish value: `const { message } = err`, `{ data: { message } } = e.response`,
 *     `({ message } = body)`.
 *
 * OUT OF SCOPE by design (never counted, and listed here so nobody re-asks): reads of a message from a SUCCESS body or from
 * AI output, which is product content, not an error string: `refund-toast.ts` (`u.message` of an unbilled-lines list),
 * `RegulatedReportPanel` (a generated-report note), `routes/templates/[id]` (a validation list from a successful preview),
 * and the settings success banners. They use receivers outside RECEIVERS on purpose.
 */

/** Receivers that carry a server / axios body, error or plan-gate payload in this codebase. */
const RECEIVERS = new Set([
  "err",
  "error",
  "e",
  "ex",
  "exc",
  "data",
  "body",
  "payload",
  "res",
  "resp",
  "response",
  "result",
  "d",
  "gate",
  "errData",
  "errBody",
  "errorBody",
]);

const isCastLike = (n: ts.Node): boolean =>
  ts.isParenthesizedExpression(n) ||
  ts.isAsExpression(n) ||
  ts.isNonNullExpression(n) ||
  ts.isTypeAssertionExpression(n);

/** True when `e` is a value that holds a server error / body (an alias, a cast, or a `.data` / `.response` chain). */
function isErrorish(e: ts.Expression): boolean {
  if (ts.isIdentifier(e)) return RECEIVERS.has(e.text);
  if (isCastLike(e)) return true;
  if (ts.isPropertyAccessExpression(e)) {
    const last = e.name.text;
    return last === "data" || last === "response" || last === "error" || isErrorish(e.expression);
  }
  return false;
}

/** The expression a destructuring pattern reads from (the declaration initializer, or the right side of `=`). */
function sourceOfPattern(n: ts.Node): ts.Expression | null {
  let cur: ts.Node | undefined = n;
  while (cur) {
    if (ts.isVariableDeclaration(cur)) return cur.initializer ?? null;
    if (ts.isBinaryExpression(cur) && cur.operatorToken.kind === ts.SyntaxKind.EqualsToken)
      return cur.right;
    if (ts.isParameter(cur)) return null;
    cur = cur.parent;
  }
  return null;
}

/** Every raw message read in `src`, in source order. `kind` picks the parser mode (`.ts` vs `.tsx`). */
export function rawMessageReads(src: string, kind: "ts" | "tsx" = "tsx"): string[] {
  const sf = ts.createSourceFile(
    kind === "tsx" ? "x.tsx" : "x.ts",
    src,
    ts.ScriptTarget.Latest,
    true,
    kind === "tsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const hits: Array<{ at: number; text: string }> = [];
  const hit = (n: ts.Node) =>
    hits.push({ at: n.getStart(sf), text: n.getText(sf).replace(/\s+/g, " ") });
  const visit = (n: ts.Node): void => {
    if (ts.isPropertyAccessExpression(n)) {
      const name = n.name.text;
      if (name === "message" && isErrorish(n.expression)) hit(n);
      else if (
        (name === "error" || name === "detail") &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === "data"
      )
        hit(n);
    } else if (ts.isElementAccessExpression(n)) {
      const arg = n.argumentExpression;
      if (ts.isStringLiteralLike(arg) && arg.text === "message") hit(n);
    } else if (ts.isBindingElement(n) && ts.isObjectBindingPattern(n.parent)) {
      const key = n.propertyName ?? n.name;
      if ((ts.isIdentifier(key) || ts.isStringLiteral(key)) && key.text === "message") {
        const from = sourceOfPattern(n.parent);
        if (from && isErrorish(from)) hit(n);
      }
    } else if (
      (ts.isShorthandPropertyAssignment(n) || ts.isPropertyAssignment(n)) &&
      n.name.getText(sf) === "message" &&
      ts.isObjectLiteralExpression(n.parent)
    ) {
      // destructuring ASSIGNMENT: `({ message } = body)`
      const bin = n.parent.parent;
      if (
        bin &&
        ts.isBinaryExpression(bin) &&
        bin.left === n.parent &&
        bin.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        isErrorish(bin.right)
      )
        hit(n);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return hits.sort((a, b) => a.at - b.at).map((h) => h.text);
}

const SKIP_DIRS = new Set(["node_modules", ".next", "e2e", "coverage", ".turbo", "dist"]);

/** Non-test .ts/.tsx source files under `dir`, skipping build output and this scanner itself. */
export function walkSources(dir: string, out: string[] = []): string[] {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      if (!SKIP_DIRS.has(ent.name)) walkSources(path.join(dir, ent.name), out);
    } else if (
      /\.(ts|tsx)$/.test(ent.name) &&
      !/\.(test|spec)\.(ts|tsx)$/.test(ent.name) &&
      ent.name !== "raw-message-scan.ts"
    ) {
      out.push(path.join(dir, ent.name));
    }
  }
  return out;
}

/** The WALKER: raw read count per file (posix path relative to `root`), for every file with at least one. */
export function scanTree(root: string): Record<string, number> {
  const found: Record<string, number> = {};
  for (const f of walkSources(root)) {
    const n = rawMessageReads(fs.readFileSync(f, "utf8"), f.endsWith(".tsx") ? "tsx" : "ts").length;
    if (n > 0) found[path.relative(root, f).split(path.sep).join("/")] = n;
  }
  return found;
}
