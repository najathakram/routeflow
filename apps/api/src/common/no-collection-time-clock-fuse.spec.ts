import { readFileSync, readdirSync } from "fs";
import { join, relative, sep } from "path";
import * as ts from "typescript";

/**
 * B793 (guards B791) — no spec may build a short-lived `Date.now() + N` value at COLLECTION time (a describe body
 * or module top level). Such a value starts its clock when Jest collects the file, not when a
 * test runs; on a slow run (an 8 GB host, CI under load) the test executes after its own fixture
 * expired. auth.service.spec.ts's 60 s refresh token did exactly that. Build it in beforeEach or
 * the test body instead. Windows of a day or more are safe; any other window, or one that is not a
 * compile-time constant, must be fixed or listed below — a list that may only SHRINK.
 */
const ONE_DAY_MS = 86_400_000;
const SRC = join(__dirname, "..");
/** file -> reason. Every entry must still hold a flagged fuse (a stale entry fails). */
const ALLOWED: Record<string, string> = {
  "email/mailbox/mailbox-connection.service.spec.ts":
    "+1 h OAuth expiry at module top level; not a 60 s fuse (listed in B791)",
};

/** Constant-fold number literals joined by + - * /; null when not a compile-time constant. */
function fold(e: ts.Expression): number | null {
  if (ts.isParenthesizedExpression(e)) return fold(e.expression);
  if (ts.isNumericLiteral(e)) return Number(e.text.replace(/_/g, ""));
  if (!ts.isBinaryExpression(e)) return null;
  const [l, r] = [fold(e.left), fold(e.right)];
  if (l == null || r == null) return null;
  switch (e.operatorToken.kind) {
    case ts.SyntaxKind.AsteriskToken:
      return l * r;
    case ts.SyntaxKind.PlusToken:
      return l + r;
    case ts.SyntaxKind.MinusToken:
      return l - r;
    case ts.SyntaxKind.SlashToken:
      return l / r;
    default:
      return null;
  }
}

const isFn = (n: ts.Node) =>
  ts.isArrowFunction(n) ||
  ts.isFunctionExpression(n) ||
  ts.isFunctionDeclaration(n) ||
  ts.isMethodDeclaration(n);

/** True when `n` runs at collection time: no enclosing function, or the nearest is describe's callback. */
function atCollection(n: ts.Node): boolean {
  let p = n.parent;
  while (p && !isFn(p)) p = p.parent;
  if (!p) return true;
  if (!p.parent || !ts.isCallExpression(p.parent)) return false;
  let callee: ts.Expression = p.parent.expression;
  while (ts.isCallExpression(callee)) callee = callee.expression; // describe.each(..)(..)
  if (ts.isPropertyAccessExpression(callee)) callee = callee.expression; // describe.skip
  return ts.isIdentifier(callee) && callee.text === "describe";
}

/** Every collection-time `Date.now() + N` with N under a day (or not constant) in one file. */
export function collectionTimeFuses(code: string): string[] {
  const src = ts.createSourceFile("x.ts", code, ts.ScriptTarget.Latest, true);
  const hits: string[] = [];
  const visit = (n: ts.Node) => {
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.PlusToken &&
      n.left.getText(src).replace(/\s/g, "") === "Date.now()" &&
      atCollection(n)
    ) {
      const ms = fold(n.right);
      if (ms == null || ms < ONE_DAY_MS) hits.push(n.getText(src));
    }
    ts.forEachChild(n, visit);
  };
  visit(src);
  return hits;
}

const walk = (d: string): string[] =>
  readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith(".spec.ts") ? [join(d, e.name)] : [],
  );
const specs = walk(SRC).map((f) => relative(SRC, f).split(sep).join("/"));
const fusesIn = (rel: string) => collectionTimeFuses(readFileSync(join(SRC, rel), "utf8"));

describe("B793 — no collection-time clock fuses in api specs (REG-B791)", () => {
  it("sees a fuse, ignores a per-call one, and folds constants (never passes vacuously)", () => {
    expect(
      collectionTimeFuses('describe("x", () => { const a = Date.now() + 60_000; });'),
    ).toHaveLength(1);
    expect(collectionTimeFuses("const a = Date.now() + 60_000;")).toHaveLength(1);
    expect(collectionTimeFuses('it("x", () => { const a = Date.now() + 60_000; });')).toHaveLength(
      0,
    );
    expect(
      collectionTimeFuses('describe("x", () => { const a = Date.now() + 365 * 864e5; });'),
    ).toHaveLength(0);
    expect(
      collectionTimeFuses('describe("x", () => { const a = Date.now() + WINDOW; });'),
    ).toHaveLength(1);
  });

  it("no spec outside the allow-list builds a short-lived Date.now() fixture at collection time", () => {
    expect(specs.filter((rel) => !(rel in ALLOWED) && fusesIn(rel).length > 0)).toEqual([]);
  });

  it("every allow-list entry still holds a flagged fuse (the list may only shrink)", () => {
    expect(
      Object.keys(ALLOWED).filter((rel) => !specs.includes(rel) || fusesIn(rel).length === 0),
    ).toEqual([]);
  });
});
