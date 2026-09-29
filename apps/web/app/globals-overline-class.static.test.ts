import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

/**
 * #2497 — the Ledger uppercase section label used to be a custom `.overline` class. Tailwind
 * also generates an `overline` utility (`text-decoration-line: overline`), and a class token
 * matches BOTH rules, so every such label drew a stray line above its text. The label class is
 * now `.eyebrow-label`. This pins that no web source hands the bare `overline` token to a
 * className again (string literals only, via the TS AST, so comments don't count), and that
 * globals.css defines the renamed rule and not the colliding one.
 */

const WEB_ROOT = path.join(__dirname, "..");
const SCAN_DIRS = ["app", "components", "lib"].map((d) => path.join(WEB_ROOT, d));
const OVERLINE_TOKEN = /(^|\s)overline(\s|$)/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      out.push(...sourceFiles(full));
    } else if (/\.(tsx|ts)$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function overlineTokensIn(file: string): string[] {
  const sf = ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const hits: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isStringLiteralLike(n) && OVERLINE_TOKEN.test(n.text)) {
      const { line } = sf.getLineAndCharacterOfPosition(n.getStart());
      hits.push(`${path.relative(WEB_ROOT, file)}:${line + 1}`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return hits;
}

describe("#2497: the section-label class never collides with Tailwind's overline utility", () => {
  it("no web source passes the bare `overline` class token", () => {
    const files = SCAN_DIRS.flatMap(sourceFiles);
    expect(files.length).toBeGreaterThan(100); // guard against a vacuous scan
    expect(files.flatMap(overlineTokensIn)).toEqual([]);
  });

  it("globals.css defines .eyebrow-label and no custom .overline rule", () => {
    const css = fs.readFileSync(path.join(WEB_ROOT, "app", "globals.css"), "utf8");
    expect(css).toMatch(/\.eyebrow-label\s*\{/);
    expect(css).not.toMatch(/\.overline\s*[,{]/);
  });
});
